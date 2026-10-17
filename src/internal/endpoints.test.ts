import { expect, test } from "vitest";
import { signalUrl } from "./endpoints.ts";

test("appends the signal path to the endpoint path", () => {
  expect(signalUrl("https://collector.example.com:4318", "traces")).toBe(
    "https://collector.example.com:4318/v1/traces",
  );
  expect(signalUrl("https://collector.example.com/otel/", "logs")).toBe(
    "https://collector.example.com/otel/v1/logs",
  );
});

test("resolves a relative endpoint against the page", () => {
  expect(signalUrl("/otel", "logs")).toBe(`${location.origin}/otel/v1/logs`);
});

test("rejects empty and non-http endpoints", () => {
  expect(signalUrl("", "logs")).toBeUndefined();
  expect(signalUrl(undefined, "logs")).toBeUndefined();
  expect(signalUrl("ftp://collector.example.com", "logs")).toBeUndefined();
  expect(signalUrl("http://[", "logs")).toBeUndefined();
});
