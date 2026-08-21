#!/usr/bin/env node
// 端到端测试：workspace 吞依赖陷阱（issue #146/#147/#168 同源根因）。
// 场景：临时 DSH_HOME 的祖先目录存在 pnpm-workspace.yaml（模拟用户主目录常驻
// DSH 的 workspace 配置）——pnpm 11 向上查找会把 profile 目录吞进 workspace，
// `pnpm install` 变 workspace 级操作，bundle 依赖装不进 profile node_modules
// 却静默成功（"Already up to date"）。修复：runPnpm 调用带 --ignore-workspace。
// 本测试验证 registerBundlePackage 在祖先 workspace 存在时依赖仍进 profile。
//
// 前置：git + pnpm 可用（真实网络解析 github: 依赖——pnpm 的 git 协议不经过
// git URL 重写；缺失时 SKIP，与 install.e2e.mjs 同款降级）。
// 运行：node scripts/tests/e2e/workspace-trap.e2e.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

// ---- 前置检查：git + pnpm（缺失 SKIP，同 install.e2e.mjs）----
try { execFileSync("git", ["--version"], { stdio: "pipe" }); } catch { console.log("SKIP: git 不可用"); process.exit(0); }
try {
  execFileSync(process.platform === "win32" ? "cmd.exe" : "pnpm",
    process.platform === "win32" ? ["/d", "/s", "/c", "pnpm", "--version"] : ["--version"], { stdio: "pipe" });
} catch { console.log("SKIP: pnpm 不可用"); process.exit(0); }

// 临时 DSH_HOME + 祖先 workspace 文件（lib 加载前设置）。
// 布局：ancestor/（workspace 根，模拟用户主目录常驻 pnpm-workspace.yaml）
//   └── home/（DSH_HOME）
//       └── profiles/web（install 的目标）
// profiles/web 向上找最近的 workspace 根 = ancestor（模拟 ~/.dsh 向上找到 ~ 的
// workspace 配置）；pnpm 找到就停，不会继续向上。
const WS_ROOT = mkdtempSync(join(tmpdir(), "dsh-wsroot-")).replace(/\\/g, "/");
const HOME = join(WS_ROOT, "home");
mkdirSync(HOME, { recursive: true });
process.env.DSH_HOME = HOME;
// 与用户主目录同形态：pnpm-workspace.yaml 无 packages 字段（DSH 部署只写
// allowBuilds）——pnpm 把根当唯一项目，子目录裸 install 全被吞。
writeFileSync(join(WS_ROOT, "pnpm-workspace.yaml"), "allowBuilds:\n  'koffi': true\n", "utf8");
// workspace 根先安装一次生成 lockfile + node_modules（模拟用户主目录已有 DSH 部署）——
// 无此状态时裸 pnpm 会正常装子目录依赖（吞依赖需要根已有 lockfile 上下文）
writeFileSync(join(WS_ROOT, "package.json"), JSON.stringify({ name: "ancestor-workspace", private: true, dependencies: { "@deepseek-ai/dsh": "0.1.0-rc.6" } }), "utf8");
try {
  await execFileAsync("cmd.exe", ["/d", "/s", "/c", "pnpm", "install"], { cwd: WS_ROOT, maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 600000 });
} catch { /* 根安装失败不阻断（环境缺网络时对照组自然失效，主断言仍可跑） */ }

const PROF = join(HOME, "profiles", "web");
mkdirSync(join(PROF, "node_modules", "@deepseek-ai"), { recursive: true });
writeFileSync(join(PROF, "package.json"), JSON.stringify({ name: "web-profile", private: true }), "utf8");
writeFileSync(join(PROF, "cordis.patch.yml"), "# workspace-trap e2e\n");

const lib = await import("../../../lib/index.js");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); }
}

