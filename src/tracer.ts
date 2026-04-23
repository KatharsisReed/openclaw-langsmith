/**
 * Global overview:
 * This module owns the Phase 3 tracing state machine.
 * It does not know anything about OpenClaw hook registration directly.
 * Instead, it accepts already-normalized tracing events and manages:
 * - root run creation
 * - llm/tool child run lifecycle
 * - cross-hook state indexing
 * - end-of-turn cleanup
 */

import type { LangSmithRunTreeLike } from "./langsmith.js";
import type {
  FinishLlmRunParams,
  FinishRootRunParams,
  FinishToolRunParams,
  LangSmithTracer,
  LangSmithTracerDependencies,
  LangSmithTracerStateSnapshot,
  OpenClawTraceContext,
  QueueSessionMessageParams,
  StartLlmRunParams,
  StartToolRunParams,
} from "./types.js";

type LlmRunRecord = {
  key: string;
  openclawRunId: string;
  sequence: number;
  provider: string;
  model: string;
};

type SyntheticLlmRunRecord = {
  key: string;
  openclawRunId: string;
  parentAttemptKey: string;
  parentAttemptSequence: number;
  sequence: number;
  toolCallIds: string[];
  run: LangSmithRunTreeLike;
};

type ToolRunRecord = {
  canonicalKey: string;
  fallbackKey: string;
  openclawRunId: string;
  toolName: string;
  toolCallId?: string;
  parentAttemptKey?: string;
  parentAttemptSequence?: number;
  parentSyntheticLlmKey?: string;
  parentSyntheticLlmSequence?: number;
  run: LangSmithRunTreeLike;
};

type QueuedSessionMessage = QueueSessionMessageParams & {
  openclawRunId: string;
  queuedAt: number;
};

type AssistantMessageMaterialization = {
  outputs: Record<string, unknown>;
  toolCallIds: string[];
  hasVisibleText: boolean;
};

const TOOL_CALL_BLOCK_TYPES = new Set(["toolCall", "toolUse", "functionCall"]);
const TRANSCRIPT_ONLY_OPENCLAW_MODELS = new Set(["delivery-mirror", "gateway-injected"]);

/**
 * Remove `undefined` values from a record before sending them to LangSmith.
 *
 * @param value Record that may contain sparse values.
 * @returns Compact object with only defined fields.
 */
function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

/**
 * Remove empty entries from a small string tag list.
 *
 * @param value Candidate tags.
 * @returns Dense string array.
 */
function compactStringList(value: Array<string | undefined>): string[] {
  return value.filter((entry): entry is string => Boolean(entry));
}

/**
 * Build a stable best-effort signature for one transcript message.
 *
 * This lets us safely backfill messages from `agent_end` without double-creating
 * synthetic llm nodes when the same assistant message was already observed via
 * `before_message_write`.
 *
 * @param message Transcript message candidate.
 * @returns Stable signature when the value is a record.
 */
function buildMessageSignature(message: unknown): string | undefined {
  if (!isRecord(message)) {
    return undefined;
  }

  const responseId =
    typeof message.responseId === "string"
      ? message.responseId
      : typeof message.id === "string"
        ? message.id
        : undefined;
  if (responseId) {
    return `id:${responseId}`;
  }

  const role = typeof message.role === "string" ? message.role : "";
  const stopReason = typeof message.stopReason === "string" ? message.stopReason : "";
  const timestamp =
    typeof message.timestamp === "number" || typeof message.timestamp === "string"
      ? String(message.timestamp)
      : "";
  const content = coerceText(message.content);
  return `${role}|${stopReason}|${timestamp}|${content}`;
}

/**
 * Narrow unknown values to non-null records.
 *
 * @param value Unknown value.
 * @returns `true` when the value is a non-null object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Convert sparse unknown values into strings for trace summaries.
 *
 * @param value Unknown message fragment.
 * @returns Readable string when conversion is possible.
 */
