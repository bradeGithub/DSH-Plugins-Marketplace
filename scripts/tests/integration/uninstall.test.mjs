// uninstall handler 安全校验测试：
// - script 型插件的 location 必须位于克隆缓存 CACHE_DIR 内才允许删除（安全纵深 L6）
//   ——installed.json 被篡改时不能删除任意路径；
// - skill / agent-preset 型：location 必须位于 SKILLS_DIR / PRESETS_DIR 内（前缀或精确相等）。
//   L1 修复：多 skill / 多预设仓库安装时 location 记为 SKILLS_DIR / PRESETS_DIR 本身
//   （无尾分隔符）——精确相等也必须放行删除，否则目录残留而记录已删。
//
// 独立文件的原因：lib 模块在 import 时从 DSH_HOME/marketplace/installed.json 加载安装清单
// （installedMap 为模块内部状态），必须在本文件内先构造 DSH_HOME + installed.json 再 import。

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// 必须在 import lib 之前设置临时 DSH_HOME
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-uninstall-test-")).replace(/\\/g, "/");
const home = process.env.DSH_HOME;
const marketRoot = join(home, "marketplace");
const cacheDir = join(marketRoot, "cache");
const insideDir = join(cacheDir, "owner__inside");
const outsideDir = join(home, "outside-target");
mkdirSync(insideDir, { recursive: true });
mkdirSync(outsideDir, { recursive: true });
writeFileSync(join(insideDir, "x.txt"), "x", "utf8");
writeFileSync(join(outsideDir, "y.txt"), "y", "utf8");
// skill / 预设场景构造：SKILLS_DIR / PRESETS_DIR 本身及其子目录（L1 修复）
const skillsDir = join(home, "skills");
const presetsDir = join(home, ".agent-presets");
const normalSkillDir = join(skillsDir, "normalskill");
mkdirSync(normalSkillDir, { recursive: true });
writeFileSync(join(normalSkillDir, "SKILL.md"), "# x", "utf8");
mkdirSync(join(skillsDir, "other-skill"), { recursive: true });
writeFileSync(join(skillsDir, "other-skill", "SKILL.md"), "# y", "utf8");
mkdirSync(presetsDir, { recursive: true });
writeFileSync(join(presetsDir, "preset.yml"), "x", "utf8");
writeFileSync(join(marketRoot, "installed.json"), JSON.stringify({
  "owner/inside": { type: "script", name: "inside", location: insideDir, installedAt: 1 },
  "owner/outside": { type: "script", name: "outside", location: outsideDir, installedAt: 1 },
  "owner/normalskill": { type: "skill", name: "normalskill", location: normalSkillDir, installedAt: 1 },
  "owner/multiskill": { type: "skill", name: "2-skills", names: ["a", "b"], location: skillsDir, installedAt: 1 },
  "owner/multipreset": { type: "agent-preset", name: "2-presets", names: ["p1", "p2"], location: presetsDir, installedAt: 1 },
  "owner/badskill": { type: "skill", name: "badskill", location: outsideDir, installedAt: 1 }
}), "utf8");

const lib = await import("../../../lib/index.js");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// mock ctx 捕获路由注册
let registered = [];
const fakeCtx = {
  get: (s) => (s === "webServer" ? { register: (r) => registered.push(r) } : undefined),
  logger: { warn: () => {} },
};
lib.apply(fakeCtx);
const uninstallHandler = registered.find((h) => h.path === "/api/marketplace/uninstall")?.handler;
check("uninstall 路由已注册", !!uninstallHandler, true);

if (uninstallHandler) {
  // mock req：async iterable body（readJsonBody 用 for await 消费）+ 可信头
  const mkReq = (repo) => ({
    method: "POST",
    headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" },
    [Symbol.asyncIterator]: function* () {
      yield Buffer.from(JSON.stringify({ repo }));
    },
  });
  const mkRes = () => {
    let status = 0;
    let body = null;
    return {
      res: { writeHead: (s) => { status = s; }, end: (b) => { try { body = JSON.parse(b); } catch { body = null; } } },
      get status() { return status; },
      get body() { return body; },
    };
  };

  // 场景 1：location 在 CACHE_DIR 内 → 删除生效
  const r1 = mkRes();
  await uninstallHandler(mkReq("owner/inside"), r1.res);
  check("uninstall 内部 location → 200", r1.status, 200);
  check("uninstall 内部 location → 目录已删", existsSync(insideDir), false);
  // 记录已移除的行为断言：再次卸载同一仓库应提示「未找到安装记录」
  const r1b = mkRes();
  await uninstallHandler(mkReq("owner/inside"), r1b.res);
  check("uninstall 记录已移除（重复卸载提示无记录）",
    Array.isArray(r1b.body?.log) && r1b.body.log.some((l) => l.includes("未找到安装记录")), true);

  // 场景 2：location 在 CACHE_DIR 外 → 校验拦截，目录保留
  const r2 = mkRes();
  await uninstallHandler(mkReq("owner/outside"), r2.res);
  check("uninstall 外部 location → 200（记录移除但目录不删）", r2.status, 200);
  check("uninstall 外部 location → 目录保留（校验生效）", existsSync(outsideDir), true);

  // 场景 3：未受信请求 → 403
  const r3 = mkRes();
  const req3 = mkReq("owner/inside");
  req3.headers = { host: "evil.com" }; // 缺自定义头 + 非白名单 Host
  await uninstallHandler(req3, r3.res);
  check("uninstall 未受信请求 → 403", r3.status, 403);

  // 场景 4：常规 skill（location 为 SKILLS_DIR 子目录）→ 前缀匹配仍有效（refactor 回归）
  const r4 = mkRes();
  await uninstallHandler(mkReq("owner/normalskill"), r4.res);
  check("uninstall 常规 skill（子目录 location）→ 200", r4.status, 200);
  check("uninstall 常规 skill 目录已删", existsSync(normalSkillDir), false);

  // 场景 5：多 skill 仓库（location = SKILLS_DIR 本身，无尾分隔符）→ 整个目录被删除（L1 修复）
  const r5 = mkRes();
  await uninstallHandler(mkReq("owner/multiskill"), r5.res);
  check("uninstall 多 skill（location=SKILLS_DIR 本身）→ 200", r5.status, 200);
  check("uninstall 多 skill 目录已删（含其他子技能）", existsSync(skillsDir), false);

  // 场景 6：多 agent 预设（location = PRESETS_DIR 本身）→ 目录被删除（L1 修复）
  const r6 = mkRes();
  await uninstallHandler(mkReq("owner/multipreset"), r6.res);
  check("uninstall 多预设（location=PRESETS_DIR 本身）→ 200", r6.status, 200);
  check("uninstall 多预设目录已删", existsSync(presetsDir), false);

  // 场景 7：skill 型 location 在受管目录外 → 校验拦截，目录保留（无越界）
  const r7 = mkRes();
  await uninstallHandler(mkReq("owner/badskill"), r7.res);
  check("uninstall skill 外部 location → 200（记录移除但目录不删）", r7.status, 200);
  check("uninstall skill 外部 location → 目录保留（受管约束仍生效）", existsSync(outsideDir), true);
}

rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
