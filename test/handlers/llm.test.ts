/**
 * Global overview:
 * These tests verify that llm hook handlers correctly map OpenClaw hook data
 * into tracer calls while keeping the fail-open contract.
 */

import assert from "node:assert/strict";
import { createLlmHookHandlers } from "../../src/handlers/llm.js";
import { createMockLogger, createMockTracer } from "../helpers/mocks.js";
import { defineTest as test } from "../helpers/suite.js";

test("onLlmInput forwards normalized tracing parameters to the tracer", async () => {
  const tracer = createMockTracer();
  const logger = createMockLogger();
  const handlers = createLlmHookHandlers({
    debug: false,
    logger,
    getTracer: async () => tracer,
  });

  await handlers.onLlmInput(
    {
      runId: "run-1",
      sessionId: "session-1",
      provider: "openai",
      model: "gpt-4.1",
      systemPrompt: "system",
      prompt: "hello",
      historyMessages: [{ role: "user", content: "hello" }],
      imagesCount: 1,
    },
    {
      agentId: "agent-1",
      sessionKey: "session-key-1",
      sessionId: "session-1",
      workspaceDir: "D:/workspace",
      messageProvider: "console",
      trigger: "manual",
      channelId: "channel-1",
    },
  );

  assert.equal(tracer.startLlmRunCalls.length, 1);
  assert.deepEqual(tracer.startLlmRunCalls[0], {
    openclawRunId: "run-1",
    sessionId: "session-1",
    sessionKey: "session-key-1",
    agentId: "agent-1",
    workspaceDir: "D:/workspace",
    messageProvider: "console",
    trigger: "manual",
    channelId: "channel-1",
    provider: "openai",
    model: "gpt-4.1",
    systemPrompt: "system",
    prompt: "hello",
    historyMessages: [{ role: "user", content: "hello" }],
    imagesCount: 1,
  });
});

test("onLlmOutput logs a warning instead of throwing when tracer lookup fails", async () => {
  const logger = createMockLogger();
  const handlers = createLlmHookHandlers({
    debug: false,
    logger,
    getTracer: async () => {
      throw new Error("lookup failed");
    },
  });

  await assert.doesNotReject(async () => {
    await handlers.onLlmOutput(
      {
        runId: "run-1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-4.1",
        assistantTexts: ["done"],
      },
      {},
    );
  });

  assert.match(logger.records.at(-1)?.message ?? "", /llm_output trace failed: lookup failed/);
});
