/**
 * Global overview:
 * These tests verify the transcript hook's lightweight queueing behavior and
 * its fail-open logging path.
 */

import assert from "node:assert/strict";
import { createTranscriptHookHandlers } from "../../src/handlers/transcript.js";
import { createMockLogger, createMockTracer } from "../helpers/mocks.js";
import { defineTest as test } from "../helpers/suite.js";

test("onBeforeMessageWrite prefers sessionKey and agentId from the event payload", () => {
  const tracer = createMockTracer();
  const logger = createMockLogger();
  const handlers = createTranscriptHookHandlers({
    debug: false,
    logger,
    getLiveTracer: () => tracer,
  });

  handlers.onBeforeMessageWrite(
    {
      sessionKey: "event-session",
      agentId: "event-agent",
      message: { role: "assistant", content: "hello" },
    },
    {
      sessionKey: "ctx-session",
      agentId: "ctx-agent",
    },
  );

  assert.equal(tracer.queueSessionMessageCalls.length, 1);
  assert.deepEqual(tracer.queueSessionMessageCalls[0], {
    sessionKey: "event-session",
    agentId: "event-agent",
    message: { role: "assistant", content: "hello" },
  });
});

test("onBeforeMessageWrite logs a warning instead of throwing when queueing fails", () => {
  const logger = createMockLogger();
  const tracer = createMockTracer();
  tracer.queueSessionMessage = (): void => {
    throw new Error("queue failed");
  };
  const handlers = createTranscriptHookHandlers({
    debug: false,
    logger,
    getLiveTracer: () => tracer,
  });

  assert.doesNotThrow(() => {
    handlers.onBeforeMessageWrite(
      {
        message: { role: "assistant", content: "hello" },
      },
      {},
    );
  });

  assert.match(
    logger.records.at(-1)?.message ?? "",
    /before_message_write trace failed: queue failed/,
  );
});
