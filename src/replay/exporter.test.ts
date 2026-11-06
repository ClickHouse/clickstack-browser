import {
  context,
  diag,
  ROOT_CONTEXT,
  type Context,
  type ContextManager,
} from "@opentelemetry/api";
import { isTracingSuppressed } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  LoggerProvider,
  type ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ReplayExporter, toOtlpJson } from "./exporter.ts";

const URL_ = "http://collector-test/v1/logs";

// A minimal synchronous context manager, so context.with() works as in the browser SDK.
let active: Context = ROOT_CONTEXT;
const manager: ContextManager = {
  active: () => active,
  with: (ctx, fn, thisArg, ...args) => {
    const previous = active;
    active = ctx;

    try {
      return fn.call(thisArg, ...args);
    } finally {
      active = previous;
    }
  },
  bind: (_ctx, target) => target,
  enable: () => manager,
  disable: () => manager,
};

function records(
  bodies: string[],
): [ReadableLogRecord, ...ReadableLogRecord[]] {
  const captured: ReadableLogRecord[] = [];
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({
      "service.name": "web",
      "browser.mobile": false,
      "browser.brands": ["A 1"],
    }),
    processors: [
      {
        onEmit: (r) => captured.push(r),
        forceFlush: () => Promise.resolve(),
        shutdown: () => Promise.resolve(),
      },
    ],
  });
  const logger = provider.getLogger("rum.rr-web", "1.2.3");
  bodies.forEach((body, i) => {
    logger.emit({
      timestamp: 1_700_000_000_123,
      body,
      attributes: {
        "session.id": "s1",
        "rr-web.event": i + 1,
        "rr-web.offset": i + 1.5,
      },
    });
  });
  return captured as [ReadableLogRecord, ...ReadableLogRecord[]];
}

