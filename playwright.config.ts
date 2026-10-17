import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  testMatch: "replay.spec.ts",
  // A committed test.only would silently skip every other test in CI.
  forbidOnly: true,
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
