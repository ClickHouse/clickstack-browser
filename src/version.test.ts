import { expect, test } from 'vitest';
import { VERSION } from './version.ts';

test('VERSION is the semver string injected at build time', () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
});
