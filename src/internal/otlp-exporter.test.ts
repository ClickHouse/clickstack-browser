import {
  context,
  diag,
  ROOT_CONTEXT,
  type Context,
  type ContextManager,
} from "@opentelemetry/api";
import { isTracingSuppressed } from "@opentelemetry/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { OtlpJsonExporter } from "./otlp-exporter.ts";

const URL_ = "https://example-collector.clickhouse.com/v1/traces";

// A serializer that writes the items as a JSON array, standing in for the upstream ones
const serializer = {
  serializeRequest: (items: string[]): Uint8Array =>
    new TextEncoder().encode(JSON.stringify(items)),
};

// A minimal synchronous context manager, so context.with() works as in the browser SDK
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
  warn.mockReset();
  context.disable();
  diag.disable();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});

function setHidden(): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });
}

function exportItems(
  exporter: OtlpJsonExporter<string>,
  items: string[],
): Promise<number> {
  return new Promise((resolve) => {
    exporter.export(items, (result) => {
      resolve(result.code);
    });
  });
}

test("posts the serialized body with the key, outside any trace, without keepalive while visible, and reads the response", async () => {
  let suppressed = false;
  const response = new Response("{}", { status: 200 });
  fetchMock.mockImplementation(() => {
    suppressed = isTracingSuppressed(context.active());
    return Promise.resolve(response);
  });

  expect(
    await exportItems(new OtlpJsonExporter(URL_, "key-1", serializer), ["a"]),
  ).toBe(0);

  const [url, init] = fetchMock.mock.calls[0] ?? [];

  expect(url).toBe(URL_);
  expect(init).toMatchObject({
    method: "POST",
    keepalive: false,
    headers: { authorization: "key-1", "content-type": "application/json" },
  });
  expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe('["a"]');
  expect(suppressed).toBe(true);
  expect(response.bodyUsed).toBe(true);
});

test("uses keepalive while hidden within the shared limits, and sends again without it when rejected", async () => {
  setHidden();
  const exporter = new OtlpJsonExporter(URL_, undefined, serializer);
  // Responses wait, so every request is in flight at once and shares the limits
  let respond = (): void => undefined;
  const responded = new Promise<void>((resolve) => {
    respond = resolve;
  });
  fetchMock.mockImplementation(() =>
    responded.then(() => new Response(null, { status: 200 })),
  );

  const big = "x".repeat(40 * 1024);
  const sent = [
    exportItems(exporter, [big]),
    exportItems(exporter, [big]),
    ...Array.from({ length: 9 }, () => exportItems(exporter, ["small"])),
  ];
  await vi.waitFor(() => {
    expect(fetchMock).toHaveBeenCalledTimes(11);
  });
  respond();
  await Promise.all(sent);

  const keepalive = fetchMock.mock.calls.map(([, init]) => init?.keepalive);
  // The second 40 KiB body would exceed 60 KiB, and the tenth request Chromium's 9
  expect(keepalive.slice(0, 2)).toEqual([true, false]);
  expect(keepalive.filter(Boolean)).toHaveLength(9);

  fetchMock.mockReset();
  fetchMock.mockRejectedValueOnce(new TypeError("keepalive quota"));
  fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
  await exportItems(exporter, ["after"]);

  expect(fetchMock.mock.calls.map(([, init]) => init?.keepalive)).toEqual([
    true,
    false,
  ]);
  expect(warn).not.toHaveBeenCalled();
});

test("logs one warning however many requests fail, and still reports success", async () => {
  fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
  const exporter = new OtlpJsonExporter(URL_, undefined, serializer);

  expect(await exportItems(exporter, ["a"])).toBe(0);

  fetchMock.mockRejectedValue(new TypeError("offline"));
  await exportItems(exporter, ["b"]);

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
  const exporter = new OtlpJsonExporter(URL_, undefined, serializer);
  exporter.export(["a"], () => undefined);

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
