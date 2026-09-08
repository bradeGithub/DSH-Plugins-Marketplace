#!/usr/bin/env node
// 测试金字塔统一运行器：unit → integration → e2e 逐层执行，层内文件并行。
// 用法：
//   node scripts/tests/run.mjs               全部三层
//   node scripts/tests/run.mjs --level=unit  仅单元
//   node scripts/tests/run.mjs --level=integration
//   node scripts/tests/run.mjs --level=e2e
// 每层失败即退出非零；--json 输出结构化结果（CI 用）。
//
// 并行：层内文件用并发池（unit 默认 4，integration 默认 2，e2e 默认 1；DSH_TEST_CONCURRENCY 可覆盖），
// 层间保持 unit → integration → e2e 顺序。integration/e2e fork 真实 pnpm/git/npm 子进程，低并发防 CI OOM。
// 每个子测试在未显式设置 DRIFT_REPORT_FILE 时获得独立的临时报告路径（避免并行写同一文件竞争）；显式设置时原样透传（调用方持有）。

import { spawn } from "node:child_process";
import { readdirSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TESTS = join(ROOT, "scripts", "tests");
const LEVELS = ["unit", "integration", "e2e"];
const levelArg = process.argv.find((a) => a.startsWith("--level="));
const level = levelArg ? levelArg.split("=")[1] : "all";
const jsonOut = process.argv.includes("--json");
// 并发池大小按层区分：unit 轻量可高并发；integration/e2e fork 真实子进程（pnpm/git/npm），
// 并发过高会在 CI 低内存 runner 上 OOM-kill 父进程（并行化的间歇性失败），默认降为 2/1。
// 环境变量 DISH_TEST_CONCURRENCY 可整体覆盖（单值应用全部层）。
const DEFAULT_CONCURRENCY = { unit: 4, integration: 2, e2e: 1 };
const envConcurrency = Number(process.env.DSH_TEST_CONCURRENCY);
const concurrencyFor = (lv) => (Number.isFinite(envConcurrency) && envConcurrency > 0 ? envConcurrency : (DEFAULT_CONCURRENCY[lv] ?? 2));

const levelList = level === "all" ? LEVELS : level.split(",").map((s) => s.trim()).filter(Boolean);
for (const lv of levelList) {
  if (!LEVELS.includes(lv)) {
    console.error(`未知层级 "${lv}"，可选: all | ${LEVELS.join(" | ")}`);
    process.exit(1);
  }
}
const targets = levelList;
let ownedDriftDir = null;
const explicitDrift = process.env.DRIFT_REPORT_FILE;
if (explicitDrift === undefined) {
  ownedDriftDir = mkdtempSync(join(tmpdir(), "dsh-runner-drift-"));
}

// 每文件超时（防死锁：spawn 无超时会永久挂住整个运行器——测试文件内若有未关闭的
// handle/等待不来的事件，进程不退出即卡死。超时后子进程被终止，该文件标记失败并
// 继续下一文件，不阻塞后续层）。unit/integration 各文件秒级，e2e 含真实 npm install 放宽。
const FILE_TIMEOUT_MS = { unit: 120_000, integration: 180_000, e2e: 600_000 };

/** 子测试环境：显式 DRIFT_REPORT_FILE 原样透传；否则给每个文件独立临时报告路径。 */
function childEnvFor(file) {
  if (explicitDrift !== undefined) return { ...process.env, DRIFT_REPORT_FILE: explicitDrift };
  return { ...process.env, DRIFT_REPORT_FILE: join(ownedDriftDir, file + ".json") };
}

/** 运行单个测试文件，返回 { level, file, ok, timedOut, duration }。 */
function runFile(lv, file) {
  return new Promise((resolve) => {
    const start = Date.now();
    // --json 模式下抑制子测试 stdout/stderr（其自带的 "N passed"、漂移 warning 等
    // 会污染 JSON 输出，CI 解析失败）；非 json 模式全量透传便于本地诊断。
    const child = spawn("node", [join(TESTS, lv, file)], {
      cwd: ROOT,
      env: childEnvFor(file),
      stdio: jsonOut ? ["inherit", "ignore", "ignore"] : "inherit",
      windowsHide: true,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, FILE_TIMEOUT_MS[lv] ?? 300_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ level: lv, file, ok: false, timedOut: false, duration: Date.now() - start, error: err });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ level: lv, file, ok: code === 0, timedOut, duration: Date.now() - start });
    });
  });
}

/** 运行一层：并发池内并行执行该层所有文件，返回结果数组（文件顺序）。 */
async function runLevel(lv) {
  const dir = join(TESTS, lv);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".test.mjs") || f.endsWith(".e2e.mjs")).sort();
  const results = [];
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrencyFor(lv), files.length) }, async () => {
    while (idx < files.length) {
      const file = files[idx++];
      const r = await runFile(lv, file);
      results.push(r);
      if (!jsonOut) {
        const tag = r.ok ? "[OK]" : "[FAIL]";
        const timeoutNote = r.timedOut ? ` —— 超时（${(FILE_TIMEOUT_MS[lv] ?? 300_000) / 1000}s 未结束，疑似死锁，已终止）` : "";
        console.log(`${tag} [${lv}] ${file} (${(r.duration / 1000).toFixed(1)}s)${timeoutNote}`);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

const allResults = [];
let failed = false;
for (const lv of targets) {
  const results = await runLevel(lv);
  allResults.push(...results);
  if (results.some((r) => !r.ok)) failed = true;
}

if (jsonOut) {
  // 按层序 + 文件名排序，保证 CI 输出确定性（并行完成顺序不定）。
  const levelIndex = (lv) => LEVELS.indexOf(lv);
  const sorted = [...allResults].sort((a, b) => levelIndex(a.level) - levelIndex(b.level) || a.file.localeCompare(b.file));
  console.log(JSON.stringify({ ok: !failed, results: sorted }, null, 2));
} else {
  const total = allResults.length;
  const ok = allResults.filter((r) => r.ok).length;
  console.log(`\n测试金字塔: ${ok}/${total} 通过`);
  const bad = allResults.filter((r) => !r.ok);
  if (bad.length > 0) {
    console.log(`失败文件（${bad.length}）:`);
    for (const r of bad) console.log(`  [${r.level}] ${r.file} (${(r.duration / 1000).toFixed(1)}s)`);
  }
}

// 清理测试在 %TEMP%（C 盘）留下的临时目录/文件（失败不阻塞测试结果）
try {
  const { execFileSync } = await import("node:child_process");
  execFileSync(process.execPath, [join(TESTS, "cleanup.mjs")], {
    cwd: ROOT,
    stdio: jsonOut ? "ignore" : "inherit",
  });
} catch {
  if (!jsonOut) console.error("[cleanup] 清理脚本执行失败（不影响测试结果）");
} finally {
  if (ownedDriftDir) {
    try {
      rmSync(ownedDriftDir, { recursive: true, force: true });
    } catch {
      // 临时诊断目录清理失败不覆盖原测试结果。
    }
  }
}
process.exit(failed ? 1 : 0);