function coerceText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  ) {
    return String(value);
  }
  if (!isRecord(value) && !Array.isArray(value)) {
    return "";
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * Keep long assistant text previews readable inside LangSmith.
 *
 * @param value Full text.
 * @param maxLength Maximum preview length.
 * @returns Trimmed text preview.
 */
function truncateText(value: string, maxLength = 400): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

/**
 * Build the metadata fields shared by every run shape in this plugin.
 *
 * We intentionally keep the metadata narrow so V1 stays aligned with the PRD.
 *
 * @param params OpenClaw execution context.
 * @returns Stable metadata payload.
 */
function buildBaseMetadata(params: OpenClawTraceContext): Record<string, unknown> {
  return compactRecord({
    openclawRunId: params.openclawRunId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    channelId: params.channelId,
    trigger: params.trigger,
  });
}

/**
 * Merge optional metadata updates into an existing run in memory.
 *
 * @param run Mutable RunTree object.
 * @param metadata New metadata fields to merge.
 * @returns Nothing.
 */
function mergeRunMetadata(run: LangSmithRunTreeLike, metadata: Record<string, unknown>): void {
  run.metadata = {
    ...(run.metadata ?? {}),
    ...compactRecord(metadata),
  };
}

/**
 * Merge optional outputs into an existing run in memory.
 *
 * @param run Mutable RunTree object.
 * @param outputs New outputs to merge.
 * @returns Nothing.
 */
function mergeRunOutputs(run: LangSmithRunTreeLike, outputs: Record<string, unknown>): void {
  run.outputs = {
    ...(run.outputs ?? {}),
    ...compactRecord(outputs),
  };
}

/**
 * Replace a run's inputs with a compact record.
 *
 * @param run Mutable RunTree object.
 * @param inputs New inputs payload.
 * @returns Nothing.
 */
function replaceRunInputs(run: LangSmithRunTreeLike, inputs: Record<string, unknown>): void {
  run.inputs = compactRecord(inputs);
}

/**
 * Replace a run's outputs with a compact record.
 *
 * @param run Mutable RunTree object.
 * @param outputs New outputs payload.
 * @returns Nothing.
 */
function replaceRunOutputs(run: LangSmithRunTreeLike, outputs: Record<string, unknown>): void {
  run.outputs = compactRecord(outputs);
}

/**
 * Build a stable synthetic-LLM run key from one OpenClaw run id plus a sequence number.
 *
 * @param openclawRunId Agent-turn run id from OpenClaw.
 * @param sequence Per-turn synthetic-LLM sequence number.
 * @returns Unique in-memory synthetic-LLM key.
 */
function buildSyntheticLlmRunKey(openclawRunId: string, sequence: number): string {
  return `${openclawRunId}:synthetic-llm:${sequence}`;
}

/**
 * Build a stable LLM run key from one OpenClaw run id plus a sequence number.
 *
 * @param openclawRunId Agent-turn run id from OpenClaw.
 * @param sequence Per-turn LLM sequence number.
 * @returns Unique in-memory LLM key.
 */
function buildLlmRunKey(openclawRunId: string, sequence: number): string {
  return `${openclawRunId}:${sequence}`;
}

/**
 * Build a stable fallback key for tool runs when no toolCallId is available.
 *
 * @param openclawRunId Agent-turn run id from OpenClaw.
 * @param toolName Tool identifier.
 * @param sequence Per-turn tool sequence number.
 * @returns Unique in-memory tool fallback key.
 */
function buildToolFallbackKey(openclawRunId: string, toolName: string, sequence: number): string {
  return `${openclawRunId}:${toolName}:${sequence}`;
}

/**
 * Build the bucket key used to track active tool calls by run and tool name.
 *
 * @param openclawRunId Agent-turn run id from OpenClaw.
 * @param toolName Tool identifier.
 * @returns Bucket key for active tool lookups.
 */
function buildActiveToolBucketKey(openclawRunId: string, toolName: string): string {
  return `${openclawRunId}:${toolName}`;
}

/**
 * Push a value into a keyed stack map.
 *
 * @param map Target stack map.
 * @param key Stack owner key.
 * @param value Value to append.
 * @returns Nothing.
 */
function pushStackValue(map: Map<string, string[]>, key: string, value: string): void {
  const current = map.get(key) ?? [];
  current.push(value);
  map.set(key, current);
}

/**
 * Pop the newest value from a keyed stack map.
 *
 * @param map Target stack map.
 * @param key Stack owner key.
 * @returns The last pushed value when present.
 */
function popStackValue(map: Map<string, string[]>, key: string): string | undefined {
  const current = map.get(key);
  if (!current || current.length === 0) {
    return undefined;
  }
  const next = current.pop();
  if (current.length === 0) {
    map.delete(key);
  } else {
    map.set(key, current);
  }
  return next;
}

/**
 * Remove a specific value from a keyed stack map.
 *
 * @param map Target stack map.
 * @param key Stack owner key.
 * @param value Value to remove.
 * @returns Nothing.
 */
function removeStackValue(map: Map<string, string[]>, key: string, value: string): void {
  const current = map.get(key);
  if (!current || current.length === 0) {
    return;
  }
  const next = current.filter((entry) => entry !== value);
  if (next.length === 0) {
    map.delete(key);
    return;
  }
  map.set(key, next);
}

/**
 * Wrap asynchronous LangSmith operations so tracing stays fail-open.
 *
 * @param logger Plugin logger.
 * @param label Human-readable action label.
 * @param fn Async work to execute.
 * @returns `true` on success, `false` when the operation failed.
 */
async function runSafely(
  deps: Pick<LangSmithTracerDependencies, "logger" | "flushBatches">,
  label: string,
  fn: () => Promise<void>,
): Promise<boolean> {
  try {
    await fn();
    if (deps.flushBatches) {
      await deps.flushBatches();
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.logger.warn(`${label}: ${message}`);
    return false;
  }
}

/**
 * Extract tool call identifiers from a persisted assistant transcript message.
 *
 * @param message Transcript message candidate.
 * @returns Best-effort tool call summaries.
 */
function extractToolCallsFromAssistantMessage(
  message: Record<string, unknown>,
): Array<{ id: string; name?: string }> {
  const content = message.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const toolCalls: Array<{ id: string; name?: string }> = [];
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    const type = typeof block.type === "string" ? block.type : undefined;
    const id = typeof block.id === "string" ? block.id : undefined;
    if (!type || !id || !TOOL_CALL_BLOCK_TYPES.has(type)) {
      continue;
    }
    toolCalls.push({
      id,
      ...(typeof block.name === "string" ? { name: block.name } : {}),
    });
  }
  return toolCalls;
}

/**
 * Extract a readable text preview from a persisted assistant transcript message.
 *
 * @param message Transcript message candidate.
 * @returns Human-readable preview when available.
 */
function extractAssistantTextPreview(message: Record<string, unknown>): string | undefined {
  const content = message.content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed ? truncateText(trimmed) : undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  const textBlocks: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    const blockText = coerceText(block.text ?? block.content ?? block.value).trim();
    if (!blockText) {
      continue;
    }
    textBlocks.push(blockText);
  }

  const joined = textBlocks.join("\n\n").trim();
  return joined ? truncateText(joined) : undefined;
}

