/**
 * Global overview:
 * This file implements a tiny in-repo test runner.
 * It avoids subprocess-based runners so the test suite can execute in more
 * restricted environments while still giving readable pass/fail output.
 */

/**
 * One registered test case.
 */
type RegisteredTest = {
  name: string;
  run: () => void | Promise<void>;
};

const registeredTests: RegisteredTest[] = [];

/**
 * Register one test case for later execution.
 *
 * @param name Human-readable test name.
 * @param run Test body.
 * @returns Nothing.
 */
export function defineTest(name: string, run: () => void | Promise<void>): void {
  registeredTests.push({ name, run });
}

/**
 * Execute every registered test case in definition order.
 *
 * @returns Promise that resolves when all tests pass, otherwise rejects.
 */
export async function runRegisteredTests(): Promise<void> {
  let passedCount = 0;
  const failures: Array<{ name: string; error: unknown }> = [];

  for (const testCase of registeredTests) {
    try {
      await testCase.run();
      passedCount += 1;
      console.log(`PASS ${testCase.name}`);
    } catch (error) {
      failures.push({ name: testCase.name, error });
      console.error(`FAIL ${testCase.name}`);
      console.error(error);
    }
  }

  console.log(`\nTest summary: ${passedCount}/${registeredTests.length} passed.`);
  if (failures.length > 0) {
    throw new Error(`${failures.length} test(s) failed.`);
  }
}
