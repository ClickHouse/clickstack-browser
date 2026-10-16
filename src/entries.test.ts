import { context, trace } from '@opentelemetry/api';
import { expect, test } from 'vitest';
import * as iife from './iife.ts';
import * as npm from './index.ts';
import { logs } from './logs-api.ts';
import * as replay from './replay.ts';

test('the entries export exactly the public API', () => {
  expect(Object.keys(npm).sort()).toEqual([
    'getSessionId',
    'init',
    'pauseReplay',
    'resumeReplay',
    'setUser',
    'shutdown',
  ]);
  expect(Object.keys(replay)).toEqual(['startReplay']);
});

test('the script-tag build adds the OpenTelemetry API to the npm entry', () => {
  expect(Object.keys(iife).sort()).toEqual([...Object.keys(npm), 'otel'].sort());
  expect(iife.otel).toEqual({ trace, context, logs });
});