/**
 * Turn a persisted assistant transcript message into a synthetic-LLM summary.
 *
 * @param message Transcript message candidate.
 * @returns Normalized summary when the message should become a synthetic llm run.
 */
function buildSyntheticLlmOutputs(message: unknown):
  | AssistantMessageMaterialization
  | undefined {
  if (!isRecord(message)) {
    return undefined;
  }

  const role = typeof message.role === "string" ? message.role : undefined;
  if (role !== "assistant") {
    return undefined;
  }

  const provider = typeof message.provider === "string" ? message.provider : undefined;
  const model = typeof message.model === "string" ? message.model : undefined;
  if (
    provider === "openclaw" &&
    model !== undefined &&
    TRANSCRIPT_ONLY_OPENCLAW_MODELS.has(model)
  ) {
    return undefined;
  }

  const toolCalls = extractToolCallsFromAssistantMessage(message);
  const textPreview = extractAssistantTextPreview(message);
  return {
    outputs: compactRecord({
      role,
      textPreview,
      stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
      provider,
      model,
      contentBlockCount: Array.isArray(message.content) ? message.content.length : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    }),
    toolCallIds: toolCalls.map((toolCall) => toolCall.id),
    hasVisibleText: Boolean(textPreview),
  };
}

/**
 * Resolve the last assistant message from a transcript snapshot.
 *
 * `agent_end.messages` contains the full session snapshot rather than only the
 * current turn, so backfill must be conservative and only consider the final
 * assistant entry.
 *
 * @param messages Transcript snapshot from OpenClaw.
 * @returns The latest assistant message when available.
 */
