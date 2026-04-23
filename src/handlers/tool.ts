/**
 * Global overview:
 * This module translates OpenClaw's tool hooks into tracer calls.
 * It observes tool lifecycle only and never modifies tool behavior.
 */

import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type {
  GetLangSmithTracer,
  OpenClawAfterToolCallEvent,
  OpenClawAgentHookContext,
  OpenClawBeforeToolCallEvent,
  OpenClawTraceContext,
} from "../types.js";

export type ToolHookHandlerDependencies = {
  getTracer: GetLangSmithTracer;
  debug: boolean;
  logger: PluginLogger;
};

function buildTraceContext(
  runId: string,
  ctx: OpenClawAgentHookContext,
): OpenClawTraceContext {
  return {
    openclawRunId: runId,
    sessionId: ctx.sessionId,
    sessionKey: ctx.sessionKey,
    agentId: ctx.agentId,
    workspaceDir: ctx.workspaceDir,
    messageProvider: ctx.messageProvider,
    trigger: ctx.trigger,
    channelId: ctx.channelId,
  };
}

function resolveRunId(
  eventRunId: string | undefined,
  ctxRunId: string | undefined,
): string | undefined {
  return eventRunId?.trim() || ctxRunId?.trim() || undefined;
}

export function createToolHookHandlers(deps: ToolHookHandlerDependencies): {
  onBeforeToolCall: (
    event: OpenClawBeforeToolCallEvent,
    ctx: OpenClawAgentHookContext,
  ) => Promise<void>;
  onAfterToolCall: (
    event: OpenClawAfterToolCallEvent,
    ctx: OpenClawAgentHookContext,
  ) => Promise<void>;
} {
  async function onBeforeToolCall(
    event: OpenClawBeforeToolCallEvent,
    ctx: OpenClawAgentHookContext,
  ): Promise<void> {
    try {
      const runId = resolveRunId(event.runId, ctx.runId);
      if (!runId) {
        if (deps.debug) {
          deps.logger.warn(`before_tool_call skipped because runId is missing for tool ${event.toolName}.`);
        }
        return;
      }

      if (deps.debug) {
        deps.logger.info(
          `before_tool_call received for ${runId} (${event.toolName}${event.toolCallId ? ` / ${event.toolCallId}` : ""}).`,
        );
      }

      const tracer = await deps.getTracer();
      if (!tracer) {
        if (deps.debug) {
          deps.logger.info(`before_tool_call skipped because tracer is unavailable for ${runId}.`);
        }
        return;
      }

      await tracer.startToolRun({
        ...buildTraceContext(runId, ctx),
        toolName: event.toolName,
        params: event.params,
        toolCallId: event.toolCallId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.warn(`before_tool_call trace failed: ${message}`);
    }
  }

  async function onAfterToolCall(
    event: OpenClawAfterToolCallEvent,
    ctx: OpenClawAgentHookContext,
  ): Promise<void> {
    try {
      const runId = resolveRunId(event.runId, ctx.runId);
      if (!runId) {
        if (deps.debug) {
          deps.logger.warn(`after_tool_call skipped because runId is missing for tool ${event.toolName}.`);
        }
        return;
      }

      if (deps.debug) {
        deps.logger.info(
          `after_tool_call received for ${runId} (${event.toolName}${event.toolCallId ? ` / ${event.toolCallId}` : ""}).`,
        );
      }

      const tracer = await deps.getTracer();
      if (!tracer) {
        if (deps.debug) {
          deps.logger.info(`after_tool_call skipped because tracer is unavailable for ${runId}.`);
        }
        return;
      }

      await tracer.finishToolRun({
        ...buildTraceContext(runId, ctx),
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        result: event.result,
        error: event.error,
        durationMs: event.durationMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.warn(`after_tool_call trace failed: ${message}`);
    }
  }

  return {
    onBeforeToolCall,
    onAfterToolCall,
  };
}
