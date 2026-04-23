/**
 * Global overview:
 * This module translates OpenClaw's llm hooks into tracer calls.
 * It stays intentionally thin:
 * - normalize event + ctx
 * - await the lazy tracer if available
 * - keep hook handlers fail-open
 */

import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type {
  GetLangSmithTracer,
  OpenClawAgentHookContext,
  OpenClawLlmInputEvent,
  OpenClawLlmOutputEvent,
  OpenClawTraceContext,
} from "../types.js";

/**
 * Dependencies injected into the LLM hook handler factory.
 */
export type LlmHookHandlerDependencies = {
  getTracer: GetLangSmithTracer;
  debug: boolean;
  logger: PluginLogger;
};

/**
 * Convert llm hook payloads into the shared tracing context shape.
 *
 * @param runId OpenClaw run id from the hook event.
 * @param sessionId Session id from the hook event.
 * @param ctx Hook context snapshot from OpenClaw.
 * @returns Shared trace context used by the tracer.
 */
function buildTraceContext(
  runId: string,
  sessionId: string,
  ctx: OpenClawAgentHookContext,
): OpenClawTraceContext {
  return {
    openclawRunId: runId,
    sessionId,
    sessionKey: ctx.sessionKey,
    agentId: ctx.agentId,
    workspaceDir: ctx.workspaceDir,
    messageProvider: ctx.messageProvider,
    trigger: ctx.trigger,
    channelId: ctx.channelId,
  };
}

/**
 * Create the Phase 4 llm hook handlers.
 *
 * @param deps Handler dependencies.
 * @returns LLM input/output hook callbacks.
 */
export function createLlmHookHandlers(deps: LlmHookHandlerDependencies): {
  onLlmInput: (event: OpenClawLlmInputEvent, ctx: OpenClawAgentHookContext) => Promise<void>;
  onLlmOutput: (event: OpenClawLlmOutputEvent, ctx: OpenClawAgentHookContext) => Promise<void>;
} {
  /**
   * Handle llm_input without ever throwing back into OpenClaw.
   *
   * @param event llm_input event payload.
   * @param ctx llm_input context payload.
   * @returns Nothing.
   */
  async function onLlmInput(
    event: OpenClawLlmInputEvent,
    ctx: OpenClawAgentHookContext,
  ): Promise<void> {
    try {
      if (deps.debug) {
        deps.logger.info(`llm_input received for ${event.runId} (${event.provider}/${event.model}).`);
      }
      const tracer = await deps.getTracer();
      if (!tracer) {
        if (deps.debug) {
          deps.logger.info(`llm_input skipped because tracer is unavailable for ${event.runId}.`);
        }
        return;
      }
      await tracer.startLlmRun({
        ...buildTraceContext(event.runId, event.sessionId, ctx),
        provider: event.provider,
        model: event.model,
        systemPrompt: event.systemPrompt,
        prompt: event.prompt,
        historyMessages: event.historyMessages,
        imagesCount: event.imagesCount,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.warn(`llm_input trace failed: ${message}`);
    }
  }

  /**
   * Handle llm_output without ever throwing back into OpenClaw.
   *
   * @param event llm_output event payload.
   * @param ctx llm_output context payload.
   * @returns Nothing.
   */
  async function onLlmOutput(
    event: OpenClawLlmOutputEvent,
    ctx: OpenClawAgentHookContext,
  ): Promise<void> {
    try {
      if (deps.debug) {
        deps.logger.info(`llm_output received for ${event.runId} (${event.provider}/${event.model}).`);
      }
      const tracer = await deps.getTracer();
      if (!tracer) {
        if (deps.debug) {
          deps.logger.info(`llm_output skipped because tracer is unavailable for ${event.runId}.`);
        }
        return;
      }
      await tracer.finishLlmRun({
        ...buildTraceContext(event.runId, event.sessionId, ctx),
        provider: event.provider,
        model: event.model,
        assistantTexts: event.assistantTexts,
        lastAssistant: event.lastAssistant,
        usage: event.usage,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.warn(`llm_output trace failed: ${message}`);
    }
  }

  return {
    onLlmInput,
    onLlmOutput,
  };
}
