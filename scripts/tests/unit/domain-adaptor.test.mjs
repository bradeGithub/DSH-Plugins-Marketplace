import assert from "node:assert/strict";
import { createAdaptorRules } from "../../../lib/domain/adaptor.js";

const normalizeCalls = [];
const normalizeRepo = (repo) => {
  normalizeCalls.push(repo);
  return { ...repo, normalized: true };
};

const rules = createAdaptorRules({
  redirects: [
    { from: "owner/wrong", to: "owner/real-old", meta: { full_name: "owner/real-old", name: "old" } },
    { from: "owner/wrong", to: "owner/real", meta: { full_name: "owner/real", name: "real" } },
    { from: "owner/other", to: "owner/target", meta: { full_name: "owner/target", name: "target" } },
    null,
    { from: "bad/from", to: 42 },
    { from: 42, to: "bad/to" },
  ],
  normalizeRepo,
});

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

await test("合法 redirect 过滤并保持重复 from 的最后规则", () => {
  assert.equal(rules.adaptorRedirectRepo("owner/wrong"), "owner/real");
  assert.equal(rules.adaptorRedirectRepo("owner/other"), "owner/target");
  // 大小写漂移：GitHub 仓库名大小写不敏感——map 键与查询统一小写归一后必须命中
  assert.equal(rules.adaptorRedirectRepo("Owner/wrong"), "owner/real");
  assert.equal(rules.adaptorRedirectRepo("OWNER/WRONG"), "owner/real");
  assert.equal(rules.adaptorRedirectRepo("bad/from"), null);
  assert.equal(rules.adaptorRedirectRepo(null), null);
  const nullishRules = createAdaptorRules({
    redirects: [{ from: "", to: "empty-target" }],
    normalizeRepo,
  });
  assert.equal(nullishRules.adaptorRedirectRepo(null), "empty-target");
  assert.equal(nullishRules.adaptorRedirectRepo(undefined), "empty-target");
});

await test("列表移除 from、补入 meta 且不重复已有 target", () => {
  normalizeCalls.length = 0;
  const input = [
    { full_name: "owner/wrong", name: "wrong" },
    { full_name: "owner/target", name: "already-present" },
    { full_name: "unrelated/repo", name: "repo" },
  ];
  const before = structuredClone(input);
  const result = rules.applyAdaptorList(input);

  assert.deepEqual(input, before);
  assert.deepEqual(result.map((repo) => repo.full_name), ["owner/target", "unrelated/repo", "owner/real-old", "owner/real"]);
  assert.equal(result.find((repo) => repo.full_name === "owner/real").normalized, true);
  assert.deepEqual(normalizeCalls, [
    { full_name: "owner/real-old", name: "old" },
    { full_name: "owner/real", name: "real" },
  ]);
});

await test("非数组和空规则保持输入身份", () => {
  assert.equal(rules.applyAdaptorList(null), null);
  const value = [{ full_name: "owner/repo" }];
  const empty = createAdaptorRules({ redirects: [], normalizeRepo });
  assert.equal(empty.applyAdaptorList(value), value);
});

await test("缺失 meta.full_name 不会补入列表", () => {
  const local = createAdaptorRules({
    redirects: [{ from: "owner/wrong", to: "owner/real", meta: { name: "real" } }],
    normalizeRepo,
  });
  const result = local.applyAdaptorList([{ full_name: "owner/wrong" }]);
  assert.deepEqual(result, []);
});

await test("map 键大小写混合时小写查询命中，列表过滤与去重同款归一", () => {
  const local = createAdaptorRules({
    redirects: [{
      from: "Owner/Mixed-Case",
      to: "owner/real",
      meta: { full_name: "Owner/Real", name: "real" },
    }],
    normalizeRepo,
  });
  // from 是大写键：任意大小写形态的查询都应命中重定向
  assert.equal(local.adaptorRedirectRepo("owner/mixed-case"), "owner/real");
  assert.equal(local.adaptorRedirectRepo("OWNER/MIXED-CASE"), "owner/real");
  // 列表 full_name 大小写漂移（Owner/Mixed-Case vs OWNER/mixed-case）→ 仍按 from 移除
  const result = local.applyAdaptorList([
    { full_name: "OWNER/mixed-case", name: "drifted" },
    { full_name: "owner/real", name: "present" },
    { full_name: "keep/this", name: "keep" },
  ]);
  // meta.full_name 是 Owner/Real，列表已有 owner/real（小写形态）→ 去重不重复补入
  assert.deepEqual(result.map((repo) => repo.full_name), ["owner/real", "keep/this"]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
