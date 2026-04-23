/**
 * Global overview:
 * These tests cover the tool hook adapter layer, especially runId resolution
 * and safe behavior when required identifiers are missing.
 */

import assert from "node:assert/strict";
import { createToolHookHandlers } from "../../src/handlers/tool.js";
import { createMockLogger, createMockTracer } from "../helpers/mocks.js";
import { defineTest as test } from "../helpers/suite.js";

test("onBeforeToolCall falls back to ctx.runId when event.runId is missing", async () => {
  const tracer = createMockTracer();
  const logger = createMockLogger();
  const handlers = createToolHookHandlers({
    debug: false,
    logger,
    getTracer: async () => tracer,
  });

  await handlers.onBeforeToolCall(
    {
      toolName: "search",
      params: { query: "weather" },
      toolCallId: "tool-1",
    },
    {
      runId: "run-1",
      sessionId: "session-1",
      sessionKey: "session-key-1",
      agentId: "agent-1",
    },
  );

  assert.equal(tracer.startToolRunCalls.length, 1);
  assert.deepEqual(tracer.startToolRunCalls[0], {
    openclawRunId: "run-1",
    sessionId: "session-1",
    sessionKey: "session-key-1",
    agentId: "agent-1",
    workspaceDir: undefined,
    messageProvider: undefined,
    trigger: undefined,
    channelId: undefined,
    toolName: "search",
    params: { query: "weather" },
    toolCallId: "tool-1",
  });
});

test("onAfterToolCall silently skips tracing when no runId can be resolved", async () => {
  const tracer = createMockTracer();
  const logger = createMockLogger();
  const handlers = createToolHookHandlers({
    debug: false,
    logger,
    getTracer: async () => tracer,
  });

  await handlers.onAfterToolCall(
    {
      toolName: "search",
      params: { query: "weather" },
      result: { ok: true },
    },
    {},
  );

  assert.equal(tracer.finishToolRunCalls.length, 0);
  assert.equal(logger.records.length, 0);
});
