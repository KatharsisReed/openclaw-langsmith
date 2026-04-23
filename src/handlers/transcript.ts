/**
 * Global overview:
 * This module listens to transcript-boundary hooks and feeds lightweight
 * assistant-message hints into the tracer.
 *
 * The handler stays synchronous so it never blocks OpenClaw's transcript write
 * path. It only queues message metadata in memory; the tracer converts that
 * queue into LangSmith child runs later inside the normal per-run serializer.
 */

import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type {
  LangSmithTracer,
  OpenClawBeforeMessageWriteContext,
  OpenClawBeforeMessageWriteEvent,
} from "../types.js";

export type TranscriptHookHandlerDependencies = {
  getLiveTracer: () => LangSmithTracer | undefined;
  debug: boolean;
  logger: PluginLogger;
};

/**
 * Resolve the session key from the hook event first, then the hook context.
 *
 * @param event before_message_write event payload.
 * @param ctx before_message_write context payload.
 * @returns Best-effort session key when present.
 */
function resolveSessionKey(
  event: OpenClawBeforeMessageWriteEvent,
  ctx: OpenClawBeforeMessageWriteContext,
): string | undefined {
  return event.sessionKey?.trim() || ctx.sessionKey?.trim() || undefined;
}

/**
 * Resolve the agent id from the hook event first, then the hook context.
 *
 * @param event before_message_write event payload.
 * @param ctx before_message_write context payload.
 * @returns Best-effort agent id when present.
 */
function resolveAgentId(
  event: OpenClawBeforeMessageWriteEvent,
  ctx: OpenClawBeforeMessageWriteContext,
): string | undefined {
  return event.agentId?.trim() || ctx.agentId?.trim() || undefined;
}

/**
 * Create the transcript-aware hook handlers.
 *
 * @param deps Handler dependencies.
 * @returns before_message_write callback.
 */
export function createTranscriptHookHandlers(deps: TranscriptHookHandlerDependencies): {
  onBeforeMessageWrite: (
    event: OpenClawBeforeMessageWriteEvent,
    ctx: OpenClawBeforeMessageWriteContext,
  ) => void;
} {
  /**
   * Queue transcript messages without ever blocking OpenClaw's write path.
   *
   * @param event before_message_write event payload.
   * @param ctx before_message_write context payload.
   * @returns Nothing.
   */
  function onBeforeMessageWrite(
    event: OpenClawBeforeMessageWriteEvent,
    ctx: OpenClawBeforeMessageWriteContext,
  ): void {
    try {
      const tracer = deps.getLiveTracer();
      if (!tracer) {
        return;
      }

      tracer.queueSessionMessage({
        sessionKey: resolveSessionKey(event, ctx),
        agentId: resolveAgentId(event, ctx),
        message: event.message,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.warn(`before_message_write trace failed: ${message}`);
    }
  }

  return {
    onBeforeMessageWrite,
  };
}
