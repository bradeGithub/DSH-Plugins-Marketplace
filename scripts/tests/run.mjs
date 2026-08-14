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

if (level !== "all" && !LEVELS.includes(level)) {
  console.error(`未知层级 "${level}"，可选: all | ${LEVELS.join(" | ")}`);
  process.exit(1);
}
const targets = level === "all" ? LEVELS : [level];

const results = [];
let failed = false;
for (const lv of targets) {
  const dir = join(TESTS, lv);
  if (!existsSync(dir)) continue;
  const files = readdirSync(dir).filter((f) => f.endsWith(".test.mjs") || f.endsWith(".e2e.mjs")).sort();
  for (const f of files) {
    try {
      execFileSync("node", [join(dir, f)], { cwd: ROOT, stdio: "inherit" });
      results.push({ level: lv, file: f, ok: true });
      if (!jsonOut) console.log(`[OK] [${lv}] ${f}`);
    } catch (e) {
      failed = true;
      results.push({ level: lv, file: f, ok: false });
      if (!jsonOut) console.error(`[FAIL] [${lv}] ${f}`);
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
process.exit(failed ? 1 : 0);
