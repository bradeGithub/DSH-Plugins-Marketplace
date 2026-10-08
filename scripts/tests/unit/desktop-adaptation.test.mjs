// 桌面端适配单测：
//   1. 当前 profile 识别（DSH_PROFILE_DIR / DSH_PROFILE → 目标 profile 跟随启动器）
//   2. 内置插件管理器适配器（成功/需重启/失败/服务缺失 四态归一化，绝不把失败当成功）
//   3. package spec → 裸包名（安装记录里卸载用的依赖名）
//   4. 安装执行器路由：bundle 包优先走内置安装器；内置拒绝时不回退自带复制路径

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

import {
  detectCurrentProfile,
  refreshCurrentProfile,
  setTargetProfile,
  profileDir,
  isCurrentProfile,
  currentProfile
} from "../../../lib/domain/profile.js";
import { createPluginManagerAdapter } from "../../../lib/infra/plugin-manager.js";
import { createInstallExecutor } from "../../../lib/app/install-exec.js";
import { packageNameFromSpec } from "../../../lib/app/install.js";
import { isBundlePackage } from "../../../lib/domain/validation.js";

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ---- 1. 当前 profile 识别 ----
const DIR_ENV = { DSH_PROFILE_DIR: "C:\\Users\\u\\.dsh\\profiles\\desktop" };
check("DSH_PROFILE_DIR 解析出名字与目录", detectCurrentProfile(DIR_ENV, "C:\\Users\\u\\.dsh"), {
  name: "desktop",
  dir: "C:\\Users\\u\\.dsh\\profiles\\desktop"
});
check("DSH_PROFILE 仅名字时按共享树推导", detectCurrentProfile({ DSH_PROFILE: "headless" }, "C:\\Users\\u\\.dsh"), {
  name: "headless",
  dir: join("C:\\Users\\u\\.dsh", "profiles", "headless")
});
check("两者都缺失 → null（老环境回退）", detectCurrentProfile({}, "C:\\Users\\u\\.dsh"), null);
check("非法名字被拒绝", detectCurrentProfile({ DSH_PROFILE: "../evil" }, "C:\\Users\\u\\.dsh"), null);
check("basename 为 profiles 的根本身被拒绝", detectCurrentProfile({ DSH_PROFILE_DIR: "C:\\Users\\u\\.dsh\\profiles" }, "C:\\Users\\u\\.dsh"), null);
check("目录优先于名字（应用自有 profile 不在共享树内）", detectCurrentProfile({
  DSH_PROFILE_DIR: "D:\\apps\\harness\\profiles\\desktop",
  DSH_PROFILE: "web"
}, "C:\\Users\\u\\.dsh").name, "desktop");

// profileDir 跟随启动器：桌面端目标 profile 必须落到启动器给的目录
refreshCurrentProfile(DIR_ENV, "C:\\Users\\u\\.dsh");
setTargetProfile("desktop");
check("profileDir 跟随启动器目录", profileDir(), "C:\\Users\\u\\.dsh\\profiles\\desktop");
check("isCurrentProfile 命中桌面 profile", isCurrentProfile("desktop"), true);
check("isCurrentProfile 不命中别的 profile", isCurrentProfile("web"), false);
check("currentProfile 暴露名字", currentProfile()?.name, "desktop");
check("非当前 profile 仍按共享树拼路径", profileDir("web"), join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "profiles", "web"));

// ---- 2. 内置插件管理器适配器 ----
const adapter = createPluginManagerAdapter();
check("未绑定服务时不可用", adapter.available(), false);
check("未绑定服务时 install 报 unavailable", (await adapter.installBundle("github:a/b")).unavailable, true);

// attach 走 ctx.get("pluginManager")（cordis 服务键）
const fakeCalls = [];
const fakeService = {
  calls: fakeCalls,
  async installBundle(spec, options) { fakeCalls.push(["install", spec, options?.activate]); return { changed: true, application: "applied" }; },
  async removeBundle(name) { fakeCalls.push(["remove", name]); return { changed: true, application: "restart-required" }; },
  async inspect(spec) { fakeCalls.push(["inspect", spec]); return { name: spec }; }
};
check("attach 拿到服务", adapter.attach({
  get: (key) => (key === "pluginManager" ? fakeService : undefined),
  profileContext: { dir: "C:\\Users\\u\\.dsh\\profiles\\desktop" }
}), true);
check("attach 记录宿主 profile 目录", adapter.profileDir(), "C:\\Users\\u\\.dsh\\profiles\\desktop");
check("服务可用", adapter.available(), true);

