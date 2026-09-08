import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

const defaultExecutablePath = "D:/Download/Softwares/Broswers/chromium-debug/chrome.exe";
const executablePath = process.env.DSH_BROWSER_EXECUTABLE
  ?? (existsSync(defaultExecutablePath) ? defaultExecutablePath : undefined);

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.mjs",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [["line"], ["json", { outputFile: "test-results/results.json" }]],
  outputDir: "test-results/artifacts",
  use: {
    headless: true,
    launchOptions: executablePath ? { executablePath } : {},
    locale: "zh-CN",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off"
  }
});