async function gunzip(body: BodyInit | null | undefined): Promise<string> {
  const stream = new Blob([body as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
const warn = vi.fn();

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response(null, { status: 200 })),
  );
  vi.stubGlobal("fetch", fetchMock);
  context.setGlobalContextManager(manager);
  diag.setLogger({
    error: vi.fn(),
    warn,
    info: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  warn.mockReset();
  context.disable();
  diag.disable();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});

function exportAll(
  exporter: ReplayExporter,
  batch: ReadableLogRecord[],
): Promise<number> {
  return new Promise((resolve) => {
    exporter.export(batch, (result) => {
      resolve(result.code);
    });
  });
}

test("serializes records as one OTLP/JSON resource and scope", () => {
  expect(JSON.parse(toOtlpJson(records(['{"type":4}'])))).toEqual({
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "web" } },
            { key: "browser.mobile", value: { boolValue: false } },
            {
              key: "browser.brands",
              value: { arrayValue: { values: [{ stringValue: "A 1" }] } },
            },
          ],
        },
        scopeLogs: [
          {
            scope: { name: "rum.rr-web", version: "1.2.3" },
            logRecords: [
              {
                timeUnixNano: "1700000000123000000",
                observedTimeUnixNano: expect.stringMatching(
                  /^\d{19}$/,
                ) as unknown,
                body: { stringValue: '{"type":4}' },
                attributes: [
                  { key: "session.id", value: { stringValue: "s1" } },
                  { key: "rr-web.event", value: { intValue: "1" } },
                  { key: "rr-web.offset", value: { doubleValue: 1.5 } },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
});

test("posts gzip-compressed OTLP/JSON with the key, outside any trace", async () => {
  let suppressed = false;
  fetchMock.mockImplementation(() => {
    suppressed = isTracingSuppressed(context.active());
    return Promise.resolve(new Response(null, { status: 200 }));
  });
  const batch = records(['{"type":4}', '{"type":2}']);

  expect(await exportAll(new ReplayExporter(URL_, "key-1"), batch)).toBe(0);

  expect(fetchMock).toHaveBeenCalledOnce();
  const [url, init] = fetchMock.mock.calls[0] ?? [];
  expect(url).toBe(URL_);
  expect(init).toMatchObject({
    method: "POST",
    keepalive: true,
    headers: {
      authorization: "key-1",
      "content-type": "application/json",
      "content-encoding": "gzip",
    },
  });
  expect(await gunzip(init?.body)).toBe(toOtlpJson(batch));
  expect(suppressed).toBe(true);
});

test("splits a batch into requests of at most 4 Mi characters of bodies", async () => {
  const big = "x".repeat(3 * 1024 * 1024);
  await exportAll(
    new ReplayExporter(URL_, undefined),
    records([big, big, "{}"]),
  );
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("uses keepalive for a small request from a hidden page, and retries without it when rejected", async () => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });
  fetchMock.mockRejectedValueOnce(new TypeError("keepalive quota"));

  await exportAll(new ReplayExporter(URL_, undefined), records(["{}"]));

  expect(fetchMock.mock.calls.map(([, init]) => init?.keepalive)).toEqual([
    true,
    false,
  ]);
  expect(warn).not.toHaveBeenCalled();
});

// Base64 of random bytes barely compresses, so these bodies keep most of their size after gzip.
function randomText(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array((length * 3) / 4));
  return btoa(String.fromCharCode(...bytes));
}

test("splits the final flush of a hidden page into parts that fit the keepalive cap", async () => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });
  // Responses wait, so every part is in flight at once and shares the keepalive budget.
  let respond = (): void => undefined;
  const responded = new Promise<void>((resolve) => {
    respond = resolve;
  });
  fetchMock.mockImplementation(() =>
    responded.then(() => new Response(null, { status: 200 })),
  );
  const bodies = [randomText(16_384), randomText(16_384), randomText(16_384)];

  const exported = exportAll(
    new ReplayExporter(URL_, undefined),
    records(bodies),
  );
  await vi.waitFor(() => {
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  respond();
  await exported;

  const sent = fetchMock.mock.calls.map(([, init]) => init);
  for (const init of sent) {
    expect((init?.body as Uint8Array).byteLength).toBeLessThanOrEqual(
      32 * 1024,
    );
  }
  expect(sent.map((init) => init?.keepalive)).toEqual([true, false]);
  const json = (await Promise.all(sent.map((init) => gunzip(init?.body)))).join(
    "",
  );
  for (const body of bodies) {
    expect(json).toContain(body);
  }
});

test("sends a single record too large for keepalive without it", async () => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });

  await exportAll(
    new ReplayExporter(URL_, undefined),
    records([randomText(64_000)]),
  );

  expect(fetchMock.mock.calls.map(([, init]) => init?.keepalive)).toEqual([
    false,
  ]);
});

test("logs one warning however many requests fail, and still reports success", async () => {
  fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
  const exporter = new ReplayExporter(URL_, undefined);

  expect(await exportAll(exporter, records(["{}"]))).toBe(0);
  fetchMock.mockRejectedValue(new TypeError("offline"));
  await exportAll(exporter, records(["{}"]));

  expect(warn).toHaveBeenCalledOnce();
  expect(warn.mock.calls[0]?.[1]).toBe("HTTP 503");
});

test("forceFlush waits for requests in flight", async () => {
  let respond = (): void => undefined;
  fetchMock.mockReturnValue(
    new Promise((resolve) => {
      respond = () => {
        resolve(new Response(null, { status: 200 }));
      };
    }),
  );

  const exporter = new ReplayExporter(URL_, undefined);
  exporter.export(records(["{}"]), () => undefined);

  let flushed = false;
  const flushing = exporter.forceFlush().then(() => {
    flushed = true;
  });

  await vi.waitFor(() => {
    expect(fetchMock).toHaveBeenCalled();
  });

  expect(flushed).toBe(false);

  respond();
  await flushing;
  expect(flushed).toBe(true);
});