let r = await adapter.installBundle("github:owner/repo");
check("安装成功 ok=true", r.ok, true);
check("安装成功 needsRestart=false", r.needsRestart, false);
check("安装默认 activate=true", fakeCalls.at(-1), ["install", "github:owner/repo", true]);

const restartService = { async installBundle() { return { changed: true, application: "restart-required" }; } };
adapter._setService(restartService);
r = await adapter.installBundle("dsh-x");
check("restart-required 仍算成功", r.ok, true);
check("restart-required 置 needsRestart", r.needsRestart, true);

const failService = { async installBundle() { return { changed: false, application: "failed", error: { code: "incompatible-version", message: "peer @deepseek-ai/dsh mismatch" } }; } };
adapter._setService(failService);
r = await adapter.installBundle("dsh-y");
check("application=failed → ok=false（不误报成功）", r.ok, false);
check("失败携带错误码", r.code, "incompatible-version");
check("失败携带错误文本", typeof r.error === "string" && r.error.includes("mismatch"), true);

const throwService = { async installBundle() { throw new Error("boom"); } };
adapter._setService(throwService);
r = await adapter.installBundle("dsh-z");
check("服务抛错被归一化（不冒泡）", r.ok, false);
check("抛错错误文本", r.error, "boom");

const cancelService = { async installBundle() { return { changed: false, application: "cancelled" }; } };
adapter._setService(cancelService);
check("cancelled → ok=false", (await adapter.installBundle("dsh-c")).ok, false);

adapter._setService(fakeService);
r = await adapter.removeBundle("dsh-x");
check("卸载成功", r.ok, true);
check("卸载 needsRestart 透传", r.needsRestart, true);

adapter._setService(null);
check("服务缺失时 remove 报 unavailable", (await adapter.removeBundle("dsh-x")).unavailable, true);
check("服务缺失时 inspect 报 unavailable", (await adapter.inspect("dsh-x")).unavailable, true);

// 伪服务没有 installBundle 时视为不可用（防把别的服务误当安装器）
const notAManager = { somethingElse: true };
const adapter2 = createPluginManagerAdapter();
adapter2.attach({ get: () => notAManager, profileContext: {} });
check("非插件管理器服务不被误用", adapter2.available(), false);

// ---- 3. spec → 包名 ----
check("裸包名", packageNameFromSpec("dsh-web-ui"), "dsh-web-ui");
check("scoped 包名", packageNameFromSpec("@scope/name"), "@scope/name");
check("带版本后缀", packageNameFromSpec("@scope/name@1.2.3"), "@scope/name");
check("带插入符范围", packageNameFromSpec("dsh-x@^1.0.0"), "dsh-x");
check("github spec 不当作包名", packageNameFromSpec("github:owner/repo"), null);
check("git url 不当作包名", packageNameFromSpec("git+https://github.com/a/b.git"), null);
check("本地绝对路径不当作包名", packageNameFromSpec("D:\\plugins\\a"), null);
check("相对路径不当作包名", packageNameFromSpec("./local-pkg"), null);
check("空串", packageNameFromSpec(""), null);

// ---- 4. 安装执行器路由 ----
const cache = mkdtempSync(join(tmpdir(), "dsh-mp-desktop-"));
writeFileSync(join(cache, "package.json"), JSON.stringify({
  name: "dsh-demo-bundle",
  version: "1.0.0",
  dsh: { bundle: { patch: "./cordis.patch.yml" } }
}), "utf8");
writeFileSync(join(cache, "cordis.patch.yml"), "[]\n", "utf8");

const logLines = [];
const logLine = (line) => logLines.push(String(line));
const registerCalls = [];
const builtinCalls = [];

