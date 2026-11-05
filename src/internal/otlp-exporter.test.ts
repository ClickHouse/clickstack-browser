import { diag } from "@opentelemetry/api";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { OtlpJsonExporter } from "./otlp-exporter.ts";

const URL_ = "https://example-collector.clickhouse.com/v1/traces";

// A serializer that writes the items as a JSON array, standing in for the upstream ones
const serializer = {
  serializeRequest: (items: string[]): Uint8Array =>
    new TextEncoder().encode(JSON.stringify(items)),
};

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
const warn = vi.fn();

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response(null, { status: 200 })),
  );
  vi.stubGlobal("fetch", fetchMock);
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
  vi.useRealTimers();
  warn.mockReset();
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

async function gunzip(body: BodyInit | null | undefined): Promise<string> {
  const stream = new Blob([body as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

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

test("posts the gzip-compressed serialized body with the key, without keepalive while visible", async () => {
  expect(
    await exportItems(new OtlpJsonExporter(URL_, "key-1", serializer), ["a"]),
  ).toBe(0);

  const [url, init] = fetchMock.mock.calls[0] ?? [];
  expect(url).toBe(URL_);
  expect(init).toMatchObject({
    method: "POST",
    keepalive: false,
    headers: {
      authorization: "key-1",
      "content-type": "application/json",
      "content-encoding": "gzip",
    },
  });
  expect(await gunzip(init?.body)).toBe('["a"]');
});

test("asks for keepalive while the page is hidden", async () => {
  setHidden();

  await exportItems(new OtlpJsonExporter(URL_, undefined, serializer), ["a"]);

  expect(fetchMock.mock.calls[0]?.[1]?.keepalive).toBe(true);
});

test("reports success and settles after a collector never answers", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fetchMock.mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason as Error);
        });
      }),
  );
  const exporter = new OtlpJsonExporter(URL_, undefined, serializer);

  const exported = exportItems(exporter, ["a"]);
  await vi.waitFor(() => {
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  await vi.advanceTimersByTimeAsync(10_000);

  expect(await exported).toBe(0);

  await exporter.forceFlush();
  await exporter.shutdown();

  expect(warn).toHaveBeenCalledOnce();
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
  const respond = holdResponses();
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
