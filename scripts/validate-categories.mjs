#!/usr/bin/env node
// 分类规则验证：用审计的 120 个仓库期望分类，对比当前 classifyRepo 的产出。
// 用法：node scripts/validate-categories.mjs [audit-expected.json]
import { readFileSync } from "node:fs";
import { classifyRepo, categoryText } from "./build-registry.mjs";

const expected = JSON.parse(readFileSync(process.argv[2] ?? "audit-expected.json", "utf8"));
const registry = JSON.parse(readFileSync("registry.json", "utf8")).repos;
const byName = new Map(registry.map((r) => [r.full_name, r]));

let correct = 0;
const mismatches = [];
for (const [full, want] of Object.entries(expected)) {
  const repo = byName.get(full);
  if (!repo) { console.log(`缺失: ${full}`); continue; }
  const got = classifyRepo(repo);
  if (got === want) correct++;
  else mismatches.push({ full, got, want, desc: String(repo.description ?? "").slice(0, 50) });
}
const total = Object.keys(expected).length;
console.log(`准确率: ${correct}/${total} = ${(correct / total * 100).toFixed(1)}%`);
console.log("\n错分明细:");
for (const m of mismatches) {
  const repo = byName.get(m.full);
  console.log(`  ${m.full}: 实际=${m.got} 期望=${m.want}`);
  if (process.env.DEBUG) console.log(`    文本: ${categoryText(repo).slice(0, 400)}`);
}
process.exit(mismatches.length > 0 ? 1 : 0);
