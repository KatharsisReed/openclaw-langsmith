/**
 * Global overview:
 * This module defines the internal TypeScript contracts used by the tracer.
 * It is intentionally narrower than the full OpenClaw runtime API so later
 * phases can map `(event, ctx)` into a small, testable tracing surface.
 */

import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type { ResolvedLangSmithPluginConfig } from "./config.js";
import type { LangSmithRunTreeLike } from "./langsmith.js";

/**
 * Shared context carried across root, llm, tool, and agent-end operations.
 */
export type OpenClawTraceContext = {
  openclawRunId: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  workspaceDir?: string;
  messageProvider?: string;
  trigger?: string;
  channelId?: string;
};

/**
 * Minimal agent hook context used by the V1 tracing hooks.
 */
export type OpenClawAgentHookContext = {
  runId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
  trigger?: string;
  channelId?: string;
};

/**
 * Minimal llm_input event shape required by V1.
 */
export type OpenClawLlmInputEvent = {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  historyMessages: unknown[];
  imagesCount: number;
};

/**
 * Minimal llm_output event shape required by V1.
 */
export type OpenClawLlmOutputEvent = {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  assistantTexts: string[];
  lastAssistant?: unknown;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

/**
 * Minimal agent_end event shape required by V1.
 */
export type OpenClawAgentEndEvent = {
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs?: number;
};

/**
 * Minimal before_message_write hook payload required for transcript-aware tracing.
 */
export type OpenClawBeforeMessageWriteEvent = {
  message: unknown;
  sessionKey?: string;
  agentId?: string;
};

/**
 * Minimal before_message_write hook context shape.
 */
export type OpenClawBeforeMessageWriteContext = {
  sessionKey?: string;
  agentId?: string;
};

/**
 * Minimal before_tool_call event shape required by V1.
 */
export type OpenClawBeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
};

/**
 * Minimal after_tool_call event shape required by V1.
 */
export type OpenClawAfterToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
};

/**
 * Parameters required to start an LLM child run.
 */
export type StartLlmRunParams = OpenClawTraceContext & {
  provider: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  historyMessages: unknown[];
  imagesCount: number;
};

/**
 * Parameters required to finish an LLM child run.
 */
export type FinishLlmRunParams = OpenClawTraceContext & {
  provider: string;
  model: string;
  assistantTexts: string[];
  lastAssistant?: unknown;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

/**
 * Parameters required to start a tool child run.
 */
export type StartToolRunParams = OpenClawTraceContext & {
  toolName: string;
  params: Record<string, unknown>;
  toolCallId?: string;
};

/**
 * Parameters required to finish a tool child run.
 */
export type FinishToolRunParams = OpenClawTraceContext & {
  toolName: string;
  toolCallId?: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
};

/**
 * Parameters required to finish the root run for one agent turn.
 */
export type FinishRootRunParams = OpenClawTraceContext & {
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs?: number;
};

/**
 * Parameters required to queue a transcript message for later step reconstruction.
 */
export type QueueSessionMessageParams = {
  sessionKey?: string;
  agentId?: string;
  message: unknown;
};

/**
 * Dependencies injected into the tracer by the plugin entry file.
 */
export type LangSmithTracerDependencies = {
  config: Pick<ResolvedLangSmithPluginConfig, "projectName" | "debug">;
  logger: PluginLogger;
  createRunTree: (params: Record<string, unknown>) => LangSmithRunTreeLike;
  flushBatches?: () => Promise<void>;
};

/**
 * Lightweight internal state snapshot used for debugging and later tests.
 */
export type LangSmithTracerStateSnapshot = {
  rootRunCount: number;
  llmAttemptCount: number;
  llmAttemptSequenceOwners: string[];
  activeLlmAttemptOwners: Array<{ openclawRunId: string; activeCount: number }>;
  syntheticLlmRunCount: number;
  activeSyntheticLlmOwners: Array<{ openclawRunId: string; activeCount: number }>;
  queuedSessionMessageOwners: Array<{ openclawRunId: string; queuedCount: number }>;
  toolRunCount: number;
  toolSequenceOwners: string[];
  activeToolBuckets: Array<{ key: string; activeCount: number }>;
};

/**
 * Public tracer interface used by later hook handlers.
 */
export type LangSmithTracer = {
  ensureRootRun: (params: OpenClawTraceContext) => Promise<LangSmithRunTreeLike | undefined>;
  startLlmRun: (params: StartLlmRunParams) => Promise<void>;
  finishLlmRun: (params: FinishLlmRunParams) => Promise<void>;
  queueSessionMessage: (params: QueueSessionMessageParams) => void;
  startToolRun: (params: StartToolRunParams) => Promise<void>;
  finishToolRun: (params: FinishToolRunParams) => Promise<void>;
  finishRootRun: (params: FinishRootRunParams) => Promise<void>;
  getStateSnapshot: () => LangSmithTracerStateSnapshot;
};

/**
 * Lazy tracer getter used by hook handlers so registration can happen before
 * LangSmith runtime initialization finishes.
 */
export type GetLangSmithTracer = () => Promise<LangSmithTracer | undefined>;
