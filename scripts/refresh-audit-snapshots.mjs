// audit-expected.json 快照维护工具：
// 把每条审计条目的 desc/topics 快照刷新为**当前 registry.json** 的元数据基线。
//
// 使用时机（漂移复审闭环）：
//   1. 分类器被作者新简介误导 → 在 build-registry.mjs 加 CATEGORY_OVERRIDES 钉住分类；
//   2. 审计期望过时（作者重写简介后分类器分对了）→ 改 audit-expected.json 的 expected；
//   3. 两者任一做完后跑本脚本，把快照刷新到当前元数据——之后作者再改简介才再次触发漂移。
//
// 快照语义见 scripts/tests/unit/categories.test.mjs 头部注释（三层判定：
// 同输入输出变=规则回归硬失败；输入变=漂移不失败，进 drift-report 待复审）。
import { readFileSync, writeFileSync } from "node:fs";

const audit = JSON.parse(readFileSync("audit-expected.json", "utf8"));
const registry = JSON.parse(readFileSync("registry.json", "utf8"));
const byName = new Map(registry.repos.map((r) => [r.full_name, r]));

const out = {};
let withSnapshot = 0, without = 0;
for (const [fullName, entry] of Object.entries(audit)) {
  const expected = typeof entry === "string" ? entry : entry.expected;
  const repo = byName.get(fullName);
  if (repo && repo.description != null && Array.isArray(repo.topics)) {
    out[fullName] = { expected, desc: repo.description, topics: [...repo.topics].sort() };
    withSnapshot++;
  } else {
    // 不在当前索引 / desc 为 null：只留期望（测试对无快照条目：输出一致即命中，不一致按漂移处理）
    out[fullName] = { expected };
    without++;
  }
}

writeFileSync("audit-expected.json", JSON.stringify(out, null, 2) + "\n", "utf8");
console.log(`快照已刷新：${withSnapshot} 条带快照，${without} 条无快照（不在当前索引 / desc 为 null）`);
