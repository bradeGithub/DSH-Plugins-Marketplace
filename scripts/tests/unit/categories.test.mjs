// 分类回归测试：audit-expected.json（120 仓库 README 审计期望 + 元数据快照）中
// **当前索引内**的条目按三层判定：
//   1. 快照一致 + 分类器输出 != 期望 → 规则回归（同输入输出变了 = 分类规则被改坏）→ 硬失败；
//   2. 快照一致 + 输出 == 期望 → 命中；
//   3. 快照缺失 / 元数据与快照不一致 → 元数据漂移（作者改了简介/主题，分类器输入变了）→
//      不失败，写入漂移清单（drift-report.json + warning 输出）待人工复审。
// 规则或 CATEGORY_OVERRIDES 改动后跑本测试，防止分类回归；
// 作者改简介导致分类漂移**不再阻塞 CI**——索引构建继续，漂移由维护者定期复审
// （分类器被误导 → 加 CATEGORY_OVERRIDES；审计过时 → 更新期望与快照）。
// 注意：registry.json 由 CI 定期重建（搜索爬取偶有遗漏），审计条目暂缺时跳过并警告而非失败——
// 索引成员归属是 CI 的职责，本测试只守护「分类规则」这一件事。
// 用法：node scripts/tests/unit/categories.test.mjs

import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyRepo, applyInstallability, applyPlainPkgFallback } from "../../build-registry.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const registry = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"));
const audit = JSON.parse(readFileSync(join(ROOT, "audit-expected.json"), "utf8"));

const byName = new Map(registry.repos.map((r) => [r.full_name, r]));
const entries = Object.entries(audit);
let pass = 0;
let skipped = 0;
let drifted = 0;
const failed = [];
const drift = [];

/** 快照 topics 与当前 topics 的集合比较（GitHub 不保证顺序，比较排序后的集合）。 */
function topicsEqual(a, b) {
  const norm = (arr) => [...(Array.isArray(arr) ? arr : [])].map(String).sort().join("\u0000");
  return norm(a) === norm(b);
}

for (const [fullName, entry] of entries) {
  const expected = typeof entry === "string" ? entry : entry.expected;
  const snapshot = typeof entry === "object" && entry !== null && typeof entry.desc === "string" ? entry : null;
  const repo = byName.get(fullName);
  if (!repo) {
    skipped++;
    console.warn(`  跳过（不在当前索引）: ${fullName}`);
    continue;
  }
  const actual = classifyRepo(repo);
  if (snapshot === null) {
    // 无快照（迁移时不在索引 / desc 为 null 的条目）：输出与期望一致 → 命中（审计未过时）；
    // 不一致 → 无法区分回归与漂移，按漂移处理（不硬失败），提示维护者补快照。
    if (actual === expected) {
      pass++;
      continue;
    }
    drifted++;
    drift.push({ full_name: fullName, expected, actual, note: "快照缺失（迁移时不在索引），请复审后补快照或更新期望" });
    console.warn(`  漂移（快照缺失）: ${fullName}: 实际=${actual} 期望=${expected}`);
    continue;
  }
  const descChanged = (repo.description ?? null) !== snapshot.desc;
  const topicsChanged = !topicsEqual(repo.topics, snapshot.topics);
  if (descChanged || topicsChanged) {
    // 元数据漂移：作者改了简介/主题 → 分类器输出变化属预期，不判失败。
    drifted++;
    const what = [descChanged ? "简介" : "", topicsChanged ? "主题" : ""].filter(Boolean).join("+");
    drift.push({ full_name: fullName, expected, actual, note: `元数据漂移（${what}已变）`, desc_now: repo.description ?? null, desc_snapshot: snapshot.desc });
    console.warn(`  漂移（${what}已变）: ${fullName}: 实际=${actual} 期望=${expected}`);
    continue;
  }
  if (actual === expected) pass++;
  else failed.push(`${fullName}: 实际=${actual} 期望=${expected}`);
}

