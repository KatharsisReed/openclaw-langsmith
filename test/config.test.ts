/**
 * Global overview:
 * These tests verify the plugin's configuration normalization rules.
 * They focus on defaults, trimming, and fail-safe fallback behavior.
 */

import assert from "node:assert/strict";
import {
  DEFAULT_LANGSMITH_PLUGIN_CONFIG,
  isLangSmithConfigured,
  parseLangSmithPluginConfig,
} from "../src/config.js";
import { defineTest as test } from "./helpers/suite.js";

test("parseLangSmithPluginConfig returns defaults when config is missing", () => {
  const parsed = parseLangSmithPluginConfig(undefined);

  assert.deepEqual(parsed.config, {
    ...DEFAULT_LANGSMITH_PLUGIN_CONFIG,
    langsmithApiKey: undefined,
  });
  assert.equal(parsed.hasUserSuppliedConfig, false);
  assert.deepEqual(parsed.issues, []);
});

test("parseLangSmithPluginConfig trims user strings and preserves explicit booleans", () => {
  const parsed = parseLangSmithPluginConfig({
    enabled: false,
    langsmithApiKey: "  api-key  ",
    projectName: "  demo-project  ",
    debug: true,
  });

  assert.equal(parsed.config.enabled, false);
  assert.equal(parsed.config.langsmithApiKey, "api-key");
  assert.equal(parsed.config.projectName, "demo-project");
  assert.equal(parsed.config.debug, true);
  assert.equal(parsed.issues.length, 0);
});

test("parseLangSmithPluginConfig falls back to defaults and reports validation issues", () => {
  const parsed = parseLangSmithPluginConfig({
    enabled: "yes",
  });

  assert.deepEqual(parsed.config, {
    ...DEFAULT_LANGSMITH_PLUGIN_CONFIG,
    langsmithApiKey: undefined,
  });
  assert.equal(parsed.hasUserSuppliedConfig, true);
  assert.ok(parsed.issues.some((issue) => issue.includes("enabled")));
});

test("isLangSmithConfigured only returns true when enabled and api key exist", () => {
  assert.equal(
    isLangSmithConfigured({
      enabled: true,
      langsmithApiKey: "key",
      projectName: "demo",
      debug: false,
    }),
    true,
  );

  assert.equal(
    isLangSmithConfigured({
      enabled: false,
      langsmithApiKey: "key",
      projectName: "demo",
      debug: false,
    }),
    false,
  );

  assert.equal(
    isLangSmithConfigured({
      enabled: true,
      projectName: "demo",
      debug: false,
    }),
    false,
  );
});
