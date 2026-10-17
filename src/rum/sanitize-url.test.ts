import { diag } from "@opentelemetry/api";
import {
  LoggerProvider,
  type ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import { afterEach, expect, test, vi } from "vitest";
import {
  createUrlSanitizerLogRecordProcessor,
  guardSanitizeUrl,
} from "./sanitize-url.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

test("the guard returns the hook result, or an empty URL when the hook fails", () => {
  const warn = vi.spyOn(diag, "warn");
  const sanitize = guardSanitizeUrl((url) => {
    if (url.includes("throw")) {
      throw new Error("bad hook");
    }

    return url.includes("number")
      ? (1 as unknown as string)
      : url.replace(/\?.*/, "");
  });

  expect(sanitize("https://example.clickhouse.com/a?token=1")).toBe(
    "https://example.clickhouse.com/a",
  );
  expect(sanitize("https://example.clickhouse.com/throw")).toBe("");
  expect(sanitize("https://example.clickhouse.com/throw")).toBe("");
  expect(sanitize("https://example.clickhouse.com/number")).toBe("");
  expect(warn).toHaveBeenCalledOnce();
});

test("the processor rewrites url.full on timing events only", () => {
  const records: ReadableLogRecord[] = [];
  const provider = new LoggerProvider({
    processors: [
      createUrlSanitizerLogRecordProcessor(
        () => "https://example.clickhouse.com/sanitized",
      ),
      {
        onEmit: (r) => records.push(r),
        forceFlush: () => Promise.resolve(),
        shutdown: () => Promise.resolve(),
      },
    ],
  });
  const logger = provider.getLogger("test");
  const attributes = { "url.full": "https://example.clickhouse.com/a?token=1" };

  logger.emit({ eventName: "browser.resource_timing", attributes });
  logger.emit({ eventName: "browser.navigation_timing", attributes });
  logger.emit({ eventName: "browser.navigation", attributes });
  logger.emit({ attributes });

  expect(records.map((r) => r.attributes["url.full"])).toEqual([
    "https://example.clickhouse.com/sanitized",
    "https://example.clickhouse.com/sanitized",
    "https://example.clickhouse.com/a?token=1",
    "https://example.clickhouse.com/a?token=1",
  ]);
});
