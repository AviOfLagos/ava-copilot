import { defineConfig } from 'vitest/config';
import base from '../vitest.config.mts';

// The unit tests' aliases, with the eval cases instead of the tests, reported one line per case
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['evals/**/*.eval.test.ts'],
    reporters: ['./evals/reporter.ts'],
  },
});
