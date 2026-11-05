import { expect, test } from "vitest";
import { hasSignalPath, resolveUrl, signalUrl } from "./endpoints.ts";

test("appends the signal path to the endpoint path", () => {
  expect(
    signalUrl("https://example-collector.clickhouse.com:4318", "traces"),
  ).toBe("https://example-collector.clickhouse.com:4318/v1/traces");
  expect(
    signalUrl("https://example-collector.clickhouse.com/otel/", "logs"),
  ).toBe("https://example-collector.clickhouse.com/otel/v1/logs");
});

test("resolves a relative endpoint against the page", () => {
  expect(signalUrl("/otel", "logs")).toBe(`${location.origin}/otel/v1/logs`);
});

test("rejects empty and non-http endpoints", () => {
  expect(signalUrl("", "logs")).toBeUndefined();
  expect(signalUrl(undefined, "logs")).toBeUndefined();
  expect(
    signalUrl("ftp://example-collector.clickhouse.com", "logs"),
  ).toBeUndefined();
  expect(signalUrl("http://[", "logs")).toBeUndefined();
});

test("drops a signal path the endpoint already ends with", () => {
  expect(
    signalUrl("https://example-collector.clickhouse.com/v1/traces", "traces"),
  ).toBe("https://example-collector.clickhouse.com/v1/traces");
  expect(
    signalUrl(
      "https://example-collector.clickhouse.com/otel/v1/logs/",
      "traces",
    ),
  ).toBe("https://example-collector.clickhouse.com/otel/v1/traces");
  expect(hasSignalPath("/otel/v1/traces")).toBe(true);
  expect(hasSignalPath("/otel")).toBe(false);
  expect(hasSignalPath(undefined)).toBe(false);
});

test("resolves full signal URLs as they are", () => {
  expect(
    resolveUrl("https://example-collector.clickhouse.com/custom/traces#x")
      ?.href,
  ).toBe("https://example-collector.clickhouse.com/custom/traces");
  expect(resolveUrl("/collector/logs")?.href).toBe(
    `${location.origin}/collector/logs`,
  );
  expect(resolveUrl("ftp://example-collector.clickhouse.com")).toBeUndefined();
});
