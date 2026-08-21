// B2/B3 收录门控测试：fork 真排除 + archived 降权字段 + gone 失效清理。
// 覆盖 build-registry.mjs 的收录过滤与清理逻辑（与 categories/installability 同族）。

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { normalize, applyGoneCleanup, fetchStarSegment } from "../../build-registry.mjs";

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ---- B2：normalize 补 fork/archived 字段 ----
{
  const out = normalize({ full_name: "a/b", name: "b", description: "x", html_url: "https://x", stargazers_count: 1, updated_at: "2026-01-01", default_branch: "main", topics: [], license: null, fork: true, archived: false });
  check("B2 normalize 记录 fork=true", out.fork, true);
  check("B2 normalize 记录 archived=false", out.archived, false);
}
{
  const out = normalize({ full_name: "c/d", name: "d", description: "y", html_url: "https://y", stargazers_count: 2, updated_at: "2026-01-02", default_branch: "main", topics: [], license: null, fork: false, archived: true });
  check("B2 normalize 记录 fork=false（缺省安全）", out.fork, false);
  check("B2 normalize 记录 archived=true", out.archived, true);
}
{
  // fork/archived 字段缺失（旧 API 响应/兜底路径）→ 缺省 false 不误伤
  const out = normalize({ full_name: "e/f", name: "f", description: "z", html_url: "https://z", stargazers_count: 3, updated_at: "2026-01-03", default_branch: "main", topics: [] });
  check("B2 缺省 fork=false（不误伤旧响应）", out.fork, false);
  check("B2 缺省 archived=false", out.archived, false);
}

// ---- B2：fetchStarSegment fork 排除（mock fetch 集成）----
{
  const items = [
    { full_name: "owner/real", name: "real", description: "真插件", html_url: "https://r", stargazers_count: 10, updated_at: "2026-08-01T00:00:00Z", default_branch: "main", topics: ["dsh-plugin"], license: null, fork: false },
    { full_name: "owner/forked", name: "forked", description: "fork 噪音", html_url: "https://f", stargazers_count: 1, updated_at: "2026-08-01T00:00:00Z", default_branch: "main", topics: ["dsh-plugin"], license: null, fork: true }
  ];
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ items, total_count: items.length }),
    headers: { get: () => null }
  });
  const { repos } = await fetchStarSegment("dsh-plugin", { min: 0, max: null }, null);
  globalThis.fetch = orig;
  check("B2 收录排除 fork 条目", repos.length, 1);
  check("B2 保留真条目", repos[0]?.full_name, "owner/real");
}

// ---- B3：gone 清理（真删除 → 索引剔除，报告归档保留）----
{
  const repos = [
    { full_name: "a/live", name: "live", stargazers_count: 10 },
    { full_name: "b/dead", name: "dead", stargazers_count: 5 },
    { full_name: "c/empty", name: "empty", stargazers_count: 1 }
  ];
  const verdictMap = new Map([
    ["a/live", "cordis-plugin"],
    ["b/dead", "gone"],
    ["c/empty", "empty"]
  ]);
  const out = applyGoneCleanup(repos, verdictMap);
  check("B3 gone 条目被剔除", out.map((r) => r.full_name), ["a/live", "c/empty"]);
  check("B3 empty 条目保留（空仓库可能很快有内容）", out.some((r) => r.full_name === "c/empty"), true);
  check("B3 报告外条目保留", out.some((r) => r.full_name === "a/live"), true);
}
{
  const out = applyGoneCleanup([{ full_name: "a/b" }], new Map([["a/b", "cordis-plugin"]]));
  check("B3 无 gone 时原样返回", out.length, 1);
}
{
  const out = applyGoneCleanup([{ full_name: "x/y" }], new Map());
  check("B3 空报告原样返回", out.length, 1);
}

// ---- C1 生命周期：bundle 字段三态写回 + 强制重抓 ----
// 背景：只条件写 true（isBundlePackage → r.bundle = true）会在仓库从 bundle 变普通插件后
// 残留旧标记；enrichPkgNames 的 todo 过滤（!pkg_name || !version）跳过已富化条目 → 永不刷新。
// 契约：① 重抓时非 bundle 必须 delete ② 带 bundle 标记的条目必须进 todo（强制重抓）。
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "build-registry.mjs"), "utf8");
  check("C1 三态写回：非 bundle → delete r.bundle", /if \(isBundlePackage\(pkg\)\) r\.bundle = true; else delete r\.bundle;/.test(src), true);
  check("C1 bundleSuspect：bundle 标记强制重抓", /const bundleSuspect = \(r\) => includeVersion && r\.bundle === true;/.test(src), true);
  check("C1 todo 含 bundleSuspect", /\|\| highStarSuspect\(r\) \|\| bundleSuspect\(r\)/.test(src), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
