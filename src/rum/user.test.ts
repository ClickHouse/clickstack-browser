import { afterEach, expect, test } from 'vitest';
import { TracerProvider } from '@opentelemetry/sdk-trace';
import { setUser, userSpanProcessor } from './user.ts';

afterEach(() => {
  setUser(null);
});

function startedSpanAttributes(): Record<string, unknown> {
  const provider = new TracerProvider({ spanProcessors: [userSpanProcessor] });
  const span = provider.getTracer('test').startSpan('s');
  span.end();
  return (span as unknown as { attributes: Record<string, unknown> }).attributes;
}

test('setUser puts the standard user keys on later spans and replaces the previous user', () => {
  setUser({ id: '123', email: 'example@clickhouse.com', name: 'click', fullName: 'ClickHouse', roles: ['admin'] });
  expect(startedSpanAttributes()).toEqual({
    'user.id': '123',
    'user.email': 'example@clickhouse.com',
    'user.name': 'click',
    'user.full_name': 'ClickHouse',
    'user.roles': ['admin'],
  });

  setUser({ id: '456' });
  expect(startedSpanAttributes()).toEqual({ 'user.id': '456' });

  setUser(null);
  expect(startedSpanAttributes()).toEqual({});
});
