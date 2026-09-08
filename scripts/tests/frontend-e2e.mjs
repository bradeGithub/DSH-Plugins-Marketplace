#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BROWSER_ROOT = join(ROOT, "scripts", "tests", "browser");
const PLAYWRIGHT_MODULE = join(BROWSER_ROOT, "node_modules", "@playwright", "test", "index.mjs");
const PLAYWRIGHT_CLI = join(BROWSER_ROOT, "node_modules", "@playwright", "test", "cli.js");
const defaultExecutablePath = "D:/Download/Softwares/Broswers/chromium-debug/chrome.exe";
const configuredExecutable = process.env.DSH_BROWSER_EXECUTABLE;
const executable = configuredExecutable ?? (existsSync(defaultExecutablePath) ? defaultExecutablePath : null);

function fail(message) {
  console.error(`[frontend-e2e] ${message}`);
  console.log(JSON.stringify({ ok: false, suite: "frontend-e2e", error: message }));
  process.exit(1);
}

if (!existsSync(PLAYWRIGHT_MODULE) || !existsSync(PLAYWRIGHT_CLI)) {
  fail("测试依赖缺失，请先在 scripts/tests/browser 执行 npm ci");
}
if (configuredExecutable && !existsSync(configuredExecutable)) {
  fail(`浏览器可执行文件不存在: ${configuredExecutable}`);
}

const result = spawnSync(process.execPath, [
  PLAYWRIGHT_CLI,
  "test",
  "--config=playwright.config.mjs",
  ...process.argv.slice(2)
], {
  cwd: BROWSER_ROOT,
  env: { ...process.env },
  stdio: "inherit",
  windowsHide: true
});

const ok = result.status === 0;
console.log(JSON.stringify({
  ok,
  suite: "frontend-e2e",
  exitCode: result.status,
  signal: result.signal ?? null,
  browser: executable ?? "playwright-managed",
  config: "scripts/tests/browser/playwright.config.mjs"
}));
process.exit(ok ? 0 : 1);
