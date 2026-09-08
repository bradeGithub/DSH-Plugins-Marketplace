// domain/list.js 直接导入测试（分层重构契约：行为断言 + 直接导入被测模块）。
import { dedupeReposByPkgName } from "../../../lib/domain/list.js";

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


process.exit(fail === 0 ? 0 : 1);
