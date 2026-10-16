import { diag } from '@opentelemetry/api';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { pageState } from '../internal/global.ts';
import { startReplay } from './start.ts';

const sessionManager = {
  getSessionId: () => 'session-a',
  addObserver: () => undefined,
};

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for('@clickhouse/clickstack-browser'));
  fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 200 })));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function gunzip(body: unknown): Promise<string> {
  const stream = new Blob([body as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));

  return new Response(stream).text();
}

test('sends the recording to the endpoint with the given service name and key', async () => {
  const replay = startReplay({
    sessionManager,
    endpoint: '/otel',
    apiKey: 'key-1',
    serviceName: 'web-shop',
    resourceAttributes: { 'service.version': '1.2.3' },
  });

  await new Promise((resolve) => setTimeout(resolve, 20));

  replay.pause();
  replay.resume();
  await replay.shutdown();

  const [url, init] = fetchMock.mock.calls[0] ?? [];
  expect(url).toBe(`${location.origin}/otel/v1/logs`);
  expect(init?.headers).toMatchObject({ authorization: 'key-1' });

  const json = await gunzip(init?.body);
  expect(json).toContain('{"key":"service.name","value":{"stringValue":"web-shop"}}');
  expect(json).toContain('{"key":"service.version","value":{"stringValue":"1.2.3"}}');
  expect(json).toContain('{"key":"session.id","value":{"stringValue":"session-a"}}');
  expect(pageState().recording).toBe(false);
});

test('records nothing with an invalid endpoint or while another recording runs', async () => {
  const warn = vi.spyOn(diag, 'warn');
  const invalid = startReplay({ sessionManager, endpoint: 'ftp://x', serviceName: 'web-shop' });

  pageState().recording = true;
  const second = startReplay({ sessionManager, endpoint: '/otel', serviceName: 'web-shop' });

  await invalid.shutdown();
  await second.shutdown();

  invalid.pause();
  second.resume();
  
  expect(warn).toHaveBeenCalledTimes(2);
  expect(fetchMock).not.toHaveBeenCalled();
});
