import assert from "node:assert/strict";
import { createAdaptorAdapter } from "../../../lib/infra/adaptor.js";

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

await test("配置只加载一次并暴露重定向能力", () => {
  let loads = 0;
  const normalized = [];
  const adapter = createAdaptorAdapter({
    loadConfig: () => {
      loads++;
      return {
        redirects: [
          { from: "owner/wrong", to: "owner/real", meta: { full_name: "owner/real", name: "real" } },
          { from: "bad/from", to: null },
        ],
      };
    },
    normalizeRepo: (repo) => {
      normalized.push(repo);
      return { ...repo, marker: "normalized" };
    },
  });

  assert.equal(loads, 1);
  assert.equal(adapter.adaptorRedirectRepo("owner/wrong"), "owner/real");
  assert.deepEqual(adapter.applyAdaptorList([{ full_name: "owner/wrong" }]), [
    { full_name: "owner/real", name: "real", marker: "normalized" },
  ]);
  assert.deepEqual(normalized, [{ full_name: "owner/real", name: "real" }]);
});

await test("配置加载失败时适配层空转且不抛错", () => {
  const adapter = createAdaptorAdapter({
    loadConfig: () => { throw new Error("missing adaptor.json"); },
    normalizeRepo: (repo) => repo,
  });
  const repos = [{ full_name: "owner/repo" }];
  assert.equal(adapter.adaptorRedirectRepo("owner/repo"), null);
  assert.equal(adapter.applyAdaptorList(repos), repos);
});

await test("损坏或非数组配置均回退为空规则", () => {
  for (const value of [null, {}, { redirects: "bad" }, { redirects: [null, { from: 1, to: "x" }] }]) {
    const adapter = createAdaptorAdapter({
      loadConfig: () => value,
      normalizeRepo: (repo) => repo,
    });
    const repos = [{ full_name: "owner/repo" }];
    assert.equal(adapter.adaptorRedirectRepo("owner/repo"), null);
    assert.equal(adapter.applyAdaptorList(repos), repos);
  }
});

await test("normalizeRepo 作为显式能力传入而非由 adapter 隐式导入", () => {
  const adapter = createAdaptorAdapter({
    loadConfig: () => ({ redirects: [{ from: "a/b", to: "c/d", meta: { full_name: "c/d" } }] }),
    normalizeRepo: (repo) => ({ full_name: repo.full_name, injected: true }),
  });
  assert.deepEqual(adapter.applyAdaptorList([{ full_name: "a/b" }]), [{ full_name: "c/d", injected: true }]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
