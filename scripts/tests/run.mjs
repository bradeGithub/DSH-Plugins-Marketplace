#!/usr/bin/env node
// 测试金字塔统一运行器：unit → integration → e2e 逐层执行。
// 用法：
//   node scripts/tests/run.mjs               全部三层
//   node scripts/tests/run.mjs --level=unit  仅单元
//   node scripts/tests/run.mjs --level=integration
//   node scripts/tests/run.mjs --level=e2e
// 每层失败即退出非零；--json 输出结构化结果（CI 用）。

import { execFileSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TESTS = join(ROOT, "scripts", "tests");
const LEVELS = ["unit", "integration", "e2e"];
const levelArg = process.argv.find((a) => a.startsWith("--level="));
const level = levelArg ? levelArg.split("=")[1] : "all";
const jsonOut = process.argv.includes("--json");

const levelList = level === "all" ? LEVELS : level.split(",").map((s) => s.trim()).filter(Boolean);
for (const lv of levelList) {
  if (!LEVELS.includes(lv)) {
    console.error(`未知层级 "${lv}"，可选: all | ${LEVELS.join(" | ")}`);
    process.exit(1);
  }
}
const targets = levelList;

const results = [];
let failed = false;
// 每文件超时（防死锁：execFileSync 无超时会永久挂住整个运行器——测试文件内
// 若有未关闭的 handle/等待不来的事件，进程不退出即卡死。超时后子进程被终止，
// 该文件标记失败并继续下一文件，不阻塞后续层）。unit/integration 各文件秒级，
// e2e 含真实 npm install 放宽。
const FILE_TIMEOUT_MS = { unit: 120_000, integration: 180_000, e2e: 600_000 };
for (const lv of targets) {
  const dir = join(TESTS, lv);
  if (!existsSync(dir)) continue;
  const files = readdirSync(dir).filter((f) => f.endsWith(".test.mjs") || f.endsWith(".e2e.mjs")).sort();
  for (const f of files) {
    try {
      execFileSync("node", [join(dir, f)], { cwd: ROOT, stdio: "inherit", timeout: FILE_TIMEOUT_MS[lv] ?? 300_000 });
      results.push({ level: lv, file: f, ok: true });
      if (!jsonOut) console.log(`[OK] [${lv}] ${f}`);
    } catch (e) {
      failed = true;
      results.push({ level: lv, file: f, ok: false });
      if (!jsonOut) {
        const isTimeout = typeof e === "object" && e !== null && "killed" in e && e.code === "ETIMEDOUT" && "signal" in e;
        if (isTimeout) console.error(`[FAIL] [${lv}] ${f} —— 超时（${(FILE_TIMEOUT_MS[lv] ?? 300_000) / 1000}s 未结束，疑似死锁，已终止）`);
        else console.error(`[FAIL] [${lv}] ${f}`);
      }
    }
  }
}

if (jsonOut) {
  console.log(JSON.stringify({ ok: !failed, results }, null, 2));
} else {
  const total = results.length;
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n测试金字塔: ${ok}/${total} 通过`);
}

// 清理测试在 %TEMP%（C 盘）留下的临时目录/文件（失败不阻塞测试结果）
try {
  execFileSync(process.execPath, [join(TESTS, "cleanup.mjs")], { cwd: ROOT, stdio: "inherit" });
} catch {
  console.error("[cleanup] 清理脚本执行失败（不影响测试结果）");
}
process.exit(failed ? 1 : 0);
