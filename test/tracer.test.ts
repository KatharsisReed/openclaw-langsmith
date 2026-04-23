/**
 * Global overview:
 * These tests focus on the tracer's runtime state machine. The goal is to
 * verify the two behaviors that are most important for GitHub readiness:
 * transcript-aware synthetic llm materialization and deferred root finalization.
 */

import assert from "node:assert/strict";
import { createTracer } from "../src/tracer.js";
import type {
  FinishLlmRunParams,
  FinishRootRunParams,
  FinishToolRunParams,
  StartLlmRunParams,
  StartToolRunParams,
} from "../src/types.js";
import {
  createMockLogger,
  createMockRunTreeFactory,
} from "./helpers/mocks.js";
import { defineTest as test } from "./helpers/suite.js";

/**
 * Build a standard llm-start payload so each tracer test only overrides what
 * is relevant to that scenario.
 *
 * @param overrides Scenario-specific field overrides.
 * @returns LLM-start payload.
 */
function createStartLlmParams(
  overrides: Partial<StartLlmRunParams> = {},
): StartLlmRunParams {
  return {
    openclawRunId: "run-1",
    sessionId: "session-1",
    sessionKey: "session-key-1",
    agentId: "agent-1",
    provider: "openai",
    model: "gpt-4.1",
    prompt: "hello",
    historyMessages: [],
    imagesCount: 0,
    ...overrides,
  };
}

/**
 * Build a standard llm-finish payload for root-output and cleanup tests.
 *
 * @param overrides Scenario-specific field overrides.
 * @returns LLM-finish payload.
 */
function createFinishLlmParams(
  overrides: Partial<FinishLlmRunParams> = {},
): FinishLlmRunParams {
  return {
    openclawRunId: "run-1",
    sessionId: "session-1",
    sessionKey: "session-key-1",
    agentId: "agent-1",
    provider: "openai",
    model: "gpt-4.1",
    assistantTexts: ["done"],
    lastAssistant: {
      role: "assistant",
      content: "done",
      stopReason: "end_turn",
      provider: "openai",
      model: "gpt-4.1",
    },
    usage: {
      input: 10,
      output: 5,
      total: 15,
    },
    ...overrides,
  };
}

/**
 * Build a standard tool-start payload.
 *
 * @param overrides Scenario-specific field overrides.
 * @returns Tool-start payload.
 */
function createStartToolParams(
  overrides: Partial<StartToolRunParams> = {},
): StartToolRunParams {
  return {
    openclawRunId: "run-1",
    sessionId: "session-1",
    sessionKey: "session-key-1",
    agentId: "agent-1",
    toolName: "search",
    params: { query: "weather" },
    toolCallId: "tool-1",
    ...overrides,
  };
}

/**
 * Build a standard tool-finish payload.
 *
 * @param overrides Scenario-specific field overrides.
 * @returns Tool-finish payload.
 */
function createFinishToolParams(
  overrides: Partial<FinishToolRunParams> = {},
): FinishToolRunParams {
  return {
    openclawRunId: "run-1",
    sessionId: "session-1",
    sessionKey: "session-key-1",
    agentId: "agent-1",
    toolName: "search",
    toolCallId: "tool-1",
    result: { ok: true },
    durationMs: 42,
    ...overrides,
  };
}

/**
 * Build a standard root-finish payload.
 *
 * @param overrides Scenario-specific field overrides.
 * @returns Root-finish payload.
 */
function createFinishRootParams(
  overrides: Partial<FinishRootRunParams> = {},
): FinishRootRunParams {
  return {
    openclawRunId: "run-1",
    sessionId: "session-1",
    sessionKey: "session-key-1",
    agentId: "agent-1",
    messages: [
      {
        role: "assistant",
        content: "done",
        stopReason: "end_turn",
        provider: "openai",
        model: "gpt-4.1",
      },
    ],
    success: true,
    durationMs: 100,
    ...overrides,
  };
}

test("tracer materializes a synthetic llm node before creating the related tool node", async () => {
  const logger = createMockLogger();
  const runTreeFactory = createMockRunTreeFactory();
  const tracer = createTracer({
    config: {
      projectName: "demo-project",
      debug: false,
    },
    logger,
    createRunTree: runTreeFactory.createRunTree,
  });

  await tracer.startLlmRun(createStartLlmParams());
  tracer.queueSessionMessage({
    sessionKey: "session-key-1",
    agentId: "agent-1",
    message: {
      role: "assistant",
      provider: "openai",
      model: "gpt-4.1",
      stopReason: "tool_call",
      content: [
        { type: "text", text: "Searching now" },
        { type: "toolCall", id: "tool-1", name: "search" },
      ],
    },
  });
  await tracer.startToolRun(createStartToolParams());

  assert.equal(runTreeFactory.roots.length, 1);
  const rootRun = runTreeFactory.roots[0];
  assert.equal(rootRun.name, "openclaw.agent_turn");
  assert.equal(rootRun.children.length, 2);

  const syntheticLlmRun = rootRun.children[0];
  assert.equal(syntheticLlmRun.name, "openclaw.llm");
  assert.ok(syntheticLlmRun.tags?.includes("synthetic-llm"));
  assert.equal(syntheticLlmRun.postRunCalls, 1);
  assert.equal(syntheticLlmRun.endCalls, 1);
  assert.equal(syntheticLlmRun.patchRunCalls, 1);

  const toolRun = rootRun.children[1];
  assert.equal(toolRun.name, "openclaw.tool.search");
  assert.equal(toolRun.metadata?.parentSyntheticLlmSequence, 1);
});

test("tracer defers root finalization until active tool runs have finished", async () => {
  const logger = createMockLogger();
  const runTreeFactory = createMockRunTreeFactory();
  const tracer = createTracer({
    config: {
      projectName: "demo-project",
      debug: false,
    },
    logger,
    createRunTree: runTreeFactory.createRunTree,
  });

  await tracer.startLlmRun(createStartLlmParams());
  await tracer.finishLlmRun(createFinishLlmParams());
  await tracer.startToolRun(createStartToolParams());
  await tracer.finishRootRun(createFinishRootParams());

  const rootRun = runTreeFactory.roots[0];
  assert.equal(rootRun.endCalls, 0);

  await tracer.finishToolRun(createFinishToolParams());

  assert.equal(rootRun.endCalls, 1);
  assert.equal(rootRun.postRunCalls, 1);
  assert.equal(rootRun.patchRunCalls, 3);
  assert.equal(rootRun.metadata?.success, true);
  assert.equal(rootRun.metadata?.messageCount, 1);

  assert.deepEqual(tracer.getStateSnapshot(), {
    rootRunCount: 0,
    llmAttemptCount: 0,
    llmAttemptSequenceOwners: [],
    activeLlmAttemptOwners: [],
    syntheticLlmRunCount: 0,
    activeSyntheticLlmOwners: [],
    queuedSessionMessageOwners: [],
    toolRunCount: 0,
    toolSequenceOwners: [],
    activeToolBuckets: [],
  });
});
