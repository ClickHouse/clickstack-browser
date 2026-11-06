import {
  context,
  ROOT_CONTEXT,
  type Context,
  type ContextManager,
} from "@opentelemetry/api";
import { isTracingSuppressed } from "@opentelemetry/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { gzip, post } from "./transport.ts";

const URL_ = "https://example-collector.clickhouse.com/v1/logs";
const BODY = new Uint8Array([1, 2, 3]);

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

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response(null, { status: 200 })),
  );
  vi.stubGlobal("fetch", fetchMock);
  context.setGlobalContextManager(manager);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  context.disable();
});

test("gzip output decompresses to the input", async () => {
  const text = "x".repeat(100_000);
  const compressed = await gzip(new TextEncoder().encode(text));
  const stream = new Blob([compressed])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));

  expect(compressed.byteLength).toBeLessThan(1000);
  expect(await new Response(stream).text()).toBe(text);
});

test("posts outside any trace and reads the response", async () => {
  let suppressed = false;
  const response = new Response("{}", { status: 200 });
  fetchMock.mockImplementation(() => {
    suppressed = isTracingSuppressed(context.active());
    return Promise.resolve(response);
  });

  expect(await post(URL_, { a: "b" }, BODY, false)).toBe(response);
  expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
    method: "POST",
    headers: { a: "b" },
    body: BODY,
    keepalive: false,
  });
  expect(suppressed).toBe(true);
  expect(response.bodyUsed).toBe(true);
});

test("sends a rejected keepalive request once more without keepalive", async () => {
  fetchMock.mockRejectedValueOnce(new TypeError("keepalive quota"));

  await post(URL_, {}, BODY, true);
  expect(fetchMock.mock.calls.map(([, init]) => init?.keepalive)).toEqual([
    true,
    false,
  ]);
});

// Responses wait until respond() is called, so requests stay in flight and share the limits
function holdResponses(): () => void {
  let respond = (): void => undefined;
  const responded = new Promise<void>((resolve) => {
    respond = resolve;
  });
  fetchMock.mockImplementation(() =>
    responded.then(() => new Response(null, { status: 200 })),
  );
  return respond;
}

test("uses keepalive only within the limits shared by all requests", async () => {
  const respond = holdResponses();
  const big = new Uint8Array(40 * 1024);

  const sent = [
    post(URL_, {}, big, true),
    post(URL_, {}, big, true),
    ...Array.from({ length: 9 }, () => post(URL_, {}, BODY, true)),
    post(URL_, {}, BODY, false),
  ];
  respond();
  await Promise.all(sent);

  // The second 40 KiB body would exceed 60 KiB, and the tenth request Chromium's 9
  expect(fetchMock.mock.calls.map(([, init]) => init?.keepalive)).toEqual([
    true,
    false,
    ...Array.from({ length: 8 }, () => true),
    false,
    false,
  ]);
});

test("gives up after 10 s without sending again, and releases the limits", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // A collector that never answers
  fetchMock.mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason as Error);
        });
      }),
  );

  const posting = post(URL_, {}, new Uint8Array(40 * 1024), true);
  const failed = expect(posting).rejects.toThrow(DOMException);
  await vi.advanceTimersByTimeAsync(9_999);

  expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);

  await vi.advanceTimersByTimeAsync(1);

  await failed;

  expect(fetchMock).toHaveBeenCalledOnce();

  fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
  await post(URL_, {}, new Uint8Array(40 * 1024), true);

  expect(fetchMock.mock.calls[1]?.[1]?.keepalive).toBe(true);
});
