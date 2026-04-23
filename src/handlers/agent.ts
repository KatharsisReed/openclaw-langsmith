/**
 * Global overview:
 * This module translates OpenClaw's agent_end hook into tracer cleanup.
 * It closes the root run and releases in-memory state for the current turn.
 */

import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type {
  GetLangSmithTracer,
  OpenClawAgentEndEvent,
  OpenClawAgentHookContext,
  OpenClawTraceContext,
} from "../types.js";

export type AgentHookHandlerDependencies = {
  getTracer: GetLangSmithTracer;
  debug: boolean;
  logger: PluginLogger;
};

function buildTraceContext(ctx: OpenClawAgentHookContext): OpenClawTraceContext | undefined {
  if (!ctx.runId) {
    return undefined;
  }

  return {
    openclawRunId: ctx.runId,
    sessionId: ctx.sessionId,
    sessionKey: ctx.sessionKey,
    agentId: ctx.agentId,
    workspaceDir: ctx.workspaceDir,
    messageProvider: ctx.messageProvider,
    trigger: ctx.trigger,
    channelId: ctx.channelId,
  };
}

export function createAgentHookHandlers(deps: AgentHookHandlerDependencies): {
  onAgentEnd: (event: OpenClawAgentEndEvent, ctx: OpenClawAgentHookContext) => Promise<void>;
} {
  async function onAgentEnd(
    event: OpenClawAgentEndEvent,
    ctx: OpenClawAgentHookContext,
  ): Promise<void> {
    try {
      const traceContext = buildTraceContext(ctx);
      if (!traceContext) {
        if (deps.debug) {
          deps.logger.warn("agent_end skipped because ctx.runId is missing.");
        }
        return;
      }

      if (deps.debug) {
        deps.logger.info(`agent_end received for ${traceContext.openclawRunId} (success=${String(event.success)}).`);
      }

      const tracer = await deps.getTracer();
      if (!tracer) {
        if (deps.debug) {
          deps.logger.info(`agent_end skipped because tracer is unavailable for ${traceContext.openclawRunId}.`);
        }
        return;
      }

      await tracer.finishRootRun({
        ...traceContext,
        messages: event.messages,
        success: event.success,
        error: event.error,
        durationMs: event.durationMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.warn(`agent_end trace failed: ${message}`);
    }
  }

  return {
    onAgentEnd,
  };
}
