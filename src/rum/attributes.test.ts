import {
  LoggerProvider,
  type ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import { afterEach, expect, test } from "vitest";
import {
  attributesLogRecordProcessor,
  attributesSpanProcessor,
  setAttributes,
} from "./attributes.ts";

const records: ReadableLogRecord[] = [];
const logger = new LoggerProvider({
  processors: [
    attributesLogRecordProcessor,
    {
      onEmit: (r) => records.push(r),
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    },
  ],
}).getLogger("test");
const tracer = new TracerProvider({
  spanProcessors: [attributesSpanProcessor],
}).getTracer("test");

function spanAttributes(attributes?: Record<string, string>): unknown {
  const span = tracer.startSpan("s", attributes ? { attributes } : {});
  span.end();

  return (span as unknown as { attributes: unknown }).attributes;
}

afterEach(() => {
  setAttributes(null);
  records.length = 0;
});

test("setAttributes adds its attributes to later records, replacing the previous set", () => {
  setAttributes({ "app.team.name": "core", "app.plan": "pro" });
  logger.emit({});

  expect(spanAttributes()).toEqual({
    "app.team.name": "core",
    "app.plan": "pro",
  });

  setAttributes({ "app.plan": "free" });
  logger.emit({});
  setAttributes(null);
  logger.emit({});

  expect(records.map((r) => r.attributes)).toEqual([
    { "app.team.name": "core", "app.plan": "pro" },
    { "app.plan": "free" },
    {},
  ]);
});

test("never replaces an attribute the record already has", () => {
  setAttributes({ "user.id": "custom", "app.team.name": "core" });
  logger.emit({ attributes: { "user.id": "user-1" } });

  expect(records[0]?.attributes).toEqual({
    "user.id": "user-1",
    "app.team.name": "core",
  });
  expect(spanAttributes({ "user.id": "user-1" })).toEqual({
    "user.id": "user-1",
    "app.team.name": "core",
  });
});
