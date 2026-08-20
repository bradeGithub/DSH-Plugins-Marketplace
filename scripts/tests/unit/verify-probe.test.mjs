// verify-installability.mjs 探测行为测试（B1 门控修正：trees 404 ≠ gone）。
// 守护「空仓库/无分支」不误判 gone（2026-08-19 审计：16 个真实存在的仓库被误判删除）。
// mock 全局 fetch（不执行 main——import 时 isMain 守卫跳过）。

import { probeTree, confirmGone } from "../../verify-installability.mjs";

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

/** 构造 mock fetch：按 URL 返回预设响应序列。 */
function mockFetch(routes) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const key = String(url);
    const route = routes[key];
    if (!route) return { status: 500, ok: false, headers: { get: () => null }, text: async () => "no route" };
    if (route.status === 403) return { status: 403, ok: false, headers: { get: () => "100" }, text: async () => "" };
    if (route.status === 404) return { status: 404, ok: false, headers: { get: () => "100" }, text: async () => "" };
    return {
      status: 200, ok: true,
      headers: { get: () => "100" },
      json: async () => route.body,
      text: async () => JSON.stringify(route.body),
    };
  };
  return orig;
}

const TREE_OK = { tree: [{ type: "blob", path: "package.json" }, { type: "blob", path: "SKILL.md" }], truncated: false };

// ---- B1：trees 404 行为 ----
{
  const orig = mockFetch({
    "https://api.github.com/repos/a/b/git/trees/main?recursive=1": { status: 404 },
    "https://api.github.com/repos/a/b/git/trees/master?recursive=1": { status: 404 },
  });
  const sig = await probeTree({ full_name: "a/b", default_branch: "main" });
  globalThis.fetch = orig;
  check("全部分支 trees 404 → branchMissing（不误判 gone）", sig, { branchMissing: true, remaining: null });
}

{
  // 默认分支 404 但 master 正常 → 应解析成功（分支回退）
  const orig = mockFetch({
    "https://api.github.com/repos/a/b/git/trees/main?recursive=1": { status: 404 },
    "https://api.github.com/repos/a/b/git/trees/master?recursive=1": { status: 200, body: TREE_OK },
  });
  const sig = await probeTree({ full_name: "a/b", default_branch: "main" });
  globalThis.fetch = orig;
  check("默认分支 404 + master 正常 → 解析成功（分支回退）", sig?.rootPkg, true);
}

{
  // 403 限流 → rateLimited（不消耗判定）
  const orig = mockFetch({
    "https://api.github.com/repos/a/b/git/trees/main?recursive=1": { status: 403 },
  });
  const sig = await probeTree({ full_name: "a/b", default_branch: "main" });
  globalThis.fetch = orig;
  check("403 限流 → rateLimited", sig?.rateLimited, true);
}

// ---- B1：confirmGone 二次确认 ----
{
  // repo 级 API 404 → 真 gone
  const orig = mockFetch({ "https://api.github.com/repos/a/b": { status: 404 } });
  const c = await confirmGone({ full_name: "a/b" });
  globalThis.fetch = orig;
  check("repo API 404 → gone=true", c, { gone: true, remaining: 100 });
}
{
  // repo 级 API 200 → 仓库存在（空仓库），非 gone
  const orig = mockFetch({ "https://api.github.com/repos/a/b": { status: 200, body: { full_name: "a/b" } } });
  const c = await confirmGone({ full_name: "a/b" });
  globalThis.fetch = orig;
  check("repo API 200 → gone=false（空仓库存在）", c, { gone: false, remaining: 100 });
}

// ---- 空仓库全链路（probeTree + confirmGone 组合 = empty 语义）----
{
  const orig = mockFetch({
    "https://api.github.com/repos/empty/repo/git/trees/main?recursive=1": { status: 404 },
    "https://api.github.com/repos/empty/repo/git/trees/master?recursive=1": { status: 404 },
    "https://api.github.com/repos/empty/repo": { status: 200, body: { full_name: "empty/repo" } },
  });
  const sig = await probeTree({ full_name: "empty/repo", default_branch: "main" });
  const c = await confirmGone({ full_name: "empty/repo" });
  globalThis.fetch = orig;
  check("空仓库全链路：branchMissing + repo 200 → empty（非 gone）", sig?.branchMissing === true && c?.gone === false, true);
}

// ---- 真删除全链路（probeTree + confirmGone 组合 = gone 语义）----
{
  const orig = mockFetch({
    "https://api.github.com/repos/gone/repo/git/trees/main?recursive=1": { status: 404 },
    "https://api.github.com/repos/gone/repo/git/trees/master?recursive=1": { status: 404 },
    "https://api.github.com/repos/gone/repo": { status: 404 },
  });
  const sig = await probeTree({ full_name: "gone/repo", default_branch: "main" });
  const c = await confirmGone({ full_name: "gone/repo" });
  globalThis.fetch = orig;
  check("真删除全链路：branchMissing + repo 404 → gone", sig?.branchMissing === true && c?.gone === true, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
