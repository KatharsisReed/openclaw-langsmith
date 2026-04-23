/**
 * Global overview:
 * This file is the single test-process entrypoint used by package scripts and CI.
 * It loads all test modules, then executes the registered cases with the local
 * lightweight runner.
 */

import "./config.test.js";
import "./handlers/agent.test.js";
import "./handlers/llm.test.js";
import "./handlers/tool.test.js";
import "./handlers/transcript.test.js";
import "./tracer.test.js";
import { runRegisteredTests } from "./helpers/suite.js";

await runRegisteredTests();
