#!/usr/bin/env node
// 真实 DSH 宿主端到端：临时 DSH_HOME + 真实 dsh web + 真实 HTTP。
// 安装夹具走本地 git fixture 的 URL rewrite，不接触用户 profile、installed.json 或 patch。

import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { inspectMarketplacePayload } from "../contracts/marketplace.mjs";

const isWin = process.platform === "win32";
const port = Number(process.env.DSH_E2E_PORT ?? "3098");
const host = `http://127.0.0.1:${port}`;
const headers = { "x-dsh-marketplace": "1" };
const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const requireE2e = process.env.DSH_REQUIRE_E2E === "1" || process.env.CI === "true";

try {
  if (isWin) execFileSync("cmd.exe", ["/c", "dsh", "--version"], { stdio: "pipe", windowsHide: true });
  else execFileSync("dsh", ["--version"], { stdio: "pipe", windowsHide: true });
} catch {
  const label = requireE2e ? "FAIL" : "SKIP";
  console.error(`${label}: dsh CLI 不可用，无法执行真实 Host/API E2E`);
  process.exit(requireE2e ? 1 : 0);
}

const home = mkdtempSync(join(tmpdir(), "dsh-real-closure-"));
const profilesRoot = join(home, "profiles");
const webProfile = join(profilesRoot, "web");
const desktopProfile = join(profilesRoot, "desktop");
const fixtureRoot = join(home, "fixtures");
const gitConfig = join(home, "gitconfig");
let child = null;
let childExit = null;

function writeProfile(name, bundles) {
  const profile = join(profilesRoot, name);
  mkdirSync(join(profile, "node_modules"), { recursive: true });
  writeFileSync(join(profile, "package.json"), JSON.stringify({
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: name === "web"
      ? { "dsh-plugin-marketplace": `link:${sourceRoot.replace(/\\/g, "/")}` }
      : {},
    dsh: { profile: { bundles } },
  }, null, 2), "utf8");
  writeFileSync(join(profile, "cordis.patch.yml"), "[]\n", "utf8");
  return profile;
}

function copyMarketplaceBundle() {
  const target = join(webProfile, "node_modules", "dsh-plugin-marketplace");
  mkdirSync(target, { recursive: true });
  for (const file of ["package.json", "cordis.patch.yml", "registry.json", "skills.json", "adaptor.json"]) {
    copyFileSync(join(sourceRoot, file), join(target, file));
  }
  cpSync(join(sourceRoot, "lib"), join(target, "lib"), { recursive: true });
}

function makeFixture(name, files) {
  const dir = join(fixtureRoot, name);
  mkdirSync(dir, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const target = join(dir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "real-closure@test.local"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "real-closure"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "fixture"]);
  execFileSync("git", ["-C", dir, "update-server-info"]);
  return dir;
}

function addGitRewrite(owner, repo, dir) {
  const current = existsSync(gitConfig) ? readFileSync(gitConfig, "utf8") : "[core]\n\tautocrlf = false\n\n";
  const target = dir.replace(/\\/g, "/");
  writeFileSync(gitConfig, `${current}[url "${target}"]\n\tinsteadOf = https://github.com/${owner}/${repo}.git\n`, "utf8");
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
}

function cleanup() {
  if (child?.pid) {
    if (isWin) {
      try {
        execFileSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
      } catch {
        try { child.kill(); } catch { /* process already exited */ }
      }
    } else {
      try { process.kill(-child.pid, "SIGTERM"); } catch {
        try { child.kill(); } catch { /* process already exited */ }
      }
    }
  }
  child = null;
  rmSync(home, { recursive: true, force: true });
}

process.on("exit", cleanup);

