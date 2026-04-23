/**
 * Global overview:
 * This module isolates LangSmith SDK bootstrapping from the rest of the plugin.
 * Phase 2 only needs a clean initialization boundary with explicit outcomes:
 * - disabled because config says so
 * - disabled because required config is missing
 * - unavailable because the SDK cannot be loaded
 * - ready with a client and RunTree factory for later phases
 */

import type { ResolvedLangSmithPluginConfig } from "./config.js";

/**
 * Minimal client surface we need from the official LangSmith SDK.
 */
export type LangSmithClientLike = {
  awaitPendingTraceBatches?: () => Promise<void>;
};

/**
 * Minimal RunTree surface reserved for later tracer phases.
 */
export type LangSmithRunTreeLike = {
  name?: string;
  run_type?: string;
  project_name?: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  error?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  createChild: (params: Record<string, unknown>) => LangSmithRunTreeLike;
  postRun: () => Promise<void>;
  end: () => Promise<void>;
  patchRun: () => Promise<void>;
};

/**
 * Constructor signature for the LangSmith client class.
 */
type LangSmithClientConstructor = new (params?: Record<string, unknown>) => LangSmithClientLike;

/**
 * Constructor signature for the LangSmith RunTree class.
 */
type LangSmithRunTreeConstructor = new (params: Record<string, unknown>) => LangSmithRunTreeLike;

/**
 * Final runtime state returned by client initialization.
 */
export type LangSmithRuntimeResult =
  | {
      status: "disabled";
      reason: "plugin_disabled" | "missing_api_key";
      message: string;
      config: ResolvedLangSmithPluginConfig;
    }
  | {
      status: "unavailable";
      reason: "sdk_import_failed" | "sdk_shape_invalid";
      message: string;
      config: ResolvedLangSmithPluginConfig;
      error?: unknown;
    }
  | {
      status: "ready";
      reason: "ready";
      message: string;
      config: ResolvedLangSmithPluginConfig;
      client: LangSmithClientLike;
      createRunTree: (params: Record<string, unknown>) => LangSmithRunTreeLike;
    };

/**
 * Lightweight shape checks for dynamically imported SDK modules.
 *
 * @param value Unknown imported value.
 * @returns `true` when the value is a non-null object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Build a consistent disabled result payload.
 *
 * @param config Normalized plugin config.
 * @param reason Machine-readable disable reason.
 * @param message Human-readable explanation.
 * @returns Structured disabled result.
 */
function createDisabledResult(
  config: ResolvedLangSmithPluginConfig,
  reason: "plugin_disabled" | "missing_api_key",
  message: string,
): LangSmithRuntimeResult {
  return {
    status: "disabled",
    reason,
    message,
    config,
  };
}

/**
 * Build a consistent unavailable result payload.
 *
 * @param config Normalized plugin config.
 * @param reason Machine-readable failure reason.
 * @param message Human-readable explanation.
 * @param error Optional original error for debugging.
 * @returns Structured unavailable result.
 */
function createUnavailableResult(
  config: ResolvedLangSmithPluginConfig,
  reason: "sdk_import_failed" | "sdk_shape_invalid",
  message: string,
  error?: unknown,
): LangSmithRuntimeResult {
  return {
    status: "unavailable",
    reason,
    message,
    config,
    ...(error !== undefined ? { error } : {}),
  };
}

/**
 * Extract the official LangSmith client constructor from a dynamic import.
 *
 * The JS/TS SDK reference documents `Client` from `langsmith/client`.
 *
 * @param moduleValue Imported module namespace.
 * @returns Client constructor when present.
 */
function extractClientConstructor(
  moduleValue: unknown,
): LangSmithClientConstructor | undefined {
  if (!isRecord(moduleValue) || typeof moduleValue.Client !== "function") {
    return undefined;
  }
  return moduleValue.Client as LangSmithClientConstructor;
}

/**
 * Extract the official RunTree constructor from a dynamic import.
 *
 * The JS/TS SDK reference documents `RunTree` from `langsmith/run_trees`.
 *
 * @param moduleValue Imported module namespace.
 * @returns RunTree constructor when present.
 */