// 漂移清单落盘（诊断产物，供维护者定期复审；CI 构建目录同样生成，日志里亦有完整 warning）。
// 0 漂移时移除旧报告，避免过期信息误导复审。
try {
  if (drift.length > 0) {
    writeFileSync(join(ROOT, "drift-report.json"), JSON.stringify({ generated_at: new Date().toISOString(), count: drift.length, items: drift }, null, 2) + "\n", "utf8");
  } else {
    rmSync(join(ROOT, "drift-report.json"), { force: true });
  }
} catch { /* 报告写入失败不影响判定 */ }

if (failed.length > 0) {
  console.error(`分类回归失败 ${failed.length}/${entries.length}:`);
  for (const line of failed) console.error("  " + line);
  process.exit(1);
}
console.log(`PASS 分类审计: ${pass}/${entries.length} 命中（${skipped} 条暂缺跳过，${drifted} 条漂移待复审）`);

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

// 人工验证优先：verified-install 仓库跳过机器盖章（dsh-web-ui 场景：根目录非插件
// 但 README 官方聚合包实测可装 → 探测 pkg-plain 会误盖 non-plugin，人工实测覆盖）。
{
  const verdicts = new Map([["v/repo", "pkg-plain"], ["v/manual", "manual"]]);
  const repos = [
    { full_name: "v/repo", market_tags: ["verified-install"] },
    { full_name: "v/manual", market_tags: ["verified-install", "prereq"] },
    { full_name: "v/plain" }
  ];
  applyInstallability(repos, verdicts);
  const bad = repos.filter((r) => r.installable !== undefined);
  if (bad.length > 0) {
    console.error(`verified-install 跳过盖章失败: ${JSON.stringify(bad)}`);
    process.exit(1);
  }
  console.log("PASS verified-install 跳过机器盖章（人工实测优先）");
}

// 高 star 蹭 topic 兜底盖章（reactive-resume ★40k / OpenViking ★28k 教训）：
// 仅「根清单无 DSH 声明 + 无探测结论 + 无人工标注 + 无 DSH 生态 topic + star≥3000」盖章；
// 已有结论不动、低 star 不动、白名单 topic 不动。
{
  const repos = [
    { full_name: "amruthpillai/reactive-resume", stargazers_count: 40467, topics: ["dsh-plugin"], __plainPkg: true },
    { full_name: "volcengine/OpenViking", stargazers_count: 28548, topics: ["agent-memory", "dsh-plugin"], __plainPkg: true },
    { full_name: "low/small", stargazers_count: 1200, topics: ["dsh-plugin"], __plainPkg: true },
    { full_name: "eco/skill-collection", stargazers_count: 8000, topics: ["dsh-plugin", "dsh-skill"], __plainPkg: true },
    { full_name: "human/verified", stargazers_count: 9000, topics: ["dsh-plugin"], __plainPkg: true, market_tags: ["verified-install"] },
    { full_name: "report/concluded", stargazers_count: 9000, topics: ["dsh-plugin"], __plainPkg: true, installable: "manual" },
    { full_name: "real/dsh-declared", stargazers_count: 12000, topics: ["dsh-plugin"], __plainPkg: false }
  ];
  applyPlainPkgFallback(repos);
  const expect = {
    "amruthpillai/reactive-resume": "non-plugin",
    "volcengine/OpenViking": "non-plugin",
    "low/small": undefined,
    "eco/skill-collection": undefined,
    "human/verified": undefined,
    "report/concluded": "manual",
    "real/dsh-declared": undefined
  };
  const bad = repos.filter((r) => r.installable !== expect[r.full_name]);
  if (bad.length > 0) {
    console.error(`高 star 兜底盖章失败: ${JSON.stringify(bad)}`);
    process.exit(1);
  }
  console.log("PASS 高 star 兜底盖章: 蹭 topic 大项目盖 non-plugin，低 star/白名单/已有结论/真插件不动");
}
