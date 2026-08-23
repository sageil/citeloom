import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  expect: {
    timeout: 5_000,
  },
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  outputDir: join(tmpdir(), "citeloom-playwright-test-results"),
  reporter: process.env.CI ? "github" : "line",
  retries: 0,
  testDir: "./browser-tests",
  timeout: 30_000,
  use: {
    trace: "retain-on-failure",
  },
  workers: 1,
});