function extractLastAssistantMessage(messages: unknown[]): unknown | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (isRecord(candidate) && candidate.role === "assistant") {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Create the Phase 3 tracer state machine.
 *
 * @param deps Runtime dependencies injected from the plugin entry.
 * @returns Public tracer API used by later phases.
 */
export function createTracer(deps: LangSmithTracerDependencies): LangSmithTracer {
  const rootRuns = new Map<string, LangSmithRunTreeLike>();
  const llmAttemptRecords = new Map<string, LlmRunRecord>();
  const llmAttemptSequenceByRun = new Map<string, number>();
  const activeLlmAttemptKeyByRun = new Map<string, string>();
  const latestLlmAttemptKeyByRun = new Map<string, string>();
  const syntheticLlmRunRecords = new Map<string, SyntheticLlmRunRecord>();
  const syntheticLlmSequenceByRun = new Map<string, number>();
  const syntheticLlmKeyByToolCallId = new Map<string, string>();
  const activeRunIdsBySessionKey = new Map<string, string[]>();
  const sessionKeyByRunId = new Map<string, string>();
  const queuedSessionMessagesByRun = new Map<string, QueuedSessionMessage[]>();
  const processedAssistantMessageSignaturesByRun = new Map<string, Set<string>>();
  const toolRunRecords = new Map<string, ToolRunRecord>();
  const toolSequenceByRun = new Map<string, number>();
  const toolFallbackToCanonical = new Map<string, string>();
  const activeToolFallbackKeysByBucket = new Map<string, string[]>();
  const pendingRootFinishByRun = new Map<string, FinishRootRunParams>();
  const runOperationTails = new Map<string, Promise<void>>();

  function registerRunSessionKey(openclawRunId: string, sessionKey?: string): void {
    const trimmed = sessionKey?.trim();
    if (!trimmed) {
      return;
    }

    const current = activeRunIdsBySessionKey.get(trimmed) ?? [];
    const next = current.filter((entry) => entry !== openclawRunId);
    next.push(openclawRunId);
    activeRunIdsBySessionKey.set(trimmed, next);
    sessionKeyByRunId.set(openclawRunId, trimmed);
  }

  function unregisterRunSessionKey(openclawRunId: string): void {
    const sessionKey = sessionKeyByRunId.get(openclawRunId);
    if (!sessionKey) {
      return;
    }

    const current = activeRunIdsBySessionKey.get(sessionKey) ?? [];
    const next = current.filter((entry) => entry !== openclawRunId);
    if (next.length === 0) {
      activeRunIdsBySessionKey.delete(sessionKey);
    } else {
      activeRunIdsBySessionKey.set(sessionKey, next);
    }
    sessionKeyByRunId.delete(openclawRunId);
  }

  function resolveRunIdFromSessionKey(sessionKey?: string): string | undefined {
    const trimmed = sessionKey?.trim();
    if (!trimmed) {
      return undefined;
    }
    return activeRunIdsBySessionKey.get(trimmed)?.at(-1);
  }

  function resolveLatestLlmAttemptRecord(openclawRunId: string): LlmRunRecord | undefined {
    const activeAttemptKey = activeLlmAttemptKeyByRun.get(openclawRunId);
    if (activeAttemptKey) {
      return llmAttemptRecords.get(activeAttemptKey);
    }

    const latestAttemptKey = latestLlmAttemptKeyByRun.get(openclawRunId);
    if (!latestAttemptKey) {
      return undefined;
    }
    return llmAttemptRecords.get(latestAttemptKey);
  }

  function hasProcessedAssistantMessageSignature(
    openclawRunId: string,
    signature?: string,
  ): boolean {
    if (!signature) {
      return false;
    }
    return processedAssistantMessageSignaturesByRun.get(openclawRunId)?.has(signature) ?? false;
  }

  function markAssistantMessageSignatureProcessed(
    openclawRunId: string,
    signature?: string,
  ): void {
    if (!signature) {
      return;
    }
    const current = processedAssistantMessageSignaturesByRun.get(openclawRunId) ?? new Set<string>();
    current.add(signature);
    processedAssistantMessageSignaturesByRun.set(openclawRunId, current);
  }

  function queueAssistantMessageForRun(
    openclawRunId: string,
    sessionKey: string | undefined,
    agentId: string | undefined,
    message: unknown,
  ): void {
    const current = queuedSessionMessagesByRun.get(openclawRunId) ?? [];
    if (!isRecord(message) || message.role !== "assistant") {
      return;
    }
    const signature = buildMessageSignature(message);
    if (hasProcessedAssistantMessageSignature(openclawRunId, signature)) {
      return;
    }
    if (
      signature &&
      current.some((entry) => buildMessageSignature(entry.message) === signature)
    ) {
      return;
    }
    current.push({
      sessionKey,
      agentId,
      message,
      openclawRunId,
      queuedAt: Date.now(),
    });
    queuedSessionMessagesByRun.set(openclawRunId, current);
  }

  function queueBackfillLastAssistantMessage(
    openclawRunId: string,
    sessionKey: string | undefined,
    agentId: string | undefined,
    messages: unknown[],
  ): void {
    const lastAssistantMessage = extractLastAssistantMessage(messages);
    if (!lastAssistantMessage) {
      return;
    }
    queueAssistantMessageForRun(openclawRunId, sessionKey, agentId, lastAssistantMessage);
  }

  function buildRootInputsFromLlm(params: StartLlmRunParams): Record<string, unknown> {
    return compactRecord({
      prompt: params.prompt,
      systemPrompt: params.systemPrompt,
      historyMessages: params.historyMessages,
      imagesCount: params.imagesCount,
    });
  }

  function buildRootOutputsFromLlm(params: FinishLlmRunParams): Record<string, unknown> {
    const lastAssistantSummary = buildSyntheticLlmOutputs(params.lastAssistant);
    return compactRecord({
      assistantMessageCount: params.assistantTexts.length,
      lastAssistantText: lastAssistantSummary?.outputs.textPreview,
      lastAssistantStopReason:
        typeof lastAssistantSummary?.outputs.stopReason === "string"
          ? lastAssistantSummary.outputs.stopReason
          : undefined,
    });
  }

  function hasNoActiveLlmRuns(openclawRunId: string): boolean {
    return !activeLlmAttemptKeyByRun.has(openclawRunId);
  }

  function hasNoQueuedSessionMessages(openclawRunId: string): boolean {
    return (queuedSessionMessagesByRun.get(openclawRunId)?.length ?? 0) === 0;
  }

  function hasNoActiveToolRuns(openclawRunId: string): boolean {
    for (const bucketKey of activeToolFallbackKeysByBucket.keys()) {
      if (bucketKey.startsWith(`${openclawRunId}:`)) {
        return false;
      }
    }
    return true;
  }

  async function finalizeRootRun(params: FinishRootRunParams): Promise<void> {
    const rootRun = rootRuns.get(params.openclawRunId);
    if (!rootRun) {
      deps.logger.warn(`finishRootRun could not find root run for ${params.openclawRunId}.`);
      cleanupRunState(params.openclawRunId);
      pendingRootFinishByRun.delete(params.openclawRunId);
      return;
    }

    queueBackfillLastAssistantMessage(
      params.openclawRunId,
      params.sessionKey,
      params.agentId,
      params.messages,
    );
    await drainQueuedSessionMessages(params.openclawRunId);

    mergeRunMetadata(rootRun, {
      ...buildBaseMetadata(params),
      success: params.success,
      error: params.error,
      durationMs: params.durationMs,
      messageCount: params.messages.length,
    });
    if (params.error) {
      rootRun.error = params.error;
    }

    await runSafely(deps, "failed to end root run", async () => {
      await rootRun.end();
    });
    await runSafely(deps, "failed to patch root run", async () => {
      await rootRun.patchRun();
    });
    if (deps.config.debug) {
      deps.logger.info(`patched root run for ${params.openclawRunId}.`);
    }

    rootRuns.delete(params.openclawRunId);
    pendingRootFinishByRun.delete(params.openclawRunId);
    cleanupRunState(params.openclawRunId);
  }

  /**
   * Ensure the root run exists for the active OpenClaw turn.
   *
   * @param params OpenClaw run context.
   * @returns Existing or newly created root run.
   */
  async function ensureRootRunInternal(
    params: OpenClawTraceContext,
  ): Promise<LangSmithRunTreeLike | undefined> {
    const existing = rootRuns.get(params.openclawRunId);
    if (existing) {
      mergeRunMetadata(existing, buildBaseMetadata(params));
      return existing;
    }

    let rootRun: LangSmithRunTreeLike;
    try {
      rootRun = deps.createRunTree({
        name: "openclaw.agent_turn",
        run_type: "chain",
        project_name: deps.config.projectName,
        inputs: {},
        metadata: buildBaseMetadata(params),
        tags: ["openclaw", "agent-turn"],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.warn(`failed to create root run: ${message}`);
      return undefined;
    }

    rootRuns.set(params.openclawRunId, rootRun);
    if (deps.config.debug) {
      deps.logger.info(`created root run for ${params.openclawRunId}.`);
    }
    await runSafely(deps, "failed to post root run", async () => {
      await rootRun.postRun();
    });
    if (deps.config.debug) {
      deps.logger.info(`posted root run for ${params.openclawRunId}.`);
    }
    return rootRun;
  }

  /**
   * Serialize tracer mutations per OpenClaw turn so hook fire-and-forget behavior
   * cannot reorder parent/child relationships in memory.
   *
   * @param openclawRunId Agent-turn run id used as the serialization key.
   * @param operation Async tracer mutation to run in-order.
   * @returns Operation result once all earlier work for the same run has completed.
   */
  function enqueueRunOperation<T>(
    openclawRunId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previousTail = runOperationTails.get(openclawRunId) ?? Promise.resolve();
    const resultPromise = previousTail.catch(() => undefined).then(operation);
    const nextTail = resultPromise.then(
      () => undefined,
      () => undefined,
    );

    runOperationTails.set(openclawRunId, nextTail);
    void nextTail.finally(() => {
      if (runOperationTails.get(openclawRunId) === nextTail) {
        runOperationTails.delete(openclawRunId);
      }
    });

    return resultPromise;
  }

  /**
   * Turn queued transcript messages into root-level synthetic LLM child runs.
   *
   * These nodes are intentionally UI-first: they represent each visible
   * assistant message so LangSmith shows `llm -> tool -> llm -> tool` more
   * naturally, even though OpenClaw only gives us one coarse-grained llm
   * attempt hook for the whole loop.
   *
   * @param openclawRunId Agent-turn run id.
   * @returns Nothing.
   */
  async function drainQueuedSessionMessages(openclawRunId: string): Promise<void> {
    const queue = queuedSessionMessagesByRun.get(openclawRunId);
    if (!queue || queue.length === 0) {
      return;
    }

    queuedSessionMessagesByRun.delete(openclawRunId);
    for (const queued of queue) {
      const messageSignature = buildMessageSignature(queued.message);
      if (hasProcessedAssistantMessageSignature(openclawRunId, messageSignature)) {
        continue;
      }

      const syntheticLlmData = buildSyntheticLlmOutputs(queued.message);
      if (!syntheticLlmData) {
        continue;
      }

      const parentAttemptRecord = resolveLatestLlmAttemptRecord(openclawRunId);
      if (!parentAttemptRecord) {
        if (deps.config.debug) {
          deps.logger.info(
            `skipped assistant materialization for ${openclawRunId} because no llm attempt context was available.`,
          );
        }
        continue;
      }

      const rootRun = rootRuns.get(openclawRunId);
      if (!rootRun) {
        deps.logger.warn(`synthetic llm could not find root run for ${openclawRunId}.`);
        continue;
      }

      if (!syntheticLlmData.hasVisibleText) {
        markAssistantMessageSignatureProcessed(openclawRunId, messageSignature);
        continue;
      }

      const nextSequence = (syntheticLlmSequenceByRun.get(openclawRunId) ?? 0) + 1;
      syntheticLlmSequenceByRun.set(openclawRunId, nextSequence);
      const syntheticLlmKey = buildSyntheticLlmRunKey(openclawRunId, nextSequence);
      const provider =
        typeof syntheticLlmData.outputs.provider === "string"
          ? syntheticLlmData.outputs.provider
          : parentAttemptRecord.provider;
      const model =
        typeof syntheticLlmData.outputs.model === "string"
          ? syntheticLlmData.outputs.model
          : parentAttemptRecord.model;

      let syntheticLlmRun: LangSmithRunTreeLike;
      try {
        syntheticLlmRun = rootRun.createChild({
          name: "openclaw.llm",
          run_type: "llm",
          inputs: compactRecord({
            source: "before_message_write",
            derivedFrom: "transcript_assistant_message",
            sessionKey: queued.sessionKey,
          }),
          outputs: syntheticLlmData.outputs,
          metadata: compactRecord({
            ...buildBaseMetadata({
              openclawRunId,
              sessionKey: queued.sessionKey,
              agentId: queued.agentId,
            }),
            provider,
            model,
            llmSequence: nextSequence,
            synthetic: true,
            source: "before_message_write",
            parentAttemptSequence: parentAttemptRecord.sequence,
            toolCallIds:
              syntheticLlmData.toolCallIds.length > 0 ? syntheticLlmData.toolCallIds : undefined,
          }),
          tags: compactStringList([
            "openclaw",
            "llm",
            "synthetic-llm",
            provider ? `provider:${provider}` : undefined,
            model ? `model:${model}` : undefined,
          ]),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.logger.warn(`failed to create synthetic llm child run: ${message}`);
        continue;
      }

      const record: SyntheticLlmRunRecord = {
        key: syntheticLlmKey,
        openclawRunId,
        parentAttemptKey: parentAttemptRecord.key,
        parentAttemptSequence: parentAttemptRecord.sequence,
        sequence: nextSequence,
        toolCallIds: syntheticLlmData.toolCallIds,
        run: syntheticLlmRun,
      };
      syntheticLlmRunRecords.set(syntheticLlmKey, record);
      for (const toolCallId of syntheticLlmData.toolCallIds) {
        syntheticLlmKeyByToolCallId.set(toolCallId, syntheticLlmKey);
      }

      await runSafely(deps, "failed to post synthetic llm child run", async () => {
        await syntheticLlmRun.postRun();
      });
      await runSafely(deps, "failed to end synthetic llm child run", async () => {
        await syntheticLlmRun.end();
      });
      await runSafely(deps, "failed to patch synthetic llm child run", async () => {
        await syntheticLlmRun.patchRun();
      });
      markAssistantMessageSignatureProcessed(openclawRunId, messageSignature);
      if (deps.config.debug) {
        deps.logger.info(`materialized synthetic llm child run ${syntheticLlmKey}.`);
      }
    }
  }

  /**
   * Close an unfinished LLM run when a later llm_input arrives before the prior
   * llm_output. This should be rare, but keeping the tree consistent is more
   * important than preserving a corrupted active pointer.
   *
   * @param openclawRunId Agent-turn run id.
   * @returns Nothing.
   */
  async function closeStaleActiveLlmRun(openclawRunId: string): Promise<void> {
    const activeLlmAttemptKey = activeLlmAttemptKeyByRun.get(openclawRunId);
    if (!activeLlmAttemptKey) {
      return;
    }

    const record = llmAttemptRecords.get(activeLlmAttemptKey);
    activeLlmAttemptKeyByRun.delete(openclawRunId);
    if (!record) {
      return;
    }

    deps.logger.warn(
      `startLlmRun found unfinished llm attempt ${activeLlmAttemptKey} for ${openclawRunId}; closing it before creating the next synthetic llm group.`,
    );
    llmAttemptRecords.delete(activeLlmAttemptKey);
  }

  /**
   * Start one coarse-grained OpenClaw llm attempt.
   *
   * @param params LLM-start payload.
   * @returns Nothing.
   */
  async function startLlmRunInternal(params: StartLlmRunParams): Promise<void> {
    registerRunSessionKey(params.openclawRunId, params.sessionKey);
    const rootRun = await ensureRootRunInternal(params);
    if (!rootRun) {
      return;
    }

    await closeStaleActiveLlmRun(params.openclawRunId);

    if (!rootRun.inputs || Object.keys(rootRun.inputs).length === 0) {
      replaceRunInputs(rootRun, buildRootInputsFromLlm(params));
      await runSafely(deps, "failed to patch root run inputs", async () => {
        await rootRun.patchRun();
      });
      if (deps.config.debug) {
        deps.logger.info(`patched root inputs from first llm_input for ${params.openclawRunId}.`);
      }
    }

    const nextSequence = (llmAttemptSequenceByRun.get(params.openclawRunId) ?? 0) + 1;
    llmAttemptSequenceByRun.set(params.openclawRunId, nextSequence);
    const llmKey = buildLlmRunKey(params.openclawRunId, nextSequence);

    llmAttemptRecords.set(llmKey, {
      key: llmKey,
      openclawRunId: params.openclawRunId,
      sequence: nextSequence,
      provider: params.provider,
      model: params.model,
    });
    activeLlmAttemptKeyByRun.set(params.openclawRunId, llmKey);
    latestLlmAttemptKeyByRun.set(params.openclawRunId, llmKey);
    if (deps.config.debug) {
      deps.logger.info(
        `started llm attempt ${llmKey} for ${params.openclawRunId} (${params.provider}/${params.model}).`,
      );
    }
  }

  /**
   * Finish the latest active OpenClaw llm attempt for the current turn.
   *
   * @param params LLM-finish payload.
   * @returns Nothing.
   */
  async function finishLlmRunInternal(params: FinishLlmRunParams): Promise<void> {
    const llmKey = activeLlmAttemptKeyByRun.get(params.openclawRunId);
    if (!llmKey) {
      deps.logger.warn(
        `finishLlmRun could not find an active llm attempt for ${params.openclawRunId}.`,
      );
      return;
    }
    activeLlmAttemptKeyByRun.delete(params.openclawRunId);

    const record = llmAttemptRecords.get(llmKey);
    if (!record) {
      deps.logger.warn(`finishLlmRun lost llm attempt record ${llmKey} for ${params.openclawRunId}.`);
      return;
    }

    queueAssistantMessageForRun(
      params.openclawRunId,
      params.sessionKey,
      params.agentId,
      params.lastAssistant,
    );
    await drainQueuedSessionMessages(params.openclawRunId);

    const rootRun = rootRuns.get(params.openclawRunId);
    if (rootRun) {
      replaceRunOutputs(rootRun, buildRootOutputsFromLlm(params));
      mergeRunMetadata(rootRun, {
        provider: params.provider,
        model: params.model,
        usage: params.usage,
        llmAttemptSequence: record.sequence,
      });
      await runSafely(deps, "failed to patch root run outputs", async () => {
        await rootRun.patchRun();
      });
      if (deps.config.debug) {
        deps.logger.info(`patched root outputs from llm_output for ${params.openclawRunId}.`);
      }
    }
    const pendingRootFinish = pendingRootFinishByRun.get(params.openclawRunId);
    if (
      pendingRootFinish &&
      hasNoActiveLlmRuns(params.openclawRunId) &&
      hasNoActiveToolRuns(params.openclawRunId)
    ) {
      await finalizeRootRun(pendingRootFinish);
    }
  }

  /**
   * Start a tool child run and index it by toolCallId or fallback key.
   *
   * @param params Tool-start payload.
   * @returns Nothing.
   */
  async function startToolRunInternal(params: StartToolRunParams): Promise<void> {
    const rootRun = await ensureRootRunInternal(params);
    if (!rootRun) {
      return;
    }

    await drainQueuedSessionMessages(params.openclawRunId);

    const nextSequence = (toolSequenceByRun.get(params.openclawRunId) ?? 0) + 1;
    toolSequenceByRun.set(params.openclawRunId, nextSequence);
    const fallbackKey = buildToolFallbackKey(params.openclawRunId, params.toolName, nextSequence);
    const canonicalKey = params.toolCallId ?? fallbackKey;

    const parentAttemptRecord = resolveLatestLlmAttemptRecord(params.openclawRunId);

    let parentSyntheticLlmRecord: SyntheticLlmRunRecord | undefined;
    if (params.toolCallId) {
      const mappedStepKey = syntheticLlmKeyByToolCallId.get(params.toolCallId);
      if (mappedStepKey) {
        const candidate = syntheticLlmRunRecords.get(mappedStepKey);
        if (candidate && candidate.openclawRunId === params.openclawRunId) {
          parentSyntheticLlmRecord = candidate;
        }
      }
    }

    let toolRun: LangSmithRunTreeLike;
    try {
      toolRun = rootRun.createChild({
        name: `openclaw.tool.${params.toolName}`,
        run_type: "tool",
        inputs: {
          toolName: params.toolName,
          params: params.params,
        },
        metadata: {
          ...buildBaseMetadata(params),
          toolCallId: params.toolCallId,
          parentAttemptSequence: parentAttemptRecord?.sequence,
          parentSyntheticLlmSequence: parentSyntheticLlmRecord?.sequence,
        },
        tags: ["openclaw", "tool", `tool:${params.toolName}`],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.warn(`failed to create tool child run: ${message}`);
      return;
    }

    const record: ToolRunRecord = {
      canonicalKey,
      fallbackKey,
      openclawRunId: params.openclawRunId,
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      parentAttemptKey: parentAttemptRecord?.key,
      parentAttemptSequence: parentAttemptRecord?.sequence,
      parentSyntheticLlmKey: parentSyntheticLlmRecord?.key,
      parentSyntheticLlmSequence: parentSyntheticLlmRecord?.sequence,
      run: toolRun,
    };

    toolRunRecords.set(canonicalKey, record);
    toolFallbackToCanonical.set(fallbackKey, canonicalKey);
    pushStackValue(
      activeToolFallbackKeysByBucket,
      buildActiveToolBucketKey(params.openclawRunId, params.toolName),
      fallbackKey,
    );
    if (deps.config.debug) {
      deps.logger.info(
        `created tool child run ${canonicalKey} for ${params.openclawRunId} (${params.toolName}${parentSyntheticLlmRecord ? `, related_llm=${parentSyntheticLlmRecord.key}` : ", root_sibling"}).`,
      );
    }

    await runSafely(deps, "failed to post tool child run", async () => {
      await toolRun.postRun();
    });
    if (deps.config.debug) {
      deps.logger.info(`posted tool child run ${canonicalKey}.`);
    }
  }

  /**
   * Resolve a tool run record from toolCallId first, otherwise from fallback.
   *
   * @param params Tool-finish payload.
   * @returns Matching record when present.
   */
  function resolveToolRunRecord(params: FinishToolRunParams): ToolRunRecord | undefined {
    if (params.toolCallId) {
      return toolRunRecords.get(params.toolCallId);
    }

    const fallbackKey = popStackValue(
      activeToolFallbackKeysByBucket,
      buildActiveToolBucketKey(params.openclawRunId, params.toolName),
    );
    if (!fallbackKey) {
      return undefined;
    }

    const canonicalKey = toolFallbackToCanonical.get(fallbackKey) ?? fallbackKey;
    return toolRunRecords.get(canonicalKey);
  }

  /**
   * Remove a finished tool run from every index that can still reference it.
   *
   * @param record Tool run record that has completed.
   * @returns Nothing.
   */
  function cleanupFinishedToolRun(record: ToolRunRecord): void {
    toolRunRecords.delete(record.canonicalKey);
    toolFallbackToCanonical.delete(record.fallbackKey);
    removeStackValue(
      activeToolFallbackKeysByBucket,
      buildActiveToolBucketKey(record.openclawRunId, record.toolName),
      record.fallbackKey,
    );
  }

  /**
   * Finish a tool child run and clear every related in-memory index.
   *
   * @param params Tool-finish payload.
   * @returns Nothing.
   */
  async function finishToolRunInternal(params: FinishToolRunParams): Promise<void> {
    const record = resolveToolRunRecord(params);
    if (!record) {
      deps.logger.warn(
        `finishToolRun could not find a tool run for ${params.openclawRunId}:${params.toolName}.`,
      );
      return;
    }

    mergeRunOutputs(record.run, {
      result: params.result,
    });
    mergeRunMetadata(record.run, {
      toolCallId: record.toolCallId,
      parentAttemptSequence: record.parentAttemptSequence,
      parentSyntheticLlmSequence: record.parentSyntheticLlmSequence,
      durationMs: params.durationMs,
    });
    if (params.error) {
      record.run.error = params.error;
    }

    await runSafely(deps, "failed to end tool child run", async () => {
      await record.run.end();
    });
    await runSafely(deps, "failed to patch tool child run", async () => {
      await record.run.patchRun();
    });
    if (deps.config.debug) {
      deps.logger.info(`patched tool child run ${record.canonicalKey}.`);
    }

    cleanupFinishedToolRun(record);

    const pendingRootFinish = pendingRootFinishByRun.get(params.openclawRunId);
    if (
      pendingRootFinish &&
      hasNoActiveLlmRuns(params.openclawRunId) &&
      hasNoActiveToolRuns(params.openclawRunId)
    ) {
      await finalizeRootRun(pendingRootFinish);
    }
  }

  /**
   * Remove all per-turn in-memory state once the root run has finished.
   *
   * @param openclawRunId Agent-turn run id to clean up.
   * @returns Nothing.
   */
  function cleanupRunState(openclawRunId: string): void {
    llmAttemptSequenceByRun.delete(openclawRunId);
    activeLlmAttemptKeyByRun.delete(openclawRunId);
    latestLlmAttemptKeyByRun.delete(openclawRunId);
    syntheticLlmSequenceByRun.delete(openclawRunId);
    queuedSessionMessagesByRun.delete(openclawRunId);
    processedAssistantMessageSignaturesByRun.delete(openclawRunId);
    unregisterRunSessionKey(openclawRunId);

    for (const [key, record] of llmAttemptRecords.entries()) {
      if (record.openclawRunId === openclawRunId) {
        llmAttemptRecords.delete(key);
      }
    }

    for (const [key, record] of syntheticLlmRunRecords.entries()) {
      if (record.openclawRunId === openclawRunId) {
        syntheticLlmRunRecords.delete(key);
        for (const toolCallId of record.toolCallIds) {
          if (syntheticLlmKeyByToolCallId.get(toolCallId) === key) {
            syntheticLlmKeyByToolCallId.delete(toolCallId);
          }
        }
      }
    }

    toolSequenceByRun.delete(openclawRunId);
    pendingRootFinishByRun.delete(openclawRunId);
    for (const bucketKey of Array.from(activeToolFallbackKeysByBucket.keys())) {
      if (bucketKey.startsWith(`${openclawRunId}:`)) {
        activeToolFallbackKeysByBucket.delete(bucketKey);
      }
    }

    for (const [fallbackKey, canonicalKey] of toolFallbackToCanonical.entries()) {
      if (fallbackKey.startsWith(`${openclawRunId}:`)) {
        toolFallbackToCanonical.delete(fallbackKey);
        toolRunRecords.delete(canonicalKey);
      }
    }
  }

  /**
   * Finish the root run for the current agent turn and clear all state.
   *
   * @param params Root-finish payload.
   * @returns Nothing.
   */
  async function finishRootRun(params: FinishRootRunParams): Promise<void> {
    pendingRootFinishByRun.set(params.openclawRunId, params);
    queueBackfillLastAssistantMessage(
      params.openclawRunId,
      params.sessionKey,
      params.agentId,
      params.messages,
    );
    await drainQueuedSessionMessages(params.openclawRunId);
    if (
      hasNoActiveLlmRuns(params.openclawRunId) &&
      hasNoActiveToolRuns(params.openclawRunId) &&
      hasNoQueuedSessionMessages(params.openclawRunId)
    ) {
      await finalizeRootRun(params);
      return;
    }
    if (deps.config.debug) {
      deps.logger.info(
        `deferred root finalization for ${params.openclawRunId} until active children complete.`,
      );
    }
  }

  /**
   * Return a minimal state snapshot for later tests and debugging.
   *
   * @returns Current in-memory tracer state.
   */
  function getStateSnapshot(): LangSmithTracerStateSnapshot {
    return {
      rootRunCount: rootRuns.size,
      llmAttemptCount: llmAttemptRecords.size,
      llmAttemptSequenceOwners: Array.from(llmAttemptSequenceByRun.keys()).sort(),
      activeLlmAttemptOwners: Array.from(activeLlmAttemptKeyByRun.entries())
        .map(([openclawRunId]) => ({
          openclawRunId,
          activeCount: 1,
        }))
        .sort((left, right) => left.openclawRunId.localeCompare(right.openclawRunId)),
      syntheticLlmRunCount: syntheticLlmRunRecords.size,
      activeSyntheticLlmOwners: [],
      queuedSessionMessageOwners: Array.from(queuedSessionMessagesByRun.entries())
        .map(([openclawRunId, messages]) => ({
          openclawRunId,
          queuedCount: messages.length,
        }))
        .sort((left, right) => left.openclawRunId.localeCompare(right.openclawRunId)),
      toolRunCount: toolRunRecords.size,
      toolSequenceOwners: Array.from(toolSequenceByRun.keys()).sort(),
      activeToolBuckets: Array.from(activeToolFallbackKeysByBucket.entries())
        .map(([key, activeKeys]) => ({
          key,
          activeCount: activeKeys.length,
        }))
        .sort((left, right) => left.key.localeCompare(right.key)),
    };
  }

  return {
    ensureRootRun: (params) => enqueueRunOperation(params.openclawRunId, () => ensureRootRunInternal(params)),
    startLlmRun: (params) => enqueueRunOperation(params.openclawRunId, () => startLlmRunInternal(params)),
    finishLlmRun: (params) => enqueueRunOperation(params.openclawRunId, () => finishLlmRunInternal(params)),
    queueSessionMessage(params: QueueSessionMessageParams): void {
      const openclawRunId = resolveRunIdFromSessionKey(params.sessionKey);
      if (!openclawRunId) {
        return;
      }
      const signature = buildMessageSignature(params.message);
      if (hasProcessedAssistantMessageSignature(openclawRunId, signature)) {
        return;
      }
      const current = queuedSessionMessagesByRun.get(openclawRunId) ?? [];
      if (
        signature &&
        current.some((entry) => buildMessageSignature(entry.message) === signature)
      ) {
        return;
      }
      current.push({
        ...params,
        openclawRunId,
        queuedAt: Date.now(),
      });
      queuedSessionMessagesByRun.set(openclawRunId, current);
    },
    startToolRun: (params) => enqueueRunOperation(params.openclawRunId, () => startToolRunInternal(params)),
    finishToolRun: (params) => enqueueRunOperation(params.openclawRunId, () => finishToolRunInternal(params)),
    finishRootRun: (params) => enqueueRunOperation(params.openclawRunId, () => finishRootRun(params)),
    getStateSnapshot,
  };
}
