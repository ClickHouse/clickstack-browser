import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  define: { __CLICKSTACK_VERSION__: JSON.stringify(pkg.version) },
  // Pre-bundled up front: Vite otherwise discovers them during the run and reloads the page, which
  // loads a second copy of @opentelemetry/api in the middle of a test file.
  optimizeDeps: {
    include: [
      "@opentelemetry/api",
      "@opentelemetry/api-logs",
      "@opentelemetry/browser-instrumentation/experimental/console",
      "@opentelemetry/browser-instrumentation/experimental/errors",
      "@opentelemetry/browser-instrumentation/experimental/fetch",
      "@opentelemetry/browser-instrumentation/experimental/navigation",
      "@opentelemetry/browser-instrumentation/experimental/navigation-timing",
      "@opentelemetry/browser-instrumentation/experimental/resource-timing",
      "@opentelemetry/browser-instrumentation/experimental/user-action",
      "@opentelemetry/browser-instrumentation/experimental/web-vitals",
      "@opentelemetry/browser-instrumentation/experimental/xhr",
      "@opentelemetry/browser-sdk",
      "@opentelemetry/browser-sdk/browser-detector",
      "@opentelemetry/browser-sdk/document",
      "@opentelemetry/browser-sdk/session",
      "@opentelemetry/core",
      "@opentelemetry/instrumentation-long-task",
      "@opentelemetry/resources",
      "@opentelemetry/sdk-logs",
      "@opentelemetry/sdk-trace",
      "@opentelemetry/semantic-conventions",
      "@rrweb/record",
    ],
  },
  test: {
    include: ["src/**/*.test.ts"],
    // rrweb and fetch need a real browser, one engine is enough for this package's own logic.
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
      reporter: ["text"],
      thresholds: { lines: 90, branches: 90 },
    },
  },
});
