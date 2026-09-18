// domain/list.js 直接导入测试（分层重构契约：行为断言 + 直接导入被测模块）。
import { dedupeReposByPkgName, LIST_SORT_KEYS, isVerifiedRepo, listComparator, repoListFilter } from "../../../lib/domain/list.js";

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ---- dedupeReposByPkgName ----

// 行为：同 pkg_name 已安装低星仍保留（安装权重 +1e12 保底）
check("dedupe 已装低星优先（同名包保已装）", dedupeReposByPkgName(
  [{ full_name: "b/new", name: "new", pkg_name: "same", stargazers_count: 999 },
   { full_name: "a/old", name: "old", pkg_name: "same", stargazers_count: 1 }],
  (r) => r.full_name === "a/old"
).repos[0].full_name, "a/old");

// 行为：无已装时高星优先
check("dedupe 无已装时高星优先", dedupeReposByPkgName(
  [{ full_name: "b/new", name: "new", pkg_name: "same", stargazers_count: 999 },
   { full_name: "a/old", name: "old", pkg_name: "same", stargazers_count: 1 }],
  () => false
).repos[0].full_name, "b/new");

// 行为：不同 pkg_name 不去重
check("dedupe 不同 pkg_name 不去重", dedupeReposByPkgName(
  [{ full_name: "a/x", pkg_name: "x" }, { full_name: "a/y", pkg_name: "y" }],
  () => false
).repos.length, 2);

// 行为：NaN stars 不影响已安装保留（性质测试暴露的边界）
check("dedupe 已装 + NaN stars 仍保留", dedupeReposByPkgName(
  [{ full_name: "b/new", name: "new", pkg_name: "same", stargazers_count: 999 },
   { full_name: "a/old", name: "old", pkg_name: "same", stargazers_count: NaN }],
  (r) => r.full_name === "a/old"
).repos[0].full_name, "a/old");

// 行为：dropped 列表包含被隐藏的仓库名
check("dropped 含被隐藏仓库名", dedupeReposByPkgName(
  [{ full_name: "b/new", name: "new", pkg_name: "same", stargazers_count: 999 },
   { full_name: "a/old", name: "old", pkg_name: "same", stargazers_count: 1 }],
  () => false
).dropped.includes("a/old"), true);

// 行为：无 pkg_name 的条目按 full_name 去重（repo: 前缀）；无冲突时不去重
check("无 pkg_name 条目不去重", dedupeReposByPkgName(
  [{ full_name: "a/x" }, { full_name: "a/y" }],
  () => false
).repos.length, 2);

// 行为：同 full_name 无 pkg_name 时按 repo: 键去重
check("同 full_name 无 pkg_name 去重", dedupeReposByPkgName(
  [{ full_name: "a/x", stargazers_count: 1 },
   { full_name: "a/x", stargazers_count: 999 }],
  () => false
).repos.length, 1);

// 行为：空列表不报错
check("空列表返回空", dedupeReposByPkgName([], () => false).repos.length, 0);

// 行为：去重后返回值结构完整
check("返回值含 repos 和 dropped", (() => {
  const r = dedupeReposByPkgName([], () => false);
  return Array.isArray(r.repos) && Array.isArray(r.dropped);
})(), true);

// 行为：domain 纯逻辑不直接输出日志
{
  const originalWarn = console.warn;
  let warningCount = 0;
  console.warn = () => { warningCount++; };
  try {
    dedupeReposByPkgName(
      [{ full_name: "a/one", pkg_name: "same", stargazers_count: 1 },
       { full_name: "b/two", pkg_name: "same", stargazers_count: 2 }],
      () => false
    );
  } finally {
    console.warn = originalWarn;
  }
  check("domain 去重不产生 console.warn", warningCount, 0);
}

// ---- S1 信号面：listComparator / repoListFilter / isVerifiedRepo ----

// isVerifiedRepo：market_tags 含 verified-install 才为真
check("isVerifiedRepo 命中", isVerifiedRepo({ market_tags: ["verified-install", "x"] }), true);
check("isVerifiedRepo 未命中", isVerifiedRepo({ market_tags: ["community-pick"] }), false);
check("isVerifiedRepo 无 tags", isVerifiedRepo({}), false);
check("isVerifiedRepo null 输入", isVerifiedRepo(null), false);

// LIST_SORT_KEYS 白名单
check("sort keys 白名单", [...LIST_SORT_KEYS].sort(), ["name", "stars", "trending", "updated"]);

// listComparator：stars 默认降序
check("cmp stars 降序", [{ stargazers_count: 1 }, { stargazers_count: 9 }].sort(listComparator("stars"))[0].stargazers_count, 9);
// 未知键回退 stars
check("cmp 未知键回退 stars", [{ stargazers_count: 1 }, { stargazers_count: 9 }].sort(listComparator("bogus"))[0].stargazers_count, 9);
// trending：stars_delta_7d 降序，null 垫底，同值回退 stars
{
  const list = [
    { full_name: "a/no-delta", stargazers_count: 999, stars_delta_7d: null },
    { full_name: "b/hot", stargazers_count: 10, stars_delta_7d: 42 },
    { full_name: "c/warm", stargazers_count: 50, stars_delta_7d: 7 }
  ].sort(listComparator("trending")).map((r) => r.full_name);
  check("cmp trending 增速降序 null 垫底", list, ["b/hot", "c/warm", "a/no-delta"]);
}
{
  const list = [
    { full_name: "a/low", stargazers_count: 5, stars_delta_7d: 10 },
    { full_name: "b/high", stargazers_count: 50, stars_delta_7d: 10 }
  ].sort(listComparator("trending")).map((r) => r.full_name);
  check("cmp trending 同 delta 回退 stars", list, ["b/high", "a/low"]);
}
// updated：updated_at 降序，无日期垫底
{
  const list = [
    { full_name: "a/old", updated_at: "2020-01-01" },
    { full_name: "b/new", updated_at: "2026-01-01" },
    { full_name: "c/none", updated_at: null }
  ].sort(listComparator("updated")).map((r) => r.full_name);
  check("cmp updated 降序无日期垫底", list, ["b/new", "a/old", "c/none"]);
}
// name：full_name 升序
check("cmp name 升序", [{ full_name: "b/y" }, { full_name: "a/x" }].sort(listComparator("name"))[0].full_name, "a/x");
// NaN stars 不崩（性质测试先例：NaN 比较恒不成立）
check("cmp stars NaN 不崩", [{ stargazers_count: NaN }, { stargazers_count: 1 }].sort(listComparator("stars")).length, 2);

// repoListFilter：无 opts 恒真；verified / hideArchived 各规则
check("filter 无 opts 恒真", repoListFilter()({ archived: true }), true);
check("filter verified 留已验证", [{ market_tags: ["verified-install"] }, { market_tags: [] }].filter(repoListFilter({ verified: true })).length, 1);
check("filter hideArchived 去归档", [{ archived: true }, { archived: false }].filter(repoListFilter({ hideArchived: true })).length, 1);
check("filter 双条件叠加", [{ archived: true, market_tags: ["verified-install"] }, { archived: false, market_tags: ["verified-install"] }].filter(repoListFilter({ verified: true, hideArchived: true })).length, 1);

process.exit(fail === 0 ? 0 : 1);
