// C 技能安装形态判定测试：classifyTree 扩展（单技能/合集/深层埋藏/根脚本）+ 增量继承。
// 守护：skills 条目能区分「市场可装的技能形态」与「大项目内部 SKILL.md 埋藏」。

import { classifyTree, shouldInheritProbe, applyStarDeltas } from "../../build-registry.mjs";

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
