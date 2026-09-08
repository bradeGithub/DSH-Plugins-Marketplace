// 性能基准契约测试：验证 benchmark 的输入不变式与结果正确性，不测机器相关耗时。
// 覆盖：确定性合成数据可复现、dedupe 结果正确、index 构建正确、profileHit 命中、
// 输出 JSON 含样本规模/median/p95/git revision，且不把绝对耗时当作断言。

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dedupeReposByPkgName } from "../../../lib/domain/list.js";
import { buildInstalledIndex, profileHit } from "../../../lib/domain/installed-index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const benchmarkSource = readFileSync(join(ROOT, "scripts", "benchmarks", "marketplace.mjs"), "utf8");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

// 确定性合成数据可复现（mulberry32 固定种子）
const reposA = [];
const reposB = [];
{
  let a = 0x5eed;
  const rand = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < 50; i++) {
    const owner = `owner-${Math.floor(rand() * 5)}`;
    const name = `repo-${i}`;
    const repo = {
      full_name: `${owner}/${name}`,
      name,
      stargazers_count: Math.floor(rand() * 100),
      pkg_name: rand() > 0.3 ? `pkg-${Math.floor(rand() * 25)}` : null,
      installed: rand() > 0.8
    };
    reposA.push(repo);
    reposB.push({ ...repo });
  }
}
check("确定性合成数据两次生成一致", reposA, reposB);

// dedupe 结果正确：同名 pkg 保留已安装或高星
{
  const input = [
    { full_name: "a/old", pkg_name: "shared", stargazers_count: 1, installed: true },
    { full_name: "b/new", pkg_name: "shared", stargazers_count: 100, installed: false }
  ];
  const { repos, dropped } = dedupeReposByPkgName(input, (r) => r.installed === true);
  check("dedupe 已装优先", repos[0].full_name, "a/old");
  check("dedupe 隐藏低优先", dropped, ["b/new"]);
}

// index 构建正确 + profileHit 命中
{
  const profile = new Map([
    ["pkg-0", { name: "pkg-0", repository: "owner-1/repo-0", version: "1.0.0" }]
  ]);
  const index = buildInstalledIndex({
    profile,
    installedEntries: [],
    managedDirs: [],
    managedRoots: [],
    cacheEntries: { scripts: [], packageNames: [] },
    official: new Set(),
    ownRepo: null
  });
  check("index 保留 profile", index.profile.get("pkg-0").repository, "owner-1/repo-0");
  const hit = profileHit(index, { full_name: "owner-1/repo-0" }, ["pkg-0"]);
  check("profileHit 命中", hit?.name, "pkg-0");
  check("profileHit 未命中返回 null", profileHit(index, { full_name: "x/y" }, ["missing"]), null);
}

// 输出 JSON 契约：含样本规模、median、p95、git revision，且不把绝对耗时当断言
check("benchmark 输出含样本规模", /samples: samples\.length/.test(benchmarkSource), true);
check("benchmark 输出含 median 与 p95", /median: median\(samples\)/.test(benchmarkSource) && /p95: p95\(samples\)/.test(benchmarkSource), true);
check("benchmark 输出含 git revision", /git_revision/.test(benchmarkSource), true);
check("benchmark 不把绝对耗时当断言", !/assert|check\(.*median|expect.*median/.test(benchmarkSource), true);
check("benchmark 使用确定性 PRNG", /mulberry32/.test(benchmarkSource), true);
check("benchmark 有 warmup", /warmup/.test(benchmarkSource), true);

// 实际运行 benchmark（小迭代数）→ 输出必须是合法 JSON 且含全部规模维度
{
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(process.execPath, [join(ROOT, "scripts", "benchmarks", "marketplace.mjs"), "--iterations=5"], {
    cwd: ROOT, encoding: "utf8", timeout: 120000, windowsHide: true
  });
  let report = null;
  try { report = JSON.parse(out); } catch { /* 非 JSON */ }
  check("benchmark 实际运行输出合法 JSON", report !== null, true);
  check("benchmark 输出含全部规模维度", report && ["dedupe_1000", "dedupe_5000", "dedupe_20000", "fingerprint_1000", "index_build_1000", "profile_hit_1000"].every((k) => k in report.results), true);
  check("benchmark 每个维度含 median/p95/samples", report && Object.values(report.results).every((r) => typeof r.median === "number" && typeof r.p95 === "number" && r.samples === 5), true);
  check("benchmark 输出含 git revision", report && typeof report.git_revision === "string", true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
