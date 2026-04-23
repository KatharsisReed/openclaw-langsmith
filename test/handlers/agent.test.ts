/**
 * Global overview:
 * These tests verify the agent_end adapter and its behavior when hook context
 * is complete versus missing the run identifier.
 */

import assert from "node:assert/strict";
import { createAgentHookHandlers } from "../../src/handlers/agent.js";
import { createMockLogger, createMockTracer } from "../helpers/mocks.js";
import { defineTest as test } from "../helpers/suite.js";

test("onAgentEnd forwards the final turn summary to the tracer", async () => {
  const tracer = createMockTracer();
  const logger = createMockLogger();
  const handlers = createAgentHookHandlers({
    debug: false,
    logger,
    getTracer: async () => tracer,
  });

  await handlers.onAgentEnd(
    {
      messages: [{ role: "assistant", content: "done" }],
      success: true,
      durationMs: 1200,
    },
    {
      runId: "run-1",
      sessionId: "session-1",
      sessionKey: "session-key-1",
      agentId: "agent-1",
      channelId: "channel-1",
      trigger: "manual",
    },
  );

  assert.equal(tracer.finishRootRunCalls.length, 1);
  assert.deepEqual(tracer.finishRootRunCalls[0], {
    openclawRunId: "run-1",
    sessionId: "session-1",
    sessionKey: "session-key-1",
    agentId: "agent-1",
    workspaceDir: undefined,
    messageProvider: undefined,
    trigger: "manual",
    channelId: "channel-1",
    messages: [{ role: "assistant", content: "done" }],
    success: true,
    error: undefined,
    durationMs: 1200,
  });
});

test("onAgentEnd skips tracing when ctx.runId is missing", async () => {
  const tracer = createMockTracer();
  const logger = createMockLogger();
  const handlers = createAgentHookHandlers({
    debug: false,
    logger,
    getTracer: async () => tracer,
  });

  await handlers.onAgentEnd(
    {
      messages: [],
      success: false,
      error: "failed",
    },
    {},
  );

  assert.equal(tracer.finishRootRunCalls.length, 0);
});
