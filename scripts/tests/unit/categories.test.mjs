// 分类回归测试：audit-expected.json（120 仓库 README 审计期望）中**当前索引内**的条目必须全部命中。
// 规则或 CATEGORY_OVERRIDES 改动后跑本测试，防止分类回归。
// 注意：registry.json 由 CI 定期重建（搜索爬取偶有遗漏），审计条目暂缺时跳过并警告而非失败——
// 索引成员归属是 CI 的职责，本测试只守护「分类规则」这一件事。
// 用法：node scripts/tests/unit/categories.test.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyRepo, applyInstallability } from "../../build-registry.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const registry = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"));
const audit = JSON.parse(readFileSync(join(ROOT, "audit-expected.json"), "utf8"));

const byName = new Map(registry.repos.map((r) => [r.full_name, r]));
const entries = Object.entries(audit);
let pass = 0;
let skipped = 0;
const failed = [];

for (const [fullName, expected] of entries) {
  const repo = byName.get(fullName);
  if (!repo) {
    skipped++;
    console.warn(`  跳过（不在当前索引）: ${fullName}`);
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
console.log(`PASS 分类审计: ${pass}/${entries.length} 命中（${skipped} 条暂缺跳过）`);

// 可安装性盖章回归：pkg-plain → non-plugin、manual → manual、其余不写字段、报告缺失条目清旧章。
{
  const verdicts = new Map([
    ["a/pkg", "cordis-plugin"],
    ["b/plain", "pkg-plain"],
    ["c/man", "manual"],
    ["d/skill", "skill"]
  ]);
  const repos = [
    { full_name: "a/pkg" },
    { full_name: "b/plain" },
    { full_name: "c/man" },
    { full_name: "d/skill" },
    { full_name: "e/none", installable: "manual" } // 报告外条目 → 清除旧章
  ];
  applyInstallability(repos, verdicts);
  const expect = { "a/pkg": undefined, "b/plain": "non-plugin", "c/man": "manual", "d/skill": undefined, "e/none": undefined };
  const bad = repos.filter((r) => r.installable !== expect[r.full_name]);
  if (bad.length > 0) {
    console.error(`可安装性盖章失败: ${JSON.stringify(bad)}`);
    process.exit(1);
  }
  console.log(`PASS 可安装性盖章: ${repos.length}/${repos.length} 条符合预期`);
}