writeProfile("web", ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-plugin-marketplace"]);
writeProfile("desktop", ["@deepseek-ai/dsh-base"]);
copyMarketplaceBundle();
const skillRepo = "real-closure/real-skill";
const lifecycleRepo = "real-closure/real-lifecycle";
addGitRewrite("real-closure", "real-skill", makeFixture("real-skill", {
  "SKILL.md": "---\nname: real-host-skill\n---\n# real host skill\n",
}));
addGitRewrite("real-closure", "real-lifecycle", makeFixture("real-lifecycle", {
  "package.json": JSON.stringify({
    name: "real-host-lifecycle",
    version: "1.0.0",
    dsh: {},
    main: "index.js",
    scripts: {
      prepare: "echo prepare",
      postinstall: "echo postinstall",
      install: "echo install",
      preinstall: "echo preinstall",
    },
  }),
  "index.js": "module.exports = {};\n",
}));

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
  if (ok) console.log(`PASS ${name}`);
}

// 契约桥：真实 handler 的响应形状必须满足 client 期望的 marketplace 契约。
// 这是「壳(浏览器 mock) 与 内层(真实 handler)」之间的唯一缺口——browser E2E 用 mock
// 掩盖了真实输出，real-dsh 只验状态码，此处封住「真实响应形状漂移」。
function checkContract(name, kind, payload) {
  const { ok, missing } = inspectMarketplacePayload(kind, payload);
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${name}: 契约缺字段 ${JSON.stringify(missing)}`);
  }
  if (ok) console.log(`PASS ${name}`);
}

const api = async (path, options = {}) => {
  const response = await fetch(host + path, {
    method: options.method ?? "GET",
    headers: { ...headers, ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(options.timeout ?? (path.startsWith("/api/marketplace/list") ? 120000 : 30000)),
  });
  let body = null;
  try { body = await response.json(); } catch { /* non-JSON response */ }
  return { status: response.status, body };
};

try {
  try {
    const occupied = await fetch(`${host}/`, { signal: AbortSignal.timeout(500) });
    throw new Error(`专用端口 ${port} 已被占用（HTTP ${occupied.status}）`);
  } catch (error) {
    if (error?.message?.startsWith("专用端口")) throw error;
  }

  const env = { ...process.env, DSH_HOME: home.replace(/\\/g, "/"), GIT_CONFIG_GLOBAL: gitConfig };
  child = isWin
    ? spawn("cmd.exe", ["/d", "/s", "/c", "dsh", "--profile", "web", "--no-open", "--port", String(port)], { env, stdio: "ignore", windowsHide: true })
    : spawn("dsh", ["--profile", "web", "--no-open", "--port", String(port)], { env, stdio: "ignore", detached: true });
  child.on("exit", (code, signal) => { childExit = { code, signal }; });

  let ready = false;
  for (let i = 0; i < 300 && !ready; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (childExit) throw new Error(`dsh web 启动失败: ${JSON.stringify(childExit)}`);
    try {
      const probe = await fetch(`${host}/api/marketplace/profile`, { headers, signal: AbortSignal.timeout(1500) });
      if (probe.ok) ready = true;
    } catch { /* wait for startup */ }
  }
  if (!ready) throw new Error("dsh web 60s 内未就绪");

  const profile0 = await api("/api/marketplace/profile");
  check("真实宿主 profile 初始为 web", [profile0.status, profile0.body?.profile], [200, "web"]);
  checkContract("真实宿主 profile 响应符合契约", "profile", profile0.body);

  const list0 = await api("/api/marketplace/list?lang=zh-CN");
  check("真实宿主 list 返回仓库与指纹", [list0.status, (list0.body?.repos ?? []).length > 0, typeof list0.body?.fp === "string"], [200, true, true]);
  checkContract("真实宿主 list 响应符合契约", "list", list0.body);
  const skills0 = await api("/api/marketplace/skills?page=1&pageSize=5&lang=zh-CN");
  check("真实宿主 Skills 返回分页列表", [skills0.status, skills0.body?.page, (skills0.body?.repos ?? []).length <= 5, skills0.body?.total > 0], [200, 1, true, true]);
  checkContract("真实宿主 skills 响应符合契约", "skills", skills0.body);

  const skillInstall = await api("/api/marketplace/install", { method: "POST", body: { repo: skillRepo, answers: {} } });
  check("真实宿主 skill 类型识别并安装", [skillInstall.status, skillInstall.body?.status, skillInstall.body?.type], [200, "done", "skill"]);
  checkContract("真实宿主 install 响应符合契约", "install", skillInstall.body);
  check("真实宿主 skill 文件落入临时 DSH_HOME", existsSync(join(home, "skills", "real-host-skill", "SKILL.md")), true);
  const skillUninstall = await api("/api/marketplace/uninstall", { method: "POST", body: { repo: skillRepo } });
  check("真实宿主 skill 卸载返回 done", [skillUninstall.status, skillUninstall.body?.status], [200, "done"]);
  checkContract("真实宿主 uninstall 响应符合契约", "uninstall", skillUninstall.body);
  check("真实宿主 skill 卸载后文件删除", existsSync(join(home, "skills", "real-host-skill")), false);

  const lifecycleFirst = await api("/api/marketplace/install", { method: "POST", body: { repo: lifecycleRepo, answers: {} } });
  check("真实宿主 lifecycle 返回确认状态", [lifecycleFirst.status, lifecycleFirst.body?.status, lifecycleFirst.body?.type, lifecycleFirst.body?.questions?.[0]?.id], [200, "awaiting-input", "cordis-plugin", "__confirm_npm_scripts__"]);
  check("真实宿主 lifecycle 确认顺序可见", lifecycleFirst.body?.questions?.[0]?.question?.includes("preinstall, install, postinstall, prepare"), true);
  const lifecycleCancel = await api("/api/marketplace/install", { method: "POST", body: { repo: lifecycleRepo, answers: { __confirm_npm_scripts__: "deny" } } });
  check("真实宿主 lifecycle cancel 返回 aborted", [lifecycleCancel.status, lifecycleCancel.body?.status], [200, "aborted"]);
  check("真实宿主 lifecycle cancel 清理缓存", existsSync(join(home, "marketplace", "cache", "real-closure__real-lifecycle")), false);

  const alternate = "desktop";
  const marker = (list0.body?.repos ?? []).find((repo) =>
    repo.installed !== true
    && typeof repo.full_name === "string"
    && typeof repo.name === "string"
    && /^[a-zA-Z0-9][a-zA-Z0-9._~-]*$/.test(repo.name)
  );
  if (marker) {
    const markerDir = join(desktopProfile, "node_modules", marker.name);
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, "package.json"), JSON.stringify({
      name: marker.pkg_name ?? marker.name,
      version: "1.0.0",
      repository: marker.full_name,
    }), "utf8");
  }
  const profile1 = await api("/api/marketplace/profile", { method: "POST", body: { profile: alternate } });
  check("真实宿主 profile 切换到 desktop", [profile1.status, profile1.body?.profile], [200, alternate]);
  const list1 = await api("/api/marketplace/list?refresh=1&lang=zh-CN");
  const markerAfter = marker && list1.body?.repos?.find((repo) => repo.full_name === marker.full_name);
  const markerBefore = marker && list0.body?.repos?.find((repo) => repo.full_name === marker.full_name);
  check("真实宿主切换后 profile 标注重新计算", [markerBefore?.installed, markerAfter?.installed, list1.body?.fp !== list0.body?.fp], [false, true, true]);
  const profile2 = await api("/api/marketplace/profile", { method: "POST", body: { profile: "web" } });
  check("真实宿主 profile 切回 web", [profile2.status, profile2.body?.profile], [200, "web"]);
  check("真实宿主非法 profile 仍返回 400", (await api("/api/marketplace/profile", { method: "POST", body: { profile: "../evil" } })).status, 400);
} catch (error) {
  fail++;
  console.log(`FAIL real-host runtime closure: ${error?.stack ?? error}`);
} finally {
  cleanup();
}

console.log(`\nreal-host runtime closure e2e: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