function makeExecutor({ builtinResult, allowed }) {
  const service = {
    async installBundle(spec, options) {
      builtinCalls.push([spec, options?.activate]);
      return builtinResult;
    }
  };
  const pm = createPluginManagerAdapter();
  pm._setService(service);
  pm._setProfileDir("C:\\Users\\u\\.dsh\\profiles\\desktop");
  return createInstallExecutor({
    fs: {
      mkdir: async () => {},
      rm: async () => {},
      cp: async () => {},
      readFile: async (p) => (await import("node:fs/promises")).readFile(p, "utf8"),
      writeFile: async () => {},
      readdir: async () => [],
      exists: async () => false
    },
    path: { joinPath: join, resolvePath: (p) => p, pathSep: "\\" },
    proc: { runScript: async () => {} },
    scan: { findSkillRoots: async () => [], findPluginRoots: async () => [], findPresetRoots: async () => [], readSkillManifest: async () => "", needsPluginBuild: async () => false },
    package: { sanitizeManifest: () => [], isBundlePackage, packageNamePattern: /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/, copyFilter: () => true, readPackageVersion: async () => null },
    adapters: {
      registerBundlePackage: async (name, spec) => { registerCalls.push([name, spec]); return join("C:\\nm", name); },
      appendPatchEntry: async () => true,
      pluginManager: pm
    },
    env: { buildMinimalEnv: () => ({}), buildFilteredEnv: () => ({}) },
    managedDirs: { skillsDir: "C:\\skills", presetsDir: "C:\\presets" },
    selfUpdateRepo: "bradeGithub/DSH-Plugins-Marketplace",
    platform: "win32",
    slugify: (s) => String(s).toLowerCase(),
    buildPluginPackage: async () => {},
    npmInstallWithFallback: async () => {},
    translate: (lang, key, params) => `${key}${params ? JSON.stringify(params) : ""}`,
    _allowed: allowed
  });
}

const profilePaths = {
  profileDir: "C:\\Users\\u\\.dsh\\profiles\\desktop",
  nodeModules: "C:\\Users\\u\\.dsh\\profiles\\desktop\\node_modules",
  patchFile: "C:\\Users\\u\\.dsh\\profiles\\desktop\\cordis.patch.yml",
  packageFile: "C:\\Users\\u\\.dsh\\profiles\\desktop\\package.json"
};

// 4a. 内置安装器可用 → 走内置，且不再调用自带注册
const runBuiltin = makeExecutor({ builtinResult: { changed: true, application: "applied" }, allowed: true });
const resBuiltin = await runBuiltin({
  type: "bundle", cacheDir: cache, repo: "owner/dsh-demo-bundle", log: [], logLine, lang: "zh",
  profilePaths, builtinAllowed: true
});
check("bundle 走内置安装器", builtinCalls.length, 1);
check("bundle 内置 spec 为 github:owner/repo", builtinCalls[0][0], "github:owner/dsh-demo-bundle");
check("bundle 内置安装 activate=true", builtinCalls[0][1], true);
check("bundle 不再走自带注册", registerCalls.length, 0);
check("bundle 结果标记 viaBuiltin", resBuiltin.viaBuiltin, true);
check("bundle 结果 needsRestart=false", resBuiltin.needsRestart, false);
check("bundle 结果 bundle=true", resBuiltin.bundle, true);

// 4b. 目标 profile 不是当前 profile（builtinAllowed=false）→ 回退自带注册
builtinCalls.length = 0;
const runFallback = makeExecutor({ builtinResult: { changed: true, application: "applied" }, allowed: false });
const resFallback = await runFallback({
  type: "bundle", cacheDir: cache, repo: "owner/dsh-demo-bundle", log: [], logLine, lang: "zh",
  profilePaths, builtinAllowed: false
});
check("builtinAllowed=false 不调用内置", builtinCalls.length, 0);
check("builtinAllowed=false 走自带注册", registerCalls.length, 1);
check("自带注册 spec 为 github:owner/repo", registerCalls[0][1], "github:owner/dsh-demo-bundle");
check("回退结果无 viaBuiltin", resFallback.viaBuiltin, undefined);

