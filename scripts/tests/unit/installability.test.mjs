// verify-installability.mjs 判定纯函数测试——重点守护「深层 SKILL.md 不算 skill」：
// reactive-resume（skills/resume-builder/SKILL.md）/ OpenViking（bot/workspace/skills/*/SKILL.md）
// 蹭 topic 案例曾因 SKILL_RE 命中任意路径 SKILL.md 被误判 skill 而漏过 non-plugin 徽章。
import { verdictOf } from "../../verify-installability.mjs";

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${actual}, want ${expected}`);
}

// 根 package.json + 无 dsh 声明 + 深层 SKILL.md → pkg-plain（蹭 topic 案例）
check("根清单无 dsh 声明 + 深层 SKILL.md → pkg-plain（reactive-resume 案例）",
  verdictOf({ rootPkg: true, hasSkill: true, rootSkill: false, truncated: false }, false, false),
  "pkg-plain");
check("根清单无 dsh 声明 + 深层 SKILL.md → pkg-plain（OpenViking 案例）",
  verdictOf({ rootPkg: true, hasSkill: true, rootSkill: false, truncated: false }, false, false),
  "pkg-plain");
// 根 SKILL.md 才是 skill（skill-with-tooling 合法形态）
check("根清单无 dsh 声明 + 根 SKILL.md → skill",
  verdictOf({ rootPkg: true, hasSkill: true, rootSkill: true, truncated: false }, false, false),
  "skill");
// 真插件声明优先
check("根清单有 dsh 声明 → cordis-plugin",
  verdictOf({ rootPkg: true, hasSkill: true, rootSkill: false, truncated: false }, true, false),
  "cordis-plugin");
// 无根清单的技能集合保持 skill
check("无根清单 + 任意 SKILL.md → skill（技能集合形态）",
  verdictOf({ rootPkg: false, hasSkill: true, minSkillDepth: 2, truncated: false }, false, false),
  "skill");
check("无根清单 + 深层 SKILL.md（4 级）→ manual（OpenViking 内部工具链）",
  verdictOf({ rootPkg: false, hasSkill: true, minSkillDepth: 4, truncated: false }, false, false),
  "manual");
check("无根清单 + 深层 SKILL.md 但 truncated → skill（保守）",
  verdictOf({ rootPkg: false, hasSkill: true, minSkillDepth: 4, truncated: true }, false, false),
  "skill");
// preset / script 形态
check("preset → agent-preset",
  verdictOf({ isPreset: true, hasSkill: true, rootPkg: false }, false, false),
  "agent-preset");
check("根 install 脚本 → script",
  verdictOf({ rootScript: true, rootPkg: true, hasSkill: false }, false, false),
  "script");
check("深层 install.sh + 根清单无声明 → pkg-plain（OpenViking 案例）",
  verdictOf({ rootPkg: true, hasScript: true, rootScript: false, truncated: false }, false, false),
  "pkg-plain");
check("dsh 声明优先于根脚本（B1）→ cordis-plugin",
  verdictOf({ rootPkg: true, rootScript: true }, true, false),
  "cordis-plugin");
// truncated 保守路径
check("truncated + 有 skill 信号（根清单无声明）→ skill（保守）",
  verdictOf({ rootPkg: true, hasSkill: true, rootSkill: false, truncated: true }, false, false),
  "skill");
check("truncated 无任何信号 → unknown",
  verdictOf({ truncated: true }, false, false),
  "unknown");
check("空信号 → manual",
  verdictOf({}, false, false),
  "manual");
check("gone → gone",
  verdictOf({ gone: true }, false, false),
  "gone");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
