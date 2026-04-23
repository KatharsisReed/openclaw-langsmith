/**
 * Global overview:
 * This file provides tiny test doubles shared by handler and tracer tests.
 * The goal is to keep tests readable while avoiding any real LangSmith or
 * OpenClaw runtime dependency.
 */

import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type { LangSmithRunTreeLike } from "../../src/langsmith.js";
import type {
  FinishLlmRunParams,
  FinishRootRunParams,
  FinishToolRunParams,
  LangSmithTracer,
  LangSmithTracerStateSnapshot,
  OpenClawTraceContext,
  QueueSessionMessageParams,
  StartLlmRunParams,
  StartToolRunParams,
} from "../../src/types.js";

/**
 * One captured log line from a mock logger.
 */
export type MockLogRecord = {
  level: "debug" | "info" | "warn" | "error";
  message: string;
};

/**
 * Logger double used to verify fail-open behavior in tests.
 */
export type MockLogger = PluginLogger & {
  records: MockLogRecord[];
};

/**
 * Lightweight tracer double used by hook handler tests.
 */
export type MockTracer = LangSmithTracer & {
  ensureRootRunCalls: OpenClawTraceContext[];
  startLlmRunCalls: StartLlmRunParams[];
  finishLlmRunCalls: FinishLlmRunParams[];
  queueSessionMessageCalls: QueueSessionMessageParams[];
  startToolRunCalls: StartToolRunParams[];
  finishToolRunCalls: FinishToolRunParams[];
  finishRootRunCalls: FinishRootRunParams[];
};

/**
 * RunTree double used by tracer tests.
 */
export type MockRunTree = LangSmithRunTreeLike & {
  creationParams: Record<string, unknown>;
  children: MockRunTree[];
  postRunCalls: number;
  endCalls: number;
  patchRunCalls: number;
};

/**
 * Check whether a value is a plain object so tests can copy structured payloads.
 *
 * @param value Unknown candidate value.
 * @returns `true` when the value is a non-null record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Build an empty tracer-state snapshot for handler-oriented tests.
 *
 * @returns Stable empty snapshot object.
 */
function createEmptyStateSnapshot(): LangSmithTracerStateSnapshot {
  return {
    rootRunCount: 0,
    llmAttemptCount: 0,
    llmAttemptSequenceOwners: [],
    activeLlmAttemptOwners: [],
    syntheticLlmRunCount: 0,
    activeSyntheticLlmOwners: [],
    queuedSessionMessageOwners: [],
    toolRunCount: 0,
    toolSequenceOwners: [],
    activeToolBuckets: [],
  };
}

/**
 * Append one log record to the shared in-memory logger buffer.
 *
 * @param records Shared record list.
 * @param level Log level.
 * @param message Log message.
 * @returns Nothing.
 */
function pushLogRecord(
  records: MockLogRecord[],
  level: MockLogRecord["level"],
  message: string,
): void {
  records.push({ level, message });
}

/**
 * Create a logger double that stores every emitted line in memory.
 *
 * @returns PluginLogger-compatible mock logger.
 */
export function createMockLogger(): MockLogger {
  const records: MockLogRecord[] = [];
  return {
    records,
    debug(message: string): void {
      pushLogRecord(records, "debug", message);
    },
    info(message: string): void {
      pushLogRecord(records, "info", message);
    },
    warn(message: string): void {
      pushLogRecord(records, "warn", message);
    },
    error(message: string): void {
      pushLogRecord(records, "error", message);
    },
  };
}

/**
 * Create a tracer double that only records the calls made by hook handlers.
 *
 * @returns LangSmithTracer-compatible mock tracer.
 */
export function createMockTracer(): MockTracer {
  const ensureRootRunCalls: OpenClawTraceContext[] = [];
  const startLlmRunCalls: StartLlmRunParams[] = [];
  const finishLlmRunCalls: FinishLlmRunParams[] = [];
  const queueSessionMessageCalls: QueueSessionMessageParams[] = [];
  const startToolRunCalls: StartToolRunParams[] = [];
  const finishToolRunCalls: FinishToolRunParams[] = [];
  const finishRootRunCalls: FinishRootRunParams[] = [];

  return {
    ensureRootRunCalls,
    startLlmRunCalls,
    finishLlmRunCalls,
    queueSessionMessageCalls,
    startToolRunCalls,
    finishToolRunCalls,
    finishRootRunCalls,
    async ensureRootRun(params: OpenClawTraceContext): Promise<LangSmithRunTreeLike | undefined> {
      ensureRootRunCalls.push(params);
      return undefined;
    },
    async startLlmRun(params: StartLlmRunParams): Promise<void> {
      startLlmRunCalls.push(params);
    },
    async finishLlmRun(params: FinishLlmRunParams): Promise<void> {
      finishLlmRunCalls.push(params);
    },
    queueSessionMessage(params: QueueSessionMessageParams): void {
      queueSessionMessageCalls.push(params);
    },
    async startToolRun(params: StartToolRunParams): Promise<void> {
      startToolRunCalls.push(params);
    },
    async finishToolRun(params: FinishToolRunParams): Promise<void> {
      finishToolRunCalls.push(params);
    },
    async finishRootRun(params: FinishRootRunParams): Promise<void> {
      finishRootRunCalls.push(params);
    },
    getStateSnapshot(): LangSmithTracerStateSnapshot {
      return createEmptyStateSnapshot();
    },
  };
}

/**
 * Create one in-memory RunTree node with counters for post/end/patch calls.
 *
 * @param params Initial constructor parameters.
 * @returns Mock RunTree node.
 */
function createMockRunTree(params: Record<string, unknown>): MockRunTree {
  const run: MockRunTree = {
    name: typeof params.name === "string" ? params.name : undefined,
    run_type: typeof params.run_type === "string" ? params.run_type : undefined,
    project_name: typeof params.project_name === "string" ? params.project_name : undefined,
    inputs: isRecord(params.inputs) ? { ...params.inputs } : undefined,
    outputs: isRecord(params.outputs) ? { ...params.outputs } : undefined,
    error: typeof params.error === "string" ? params.error : undefined,
    metadata: isRecord(params.metadata) ? { ...params.metadata } : undefined,
    tags: Array.isArray(params.tags)
      ? params.tags.filter((entry): entry is string => typeof entry === "string")
      : undefined,
    creationParams: { ...params },
    children: [],
    postRunCalls: 0,
    endCalls: 0,
    patchRunCalls: 0,
    createChild(childParams: Record<string, unknown>): MockRunTree {
      const child = createMockRunTree(childParams);
      run.children.push(child);
      return child;
    },
    async postRun(): Promise<void> {
      run.postRunCalls += 1;
    },
    async end(): Promise<void> {
      run.endCalls += 1;
    },
    async patchRun(): Promise<void> {
      run.patchRunCalls += 1;
    },
  };
  return run;
}

/**
 * Create a root RunTree factory and expose created roots for assertions.
 *
 * @returns Factory function plus the collected root run list.
 */
export function createMockRunTreeFactory(): {
  roots: MockRunTree[];
  createRunTree: (params: Record<string, unknown>) => MockRunTree;
} {
  const roots: MockRunTree[] = [];
  return {
    roots,
    createRunTree(params: Record<string, unknown>): MockRunTree {
      const root = createMockRunTree(params);
      roots.push(root);
      return root;
    },
  };
}