// 4c. 内置安装器拒绝（版本不兼容）→ 抛错且不回退（宿主的判定不被绕过）
registerCalls.length = 0;
const runReject = makeExecutor({
  builtinResult: { changed: false, application: "failed", error: { code: "incompatible-version", message: "peer mismatch" } },
  allowed: true
});
let rejected = null;
try {
  await runReject({ type: "bundle", cacheDir: cache, repo: "owner/dsh-demo-bundle", log: [], logLine, lang: "zh", profilePaths, builtinAllowed: true });
} catch (error) {
  rejected = String(error?.message ?? error);
}
check("内置拒绝时抛错", typeof rejected === "string" && rejected.includes("builtinInstallFail"), true);
check("内置拒绝时错误文本含原因", typeof rejected === "string" && rejected.includes("peer mismatch"), true);
check("内置拒绝时不回退自带注册", registerCalls.length, 0);

// 4d. 需要重启时如实透传
const runRestart = makeExecutor({ builtinResult: { changed: true, application: "restart-required" }, allowed: true });
const resRestart = await runRestart({
  type: "bundle", cacheDir: cache, repo: "owner/dsh-demo-bundle", log: [], logLine, lang: "zh",
  profilePaths, builtinAllowed: true
});
check("restart-required 透传到结果", resRestart.needsRestart, true);

rmSync(cache, { recursive: true, force: true });

// ---- 5. 目标 profile 解析优先级（真实模块 + 临时 DSH_HOME，动态导入以重读环境）----
const tmpHome = mkdtempSync(join(tmpdir(), "dsh-mp-home-"));
mkdirSync(join(tmpHome, "marketplace"), { recursive: true });
mkdirSync(join(tmpHome, "profiles", "desktop"), { recursive: true });
mkdirSync(join(tmpHome, "profiles", "work"), { recursive: true });
const savedHome = process.env.DSH_HOME;
const savedProfile = process.env.DSH_PROFILE;
const savedProfileDir = process.env.DSH_PROFILE_DIR;
try {
  process.env.DSH_HOME = tmpHome;
  process.env.DSH_PROFILE_DIR = join(tmpHome, "profiles", "desktop");
  delete process.env.DSH_PROFILE;
  // 加查询串强制新实例：模块级 DSH_HOME 在导入时读取
  const fresh = await import(`../../../lib/domain/profile.js?desktop-adaptation=${Date.now()}`);

  check("无配置 → 跟随启动器当前 profile（桌面端 = desktop）",
    await fresh.readTargetProfile(),
    { profile: "desktop", fromConfig: false, source: "current" });
  check("fresh 模块默认目标即当前 profile", fresh.profileName(), "desktop");
  check("fresh 模块 profileDir 落到启动器目录", fresh.profileDir(), join(tmpHome, "profiles", "desktop"));

  const cfgPath = join(tmpHome, "marketplace", "config.json");
  writeFileSync(cfgPath, JSON.stringify({ targetProfile: "work" }), "utf8");
  check("显式配置优先于当前 profile",
    await fresh.readTargetProfile(),
    { profile: "work", fromConfig: true, source: "config" });

  writeFileSync(cfgPath, JSON.stringify({ targetProfile: "ghost" }), "utf8");
  check("配置指向不存在的 profile → 回退当前 profile",
    (await fresh.readTargetProfile()).source, "current");

  writeFileSync(cfgPath, "{ broken json", "utf8");
  check("配置损坏 → 回退当前 profile",
    (await fresh.readTargetProfile()).profile, "desktop");

  // 没有任何启动器信息时才回退 web（老环境行为保持不变）
  delete process.env.DSH_PROFILE_DIR;
  const legacy = await import(`../../../lib/domain/profile.js?legacy=${Date.now()}`);
  check("无启动器信息 → 回退 web（老环境）",
    await legacy.readTargetProfile(),
    { profile: "web", fromConfig: false, source: "default" });
} finally {
  if (savedHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedHome;
  if (savedProfile === undefined) delete process.env.DSH_PROFILE; else process.env.DSH_PROFILE = savedProfile;
  if (savedProfileDir === undefined) delete process.env.DSH_PROFILE_DIR; else process.env.DSH_PROFILE_DIR = savedProfileDir;
  rmSync(tmpHome, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