// 前置验证：祖先 workspace 确实会吞依赖（对照组的价值——修复前该断言失败）。
// 对照组：裸 pnpm install（不带 --ignore-workspace）在祖先 workspace 存在时，
// 依赖被 workspace 根吞（包出现在根 node_modules 而非 cwd 的）；证明场景有判别力。
const CTRL = join(HOME, "ctrl-profile");
mkdirSync(join(CTRL, "node_modules"), { recursive: true });
writeFileSync(join(CTRL, "package.json"), JSON.stringify({
  name: "ctrl-profile", private: true,
  dependencies: { "dsh-subagent-cwd": "github:lynx-gt/dsh-subagent-cwd" },
}), "utf8");
try {
  await execFileAsync("cmd.exe", ["/d", "/s", "/c", "pnpm", "install"], { cwd: CTRL, maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 600000 });
} catch { /* 对照组允许失败 */ }
const ctrlSwallowed = !existsSync(join(CTRL, "node_modules", "dsh-subagent-cwd", "package.json"));
check("wstest 对照组：裸 pnpm 被祖先 workspace 吞（场景有判别力）", ctrlSwallowed, true);

// 真实 bundle 安装：修复后依赖进 profile node_modules（--ignore-workspace 生效）。
const repo = "lynx-gt/dsh-subagent-cwd";
const log = [];
const logLine = (l) => { log.push(String(l ?? "")); };
const cacheDir = join(HOME, "cache", "wstest");
mkdirSync(cacheDir, { recursive: true });
execFileSync("git", ["clone", "--depth", "1", `https://github.com/${repo}.git`, cacheDir],
  { stdio: ["ignore", "pipe", "pipe"], timeout: 90000, windowsHide: true });

const detect = await lib.detectTypeDetail(cacheDir);
check("wstest 类型判定 bundle", detect.type, "bundle");
check("wstest 判定理由 bundleDeclared", detect.reasonKey, "detectReason.bundleDeclared");

const result = await lib.installRepo({
  type: detect.type, cacheDir, repo,
  log, answers: {}, logLine, lang: "zh-CN",
  envAllowList: [], npmTarget: null,
});
// 修复后：依赖进 profile node_modules（--ignore-workspace 生效）
check("wstest bundle 安装成功", result.bundle, true);
check("wstest 依赖解析到 profile", existsSync(join(PROF, "node_modules", "dsh-subagent-cwd", "package.json")), true);

// workspace 根未被污染：祖先 workspace 的 node_modules 不应出现该依赖
const ancestorNM = join(WS_ROOT, "node_modules", "dsh-subagent-cwd");
check("wstest workspace 根未被污染", existsSync(ancestorNM), false);

// 边界：npm 路径不受祖先 pnpm workspace 影响（npm 只认 package.json 显式
// workspaces 字段，pnpm-workspace.yaml 不生效）——runNpm 无需 --ignore-workspace。
// npm 缺失时跳过该断言（CI 无 npm 的环境）。
let npmAvailable = true;
try {
  execFileSync(process.platform === "win32" ? "cmd.exe" : "npm",
    process.platform === "win32" ? ["/d", "/s", "/c", "npm", "--version"] : ["--version"], { stdio: "pipe" });
} catch { npmAvailable = false; }
if (npmAvailable) {
  const npmSub = join(HOME, "npm-sub");
  mkdirSync(join(npmSub, "node_modules"), { recursive: true });
  writeFileSync(join(npmSub, "package.json"), JSON.stringify({
    name: "npm-sub", private: true,
    dependencies: { "is-number": "^7.0.0" },
  }), "utf8");
  let npmOk = false, npmErr = "";
  try {
    await execFileAsync("cmd.exe", ["/d", "/s", "/c", "npm", "install", "--no-audit", "--no-fund"],
      { cwd: npmSub, maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 600000 });
    npmOk = true;
  } catch (e) { npmErr = String(e?.message ?? e).slice(0, 120); }
  // npm 无吞依赖机制：失败必是网络/其他问题（值得暴露，不静默放行）
  check("wstest npm 路径不受祖先 workspace 影响", existsSync(join(npmSub, "node_modules", "is-number", "package.json")), true);
  if (!npmOk) console.log(`     (npm install 自身失败: ${npmErr})`);
} else {
  console.log("SKIP: npm 不可用，跳过 npm 边界断言");
}

// profile manifest 记录正确
const profPkg = JSON.parse(readFileSync(join(PROF, "package.json"), "utf8"));
check("wstest dependencies 记录", profPkg.dependencies?.["dsh-subagent-cwd"], "github:lynx-gt/dsh-subagent-cwd");
check("wstest bundles 记录", (profPkg.dsh?.profile?.bundles ?? []).includes("dsh-subagent-cwd"), true);

// 清理（临时目录系统回收，此处主动删避免磁盘堆积）
rmSync(WS_ROOT, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
