// 分类回归测试：120 仓库 README 审计期望（audit-expected.json）必须全部命中。
// 规则或 CATEGORY_OVERRIDES 改动后跑本测试，防止分类回归。
// 用法：node scripts/tests/unit/categories.test.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyRepo } from "../../build-registry.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const registry = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"));
const audit = JSON.parse(readFileSync(join(ROOT, "audit-expected.json"), "utf8"));

const byName = new Map(registry.repos.map((r) => [r.full_name, r]));
const entries = Object.entries(audit);
let pass = 0;
const failed = [];

for (const [fullName, expected] of entries) {
  const repo = byName.get(fullName);
  if (!repo) {
    failed.push(`${fullName}: 审计条目在 registry.json 中缺失`);
    continue;
  }
  const actual = classifyRepo(repo);
  if (actual === expected) pass++;
  else failed.push(`${fullName}: 实际=${actual} 期望=${expected}`);
}

if (failed.length > 0) {
  console.error(`分类回归失败 ${failed.length}/${entries.length}:`);
  for (const line of failed) console.error("  " + line);
  process.exit(1);
}
console.log(`PASS 分类审计: ${pass}/${entries.length} 全部命中`);
