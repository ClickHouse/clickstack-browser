import {
  LoggerProvider,
  type ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { logs } from "../logs-api.ts";
import {
  consoleExceptionProcessor,
  exceptionAttributes,
  listenForResourceErrors,
  recordException,
  serializeConsoleArgs,
} from "./exceptions.ts";

let records: ReadableLogRecord[] = [];

beforeEach(() => {
  records = [];
  logs.setGlobalLoggerProvider(
    new LoggerProvider({
      processors: [
        {
          onEmit: (r) => records.push(r),
          forceFlush: () => Promise.resolve(),
          shutdown: () => Promise.resolve(),
        },
      ],
    }),
  );
});

afterEach(() => {
  logs.disable();
  document.body.innerHTML = "";
});

test("errors give their type, message and stack; other values become JSON text", () => {
  const error = new TypeError("bad input");
  const circular: Record<string, unknown> = {};
  circular["self"] = circular;

  expect(exceptionAttributes(error)).toEqual({
    "exception.type": "TypeError",
    "exception.message": "bad input",
    "exception.stacktrace": error.stack,
  });
  expect(
    exceptionAttributes({ name: "Error", message: "from a frame", stack: "s" }),
  ).toEqual({
    "exception.type": "Error",
    "exception.message": "from a frame",
    "exception.stacktrace": "s",
  });
  expect(exceptionAttributes({ stack: "only a stack" })).toEqual({
    "exception.stacktrace": "only a stack",
  });
  expect(exceptionAttributes("failed")).toEqual({
    "exception.message": "failed",
  });
  expect(exceptionAttributes({ code: 1 })).toEqual({
    "exception.message": '{"code":1}',
  });
  expect(exceptionAttributes(42)).toEqual({ "exception.message": "42" });
  expect(exceptionAttributes(undefined)).toEqual({
    "exception.message": "undefined",
  });
  expect(exceptionAttributes(circular)).toEqual({
    "exception.message": "[object Object]",
  });
});

test("appends the cause chain to the stack as Caused by sections", () => {
  const cause = new TypeError("Failed to fetch");
  const error = new Error("Checkout failed", { cause });
  const stack = String(exceptionAttributes(error)["exception.stacktrace"]);

  expect(stack.startsWith(String(error.stack))).toBe(true);
  expect(stack).toContain(`\nCaused by: ${String(cause.stack)}`);
});

test("names frames-only causes, writes other causes as JSON, and stops at a loop or five causes", () => {
  const framesOnly = Object.assign(new TypeError("Failed to fetch"), {
    stack: "fetchCart@app.js:42:9",
  });
  expect(
    exceptionAttributes({
      message: "outer",
      stack: "outer@app.js:1:1",
      cause: framesOnly,
    })["exception.stacktrace"],
  ).toBe(
    "outer@app.js:1:1\nCaused by: TypeError: Failed to fetch\nfetchCart@app.js:42:9",
  );
  expect(
    exceptionAttributes({ message: "outer", cause: { code: 1 } })[
      "exception.stacktrace"
    ],
  ).toBe('Error: outer\nCaused by: {"code":1}');

  const a: Record<string, unknown> = { name: "A", message: "a", stack: "A: a" };
  a["cause"] = { name: "B", message: "b", stack: "B: b", cause: a };
  expect(exceptionAttributes(a)["exception.stacktrace"]).toBe(
    "A: a\nCaused by: B: b",
  );

  let deep: Record<string, unknown> = { message: "7", stack: "S7" };
  for (let i = 6; i >= 1; i--) {
    deep = { message: String(i), stack: `S${String(i)}`, cause: deep };
  }
  expect(
    String(exceptionAttributes(deep)["exception.stacktrace"]).split(
      "Caused by:",
    ),
  ).toHaveLength(6);
});

test("a console record gets exception attributes from an error argument, and no other record does", () => {
  const consoleRecords: ReadableLogRecord[] = [];
  const logger = new LoggerProvider({
    processors: [
      consoleExceptionProcessor,
      {
        onEmit: (r) => consoleRecords.push(r),
        forceFlush: () => Promise.resolve(),
        shutdown: () => Promise.resolve(),
      },
    ],
  }).getLogger("test");

  expect(serializeConsoleArgs(["failed:", new Error("boom")])).toMatch(
    /^failed: Error: boom\n/,
  );
  logger.emit({ eventName: "browser.console" });
  serializeConsoleArgs(["plain text", { message: "an API response" }]);
  logger.emit({ eventName: "browser.console" });
  serializeConsoleArgs([new Error("not a console record")]);
  logger.emit({ eventName: "other" });
  logger.emit({ eventName: "browser.console" });

  expect(consoleRecords.map((r) => r.attributes["exception.message"])).toEqual([
    "boom",
    undefined,
    undefined,
    undefined,
  ]);
  expect(consoleRecords[0]?.attributes["exception.type"]).toBe("Error");
});

test("recordException emits an exception event with the given attributes", () => {
  recordException(new Error("boom"), { "app.operation": "checkout" });

  expect(records).toHaveLength(1);
  expect(records[0]?.eventName).toBe("exception");
  expect(records[0]?.severityNumber).toBe(17);
  expect(records[0]?.attributes).toMatchObject({
    "exception.type": "Error",
    "exception.message": "boom",
    "app.operation": "checkout",
  });
});

test("failed resource loads become ResourceLoadError events until the listener is removed", async () => {
  const stop = listenForResourceErrors((url) =>
    url.replace(location.origin, "https://example.clickhouse.com"),
  );
  const image = document.createElement("img");
  image.src = "/missing-image.png";
  document.body.append(image);

  await vi.waitFor(() => {
    expect(records).toHaveLength(1);
  });

  expect(records[0]?.attributes).toEqual({
    "exception.type": "ResourceLoadError",
    "exception.message":
      "Failed to load <img> https://example.clickhouse.com/missing-image.png",
    "url.full": "https://example.clickhouse.com/missing-image.png",
  });

  stop();
  const second = document.createElement("img");
  const failed = new Promise((resolve) => {
    second.addEventListener("error", resolve);
  });
  second.src = "/missing-image-2.png";
  document.body.append(second);
  await failed;

  expect(records).toHaveLength(1);
});

test("records failed scripts, stylesheets and media, and ignores errors without a resource URL", async () => {
  const stop = listenForResourceErrors(undefined);
  const script = Object.assign(document.createElement("script"), {
    src: "/missing.js",
  });
  const link = Object.assign(document.createElement("link"), {
    rel: "stylesheet",
    href: "/missing.css",
  });
  const video = Object.assign(document.createElement("video"), {
    src: "/missing.mp4",
  });
  const div = document.createElement("div");
  document.body.append(script, link, video, div);
  div.dispatchEvent(new Event("error"));
  document.dispatchEvent(new Event("error"));

  await vi.waitFor(
    () => {
      expect(records).toHaveLength(3);
    },
    { timeout: 5000 },
  );

  stop();

  expect(records.map((r) => r.attributes["url.full"]).sort()).toEqual([
    `${location.origin}/missing.css`,
    `${location.origin}/missing.js`,
    `${location.origin}/missing.mp4`,
  ]);
});

test("leaves the URL out when sanitizeUrl returns an empty string", async () => {
  const stop = listenForResourceErrors(() => "");
  const image = document.createElement("img");
  image.src = "/missing-image-3.png";
  document.body.append(image);

  await vi.waitFor(() => {
    expect(records).toHaveLength(1);
  });

  stop();

  expect(records[0]?.attributes).toEqual({
    "exception.type": "ResourceLoadError",
    "exception.message": "Failed to load <img>",
  });
});
