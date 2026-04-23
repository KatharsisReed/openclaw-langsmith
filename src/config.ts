/**
 * Global overview:
 * This module owns the Phase 2 configuration contract for the LangSmith plugin.
 * It keeps three responsibilities in one place:
 * - declare the plugin config schema that OpenClaw can validate
 * - normalize raw user input into a stable runtime shape
 * - expose small helper utilities so later phases do not duplicate config logic
 */

import {
  buildPluginConfigSchema,
  type OpenClawPluginConfigSchema,
} from "openclaw/plugin-sdk/plugin-entry";
import { z } from "openclaw/plugin-sdk/zod";

/**
 * Raw plugin config shape as users write it in OpenClaw config.
 */
export type LangSmithPluginConfig = {
  enabled?: boolean;
  langsmithApiKey?: string;
  projectName?: string;
  debug?: boolean;
};

/**
 * Normalized runtime config shape used by the plugin code.
 */
export type ResolvedLangSmithPluginConfig = {
  enabled: boolean;
  langsmithApiKey?: string;
  projectName: string;
  debug: boolean;
};

/**
 * Structured parse result so the entry file can decide how noisy startup logs
 * should be.
 */
export type LangSmithPluginConfigParseResult = {
  config: ResolvedLangSmithPluginConfig;
  hasUserSuppliedConfig: boolean;
  issues: string[];
};

/**
 * Shared default values for the plugin config.
 */
export const DEFAULT_LANGSMITH_PLUGIN_CONFIG: ResolvedLangSmithPluginConfig = {
  enabled: true,
  projectName: "openclaw",
  debug: false,
};

const LangSmithPluginConfigSource = z.strictObject({
  enabled: z.boolean().default(DEFAULT_LANGSMITH_PLUGIN_CONFIG.enabled).optional(),
  langsmithApiKey: z.string().min(1).optional(),
  projectName: z.string().trim().min(1).default(DEFAULT_LANGSMITH_PLUGIN_CONFIG.projectName).optional(),
  debug: z.boolean().default(DEFAULT_LANGSMITH_PLUGIN_CONFIG.debug).optional(),
});

/**
 * Trim a string and collapse blank input into `undefined`.
 *
 * @param value Candidate string from raw plugin config.
 * @returns Trimmed string when meaningful, otherwise `undefined`.
 */
function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

/**
 * Check whether the user supplied any plugin-scoped config at all.
 *
 * This helps us avoid noisy warnings when the plugin is simply installed but
 * intentionally left unconfigured during early development.
 *
 * @param value Raw `api.pluginConfig` value from OpenClaw.
 * @returns `true` when the config object exists and contains at least one key.
 */
function hasUserSuppliedPluginConfig(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.keys(value as Record<string, unknown>).length > 0;
}

/**
 * Build the stable runtime config shape consumed by the rest of the plugin.
 *
 * @param rawConfig Parsed user config or `undefined` when nothing was supplied.
 * @returns Normalized config with defaults applied.
 */
function buildResolvedLangSmithPluginConfig(
  rawConfig: LangSmithPluginConfig | undefined,
): ResolvedLangSmithPluginConfig {
  return {
    enabled: rawConfig?.enabled ?? DEFAULT_LANGSMITH_PLUGIN_CONFIG.enabled,
    langsmithApiKey: normalizeOptionalString(rawConfig?.langsmithApiKey),
    projectName:
      normalizeOptionalString(rawConfig?.projectName) ??
      DEFAULT_LANGSMITH_PLUGIN_CONFIG.projectName,
    debug: rawConfig?.debug ?? DEFAULT_LANGSMITH_PLUGIN_CONFIG.debug,
  };
}

/**
 * Safely validate and normalize the plugin config for OpenClaw runtime loading.
 *
 * OpenClaw calls this through the plugin config schema when config is present.
 * We also accept `undefined` so the plugin can load cleanly with defaults.
 *
 * @param value Raw plugin config object.
 * @returns OpenClaw-compatible safe-parse result.
 */
function safeParseLangSmithPluginConfig(value: unknown):
  | { success: true; data: ResolvedLangSmithPluginConfig }
  | {
      success: false;
      error: {
        issues: Array<{ path: Array<string | number>; message: string }>;
      };
    } {
  if (value === undefined) {
    return {
      success: true,
      data: buildResolvedLangSmithPluginConfig(undefined),
    };
  }

  const result = LangSmithPluginConfigSource.safeParse(value);
  if (result.success) {
    return {
      success: true,
      data: buildResolvedLangSmithPluginConfig(result.data as LangSmithPluginConfig),
    };
  }

  return {
    success: false,
    error: {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.filter((segment): segment is string | number => {
          const kind = typeof segment;
          return kind === "string" || kind === "number";
        }),
        message: issue.message,
      })),
    },
  };
}

/**
 * Plugin config schema exposed to OpenClaw.
 */
export const langSmithPluginConfigSchema: OpenClawPluginConfigSchema = buildPluginConfigSchema(
  LangSmithPluginConfigSource,
  {
    uiHints: {
      enabled: {
        label: "Enable LangSmith Tracing",
        help: "Turn tracing on or off without disabling the whole plugin.",
      },
      langsmithApiKey: {
        label: "LangSmith API Key",
        help: "API key used to send traces to LangSmith.",
        sensitive: true,
        placeholder: "lsv2_...",
      },
      projectName: {
        label: "LangSmith Project Name",
        help: "Project name shown in LangSmith for this OpenClaw integration.",
      },
      debug: {
        label: "Debug Logging",
        help: "Enable extra startup logs for plugin troubleshooting.",
        advanced: true,
      },
    },
    safeParse: safeParseLangSmithPluginConfig,
  },
);

/**
 * Parse raw plugin config in a non-throwing way for startup code.
 *
 * @param value Raw `api.pluginConfig` value provided by OpenClaw.
 * @returns Normalized config plus lightweight metadata for startup decisions.
 */
export function parseLangSmithPluginConfig(value: unknown): LangSmithPluginConfigParseResult {
  const parsed = safeParseLangSmithPluginConfig(value);
  if (parsed.success) {
    return {
      config: parsed.data,
      hasUserSuppliedConfig: hasUserSuppliedPluginConfig(value),
      issues: [],
    };
  }

  return {
    config: buildResolvedLangSmithPluginConfig(undefined),
    hasUserSuppliedConfig: hasUserSuppliedPluginConfig(value),
    issues: parsed.error.issues.map((issue) => {
      const pathPrefix = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${pathPrefix}${issue.message}`;
    }),
  };
}

/**
 * Decide whether tracing is effectively allowed to initialize.
 *
 * @param config Normalized plugin config.
 * @returns `true` only when the feature switch is on and an API key exists.
 */
export function isLangSmithConfigured(config: ResolvedLangSmithPluginConfig): boolean {
  return config.enabled && Boolean(config.langsmithApiKey);
}
