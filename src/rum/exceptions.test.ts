import {
  LoggerProvider,
  type ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { logs } from "../logs-api.ts";
import {
  exceptionAttributes,
  listenForResourceErrors,
  recordException,
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
