import type { Reporter, TestCase, TestModule } from 'vitest/node';

/**
 * One line per case, then the totals, in the shape Suture's verifier reads:
 *
 *   PASS <case>
 *   FAIL <case>
 *     ↳ <why>
 *   evals: 6 total, 5 passed, 1 failed
 */
export default class EvalReporter implements Reporter {
  private passed = 0;
  private failed = 0;

  onTestCaseResult(testCase: TestCase): void {
    const result = testCase.result();
    if (result.state === 'passed') {
      this.passed++;
      console.log(`PASS ${testCase.name}`);
    } else if (result.state === 'failed') {
      this.failed++;
      console.log(`FAIL ${testCase.name}`);
      for (const error of result.errors ?? []) console.log(`  ↳ ${(error.message ?? '').split('\n')[0]}`);
    }
  }

  onTestRunEnd(modules: readonly TestModule[], errors: readonly unknown[]): void {
    // A file that does not load (a case that does not parse) has no cases: say why
    for (const module of modules)
      for (const error of module.errors()) console.log(`FAIL ${module.moduleId}\n  ↳ ${error.message.split('\n')[0]}`);
    for (const error of errors) console.log(`  ↳ ${error instanceof Error ? error.message : String(error)}`);
    const broken = modules.some(module => module.errors().length) || errors.length > 0;
    console.log(
      `evals: ${this.passed + this.failed} total, ${this.passed} passed, ${this.failed + (broken ? 1 : 0)} failed`,
    );
  }
}