function extractRunTreeConstructor(
  moduleValue: unknown,
): LangSmithRunTreeConstructor | undefined {
  if (!isRecord(moduleValue) || typeof moduleValue.RunTree !== "function") {
    return undefined;
  }
  return moduleValue.RunTree as LangSmithRunTreeConstructor;
}

/**
 * Load the official LangSmith JS/TS SDK modules lazily.
 *
 * We keep this dynamic so Phase 2 can stay fail-open even when the package has
 * not been installed yet in a linked development checkout.
 *
 * @returns Constructors required by later tracing phases.
 */
async function loadLangSmithSdk(): Promise<{
  Client: LangSmithClientConstructor;
  RunTree: LangSmithRunTreeConstructor;
}> {
  const clientModuleName: string = "langsmith/client";
  const runTreeModuleName: string = "langsmith/run_trees";

  const [clientModule, runTreeModule] = await Promise.all([
    import(clientModuleName),
    import(runTreeModuleName),
  ]);

  const Client = extractClientConstructor(clientModule);
  const RunTree = extractRunTreeConstructor(runTreeModule);
  if (!Client || !RunTree) {
    throw new Error(
      'LangSmith SDK is installed but does not expose the expected "Client" and "RunTree" exports.',
    );
  }

  return { Client, RunTree };
}

/**
 * Create the official LangSmith client instance.
 *
 * @param config Normalized plugin config.
 * @param Client LangSmith client constructor.
 * @returns Initialized client instance.
 */
function createClientInstance(
  config: ResolvedLangSmithPluginConfig,
  Client: LangSmithClientConstructor,
): LangSmithClientLike {
  return new Client({
    apiKey: config.langsmithApiKey,
  });
}

/**
 * Build a stable RunTree factory for the future tracer module.
 *
 * @param client Active LangSmith client instance.
 * @param RunTree RunTree constructor from the SDK.
 * @returns Function that creates a RunTree bound to the active client.
 */
function createRunTreeFactory(
  client: LangSmithClientLike,
  RunTree: LangSmithRunTreeConstructor,
): (params: Record<string, unknown>) => LangSmithRunTreeLike {
  return (params: Record<string, unknown>) =>
    new RunTree({
      ...params,
      client,
    });
}

/**
 * Convert a runtime result into a concise startup log line.
 *
 * @param result Runtime initialization result.
 * @returns Human-readable summary for logs.
 */
export function describeLangSmithRuntimeResult(result: LangSmithRuntimeResult): string {
  switch (result.status) {
    case "ready":
      return `LangSmith client is ready for project "${result.config.projectName}".`;
    case "disabled":
      return result.message;
    case "unavailable":
      return result.message;
  }
}

/**
 * Initialize the LangSmith runtime boundary for later tracing phases.
 *
 * @param config Normalized plugin config.
 * @returns Structured outcome that callers can log without throwing.
 */
export async function createLangSmithRuntime(
  config: ResolvedLangSmithPluginConfig,
): Promise<LangSmithRuntimeResult> {
  if (!config.enabled) {
    return createDisabledResult(
      config,
      "plugin_disabled",
      "LangSmith tracing is disabled by plugin config.",
    );
  }

  if (!config.langsmithApiKey) {
    return createDisabledResult(
      config,
      "missing_api_key",
      "LangSmith tracing is enabled but no langsmithApiKey was provided.",
    );
  }

  try {
    const { Client, RunTree } = await loadLangSmithSdk();
    const client = createClientInstance(config, Client);
    return {
      status: "ready",
      reason: "ready",
      message: `LangSmith client initialized for project "${config.projectName}".`,
      config,
      client,
      createRunTree: createRunTreeFactory(client, RunTree),
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? `LangSmith SDK could not be loaded: ${error.message}`
        : "LangSmith SDK could not be loaded.";
    return createUnavailableResult(config, "sdk_import_failed", message, error);
  }
}
