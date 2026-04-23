/**
 * Global overview:
 * This is the public plugin entry loaded by OpenClaw.
 * In Phase 5/6 the entry now:
 * - exposes the real config schema
 * - initializes the LangSmith runtime boundary in a fail-open way
 * - registers the minimal root + LLM + tool tracing loop
 */

import {
  definePluginEntry,
  type OpenClawPluginApi,
  type PluginLogger,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  langSmithPluginConfigSchema,
  parseLangSmithPluginConfig,
  type LangSmithPluginConfigParseResult,
} from "./config.js";
import {
  createLangSmithRuntime,
  describeLangSmithRuntimeResult,
  type LangSmithRuntimeResult,
} from "./langsmith.js";
import { createLlmHookHandlers } from "./handlers/llm.js";
import { createAgentHookHandlers } from "./handlers/agent.js";
import { createTranscriptHookHandlers } from "./handlers/transcript.js";
import { createToolHookHandlers } from "./handlers/tool.js";
import { createTracer } from "./tracer.js";
import type { LangSmithTracer } from "./types.js";

const PLUGIN_ID = "openclaw-langsmith";
const PLUGIN_NAME = "OpenClaw LangSmith Tracing Plugin";
const PLUGIN_DESCRIPTION = "LangSmith tracing plugin for OpenClaw agent execution.";

/**
 * Add a consistent plugin prefix to log lines.
 *
 * @param logger OpenClaw-provided plugin logger.
 * @returns Logger wrapper with consistent message prefixes.
 */
function createPrefixedLogger(logger: PluginLogger): PluginLogger {
  return {
    debug(message: string): void {
      logger.debug?.(`[${PLUGIN_ID}] ${message}`);
    },
    info(message: string): void {
      logger.info(`[${PLUGIN_ID}] ${message}`);
    },
    warn(message: string): void {
      logger.warn(`[${PLUGIN_ID}] ${message}`);
    },
    error(message: string): void {
      logger.error(`[${PLUGIN_ID}] ${message}`);
    },
  };
}

/**
 * Log config parse issues without blocking plugin startup.
 *
 * @param logger Plugin-scoped logger.
 * @param parsed Parsed config result.
 * @returns Nothing.
 */
function logConfigIssues(logger: PluginLogger, parsed: LangSmithPluginConfigParseResult): void {
  if (parsed.issues.length === 0) {
    return;
  }
  logger.warn(`Plugin config had validation issues. Falling back to defaults: ${parsed.issues.join("; ")}`);
}

/**
 * Decide how noisy startup logging should be for the current runtime result.
 *
 * @param logger Plugin-scoped logger.
 * @param parsed Parsed config result.
 * @param result LangSmith runtime initialization outcome.
 * @returns Nothing.
 */
function logLangSmithRuntimeResult(
  logger: PluginLogger,
  parsed: LangSmithPluginConfigParseResult,
  result: LangSmithRuntimeResult,
): void {
  const summary = describeLangSmithRuntimeResult(result);

  if (result.status === "ready") {
    if (parsed.config.debug) {
      logger.info(summary);
    }
    return;
  }

  if (result.reason === "plugin_disabled") {
    logger.debug?.(summary);
    return;
  }

  if (result.reason === "missing_api_key") {
    if (parsed.config.debug) {
      logger.info(summary);
      return;
    }
    logger.debug?.(summary);
    return;
  }

  logger.warn(summary);
}

/**
 * Build the lazy tracer promise used by tracing hook handlers.
 *
 * @param api OpenClaw plugin API surface.
 * @param logger Plugin-scoped logger.
 * @param parsed Parsed plugin config.
 * @returns Promise resolving to a ready tracer or `undefined`.
 */
function createTracerPromise(
  logger: PluginLogger,
  parsed: LangSmithPluginConfigParseResult,
): Promise<LangSmithTracer | undefined> {
  return createLangSmithRuntime(parsed.config)
    .then((result) => {
      let tracer: LangSmithTracer | undefined;
      if (result.status === "ready") {
        tracer = createTracer({
          config: parsed.config,
          logger,
          createRunTree: result.createRunTree,
          flushBatches: result.client.awaitPendingTraceBatches?.bind(result.client),
        });
      }
      logLangSmithRuntimeResult(logger, parsed, result);
      return tracer;
    })
    .catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : "Unknown LangSmith initialization error";
      logger.warn(`LangSmith runtime initialization failed: ${message}`);
      return undefined;
    });
}

/**
 * Register the plugin with OpenClaw.
 *
 * Phase 5/6 registers the minimal root + LLM + tool tracing loop while keeping the startup
 * path fail-open.
 *
 * @param api OpenClaw plugin API surface provided by the host runtime.
 * @returns Nothing.
 */
function registerPlugin(api: OpenClawPluginApi): void {
  const logger = createPrefixedLogger(api.logger);
  const parsed = parseLangSmithPluginConfig(api.pluginConfig);
  logConfigIssues(logger, parsed);

  let liveTracer: LangSmithTracer | undefined;
  const tracerPromise = createTracerPromise(logger, parsed).then((tracer) => {
    liveTracer = tracer;
    return tracer;
  });
  const llmHandlers = createLlmHookHandlers({
    debug: parsed.config.debug,
    logger,
    getTracer: () => tracerPromise,
  });
  const agentHandlers = createAgentHookHandlers({
    debug: parsed.config.debug,
    logger,
    getTracer: () => tracerPromise,
  });
  const toolHandlers = createToolHookHandlers({
    debug: parsed.config.debug,
    logger,
    getTracer: () => tracerPromise,
  });
  const transcriptHandlers = createTranscriptHookHandlers({
    debug: parsed.config.debug,
    logger,
    getLiveTracer: () => liveTracer,
  });

  api.on("llm_input", llmHandlers.onLlmInput);
  api.on("llm_output", llmHandlers.onLlmOutput);
  api.on("before_tool_call", toolHandlers.onBeforeToolCall);
  api.on("after_tool_call", toolHandlers.onAfterToolCall);
  api.on("before_message_write", transcriptHandlers.onBeforeMessageWrite);
  api.on("agent_end", agentHandlers.onAgentEnd);
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description: PLUGIN_DESCRIPTION,
  configSchema: langSmithPluginConfigSchema,
  register: registerPlugin,
});
