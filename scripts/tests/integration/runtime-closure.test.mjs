#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const originalFetch = globalThis.fetch;
const home = mkdtempSync(join(tmpdir(), "dsh-runtime-closure-"));
process.env.DSH_HOME = home.replace(/\\/g, "/");
const marketRoot = join(home, "marketplace");
const cacheRoot = join(marketRoot, "cache");
const listCacheRoot = join(marketRoot, "list-cache");
const skillsRoot = join(home, "skills");
const presetsRoot = join(home, ".agent-presets");
const profilesRoot = join(home, "profiles");

mkdirSync(cacheRoot, { recursive: true });
mkdirSync(listCacheRoot, { recursive: true });
mkdirSync(skillsRoot, { recursive: true });
mkdirSync(presetsRoot, { recursive: true });
for (const profile of ["web", "desktop"]) {
  const dir = join(profilesRoot, profile);
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `${profile}-profile`, private: true }), "utf8");
  writeFileSync(join(dir, "cordis.patch.yml"), "# runtime closure\n", "utf8");
}

const repoOf = (fullName, over = {}) => ({
  full_name: fullName,
  name: fullName.split("/")[1],
  description: "runtime closure fixture",
  html_url: `https://github.com/${fullName}`,
  stargazers_count: 10,
  updated_at: "2026-01-01T00:00:00Z",
  default_branch: "main",
  topics: [],
  license: null,
  pkg_name: null,
  version: null,
  category: null,
  has_skill: null,
  has_install_script: false,
  ...over,
});

const dshRepos = [
  repoOf("closure-owner/closure-skill", { has_skill: true }),
  repoOf("closure-owner/closure-preset"),
  repoOf("closure-owner/closure-plugin", { pkg_name: "closure-plugin" }),
  repoOf("closure-owner/closure-lifecycle", { pkg_name: "closure-lifecycle" }),
  repoOf("closure-owner/closure-desktop-plugin", { pkg_name: "closure-desktop-plugin" }),
];
const skillsRepos = [repoOf("closure-owner/closure-skill", { has_skill: true })];

const response = (payload) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  arrayBuffer: async () => Buffer.from(JSON.stringify(payload)),
  json: async () => payload,
  text: async () => JSON.stringify(payload),
});

globalThis.fetch = async (url) => {
  const text = String(url);
  if (text.includes("/search/repositories")) return response({ items: [], total_count: 0 });
  const repos = text.includes("skills") ? skillsRepos : dshRepos;
  return response({ repos, generated_at: new Date().toISOString() });
};

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
    pass++;
    console.log(`PASS ${name}`);
  } catch (error) {
    fail++;
    console.log(`FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

function cacheDirFor(repo) {
  const [owner, name] = repo.split("/");
  return join(cacheRoot, `${owner.toLowerCase()}__${name.toLowerCase()}`);
}

function putCache(repo, files) {
  const root = cacheDirFor(repo);
  mkdirSync(root, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, relative);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  return root;
}

function request(method, url, body) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return {
    method,
    url,
    headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" },
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() {
      if (payload) yield payload;
    },
  };
}

async function invoke(handler, method, url, body) {
  const out = { status: 0, body: null };
  await handler(request(method, url, body), {
    writeHead: (status) => { out.status = status; },
    end: (text) => {
      try { out.body = JSON.parse(text); } catch { out.body = text; }
    },
  });
  return out;
}

function installedMap(body) {
  return Object.fromEntries((body?.repos ?? []).map((repo) => [repo.full_name, repo.installed]));
}

try {
  const lib = await import("../../../lib/index.js");
  const handlers = [];
  lib.apply({
    get: (service) => service === "webServer"
      ? { register: (route) => handlers.push(route) }
      : undefined,
    logger: { warn: () => {}, info: () => {} },
  });

  const handler = (path) => handlers.find((route) => route.path === path)?.handler;
  const listHandler = handler("/api/marketplace/list");
  const skillsHandler = handler("/api/marketplace/skills");
  const installHandler = handler("/api/marketplace/install");
  const uninstallHandler = handler("/api/marketplace/uninstall");
  const profileHandler = handler("/api/marketplace/profile");
  check("runtime closure 路由全部注册", [!!listHandler, !!skillsHandler, !!installHandler, !!uninstallHandler, !!profileHandler], [true, true, true, true, true]);

  const skillRepo = "closure-owner/closure-skill";
  const presetRepo = "closure-owner/closure-preset";
  const pluginRepo = "closure-owner/closure-plugin";
  const lifecycleRepo = "closure-owner/closure-lifecycle";
  const desktopPluginRepo = "closure-owner/closure-desktop-plugin";

  const skillCache = putCache(skillRepo, {
    "SKILL.md": "---\nname: closure-skill\n---\n# closure skill\n",
  });
  const presetCache = putCache(presetRepo, {
    "preset.yml": "name: closure-preset\n",
    "agent.cordis.yml": "name: closure-preset\n",
  });
  const pluginCache = putCache(pluginRepo, {
    "package.json": JSON.stringify({ name: "closure-plugin", version: "1.2.3", dsh: {}, main: "index.js" }),
    "index.js": "module.exports = {};\n",
  });
  const lifecycleCache = putCache(lifecycleRepo, {
    "package.json": JSON.stringify({
      name: "closure-lifecycle",
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
  });
  const desktopPluginCache = putCache(desktopPluginRepo, {
    "package.json": JSON.stringify({ name: "closure-desktop-plugin", version: "2.0.0", dsh: {}, main: "index.js" }),
    "index.js": "module.exports = {};\n",
  });
  const ordinaryCache = putCache("closure-owner/closure-ordinary", {
    "package.json": JSON.stringify({ name: "closure-ordinary", version: "1.0.0", main: "index.js" }),
    "index.js": "module.exports = {};\n",
  });

  check("list 返回 runtime fixture", (await invoke(listHandler, "GET", "/api/marketplace/list")).body?.repos?.some((repo) => repo.full_name === skillRepo), true);
  const skillsInitial = await invoke(skillsHandler, "GET", "/api/marketplace/skills?refresh=1");
  check("Skills 列表返回 fixture", [skillsInitial.status, skillsInitial.body?.repos?.length, skillsInitial.body?.total], [200, 1, 1]);

  check("skill 类型识别", (await lib.detectTypeDetail(skillCache)).type, "skill");
  check("preset 类型识别", (await lib.detectTypeDetail(presetCache)).type, "agent-preset");
  check("plugin 类型识别", (await lib.detectTypeDetail(pluginCache)).type, "cordis-plugin");
  check("普通 package 保持 cordis-plugin 判定并交给确认门", (await lib.detectTypeDetail(ordinaryCache)).type, "cordis-plugin");
  check("lifecycle 读取顺序保持 preinstall/install/postinstall/prepare", await lib.readLifecycleScripts(lifecycleCache), ["preinstall", "install", "postinstall", "prepare"]);

  let result = await invoke(installHandler, "POST", "/api/marketplace/install", { repo: skillRepo, answers: {} });
  check("skill 安装返回 done/type", [result.status, result.body?.status, result.body?.type], [200, "done", "skill"]);
  check("skill 安装目录和清单存在", [existsSync(join(skillsRoot, "closure-skill", "SKILL.md")), result.body?.name], [true, "closure-skill"]);

  result = await invoke(installHandler, "POST", "/api/marketplace/install", { repo: presetRepo, answers: {} });
  check("preset 安装返回 done/type", [result.status, result.body?.status, result.body?.type], [200, "done", "agent-preset"]);
  check("preset 安装文件存在", [existsSync(join(presetsRoot, "closure-preset", "preset.yml")), existsSync(join(presetsRoot, "closure-preset", "agent.cordis.yml"))], [true, true]);

  result = await invoke(installHandler, "POST", "/api/marketplace/install", { repo: pluginRepo, answers: {} });
  check("plugin 安装返回 done/type/version", [result.status, result.body?.status, result.body?.type, result.body?.version], [200, "done", "cordis-plugin", "1.2.3"]);
  check("plugin 安装到 web profile 并注册 patch", [existsSync(join(home, "profiles", "web", "node_modules", "closure-plugin", "index.js")), /name:\s*closure-plugin/.test(readFileSync(join(home, "profiles", "web", "cordis.patch.yml"), "utf8"))], [true, true]);

  result = await invoke(installHandler, "POST", "/api/marketplace/install", { repo: lifecycleRepo, answers: {} });
  check("lifecycle 首次请求等待确认", [result.status, result.body?.status, result.body?.questions?.[0]?.id], [200, "awaiting-input", "__confirm_npm_scripts__"]);
  check("lifecycle 确认问题保持固定顺序", result.body?.questions?.[0]?.question?.includes("preinstall, install, postinstall, prepare"), true);
  const repeated = await invoke(installHandler, "POST", "/api/marketplace/install", { repo: lifecycleRepo, answers: {} });
  check("lifecycle 重复等待复用缓存且不重新 clone", [repeated.body?.status, repeated.body?.log?.some((line) => line.includes("Cloning")), repeated.body?.log?.some((line) => /复用本地缓存|reuse|cache/i.test(line))], ["awaiting-input", false, true]);
  result = await invoke(installHandler, "POST", "/api/marketplace/install", { repo: lifecycleRepo, answers: { __confirm_npm_scripts__: "deny" } });
  check("lifecycle deny 返回 aborted 并清理缓存", [result.body?.status, existsSync(lifecycleCache)], ["aborted", false]);
  putCache(lifecycleRepo, {
    "package.json": JSON.stringify({
      name: "closure-lifecycle",
      version: "1.0.0",
      dsh: {},
      main: "index.js",
      scripts: { preinstall: "echo preinstall", install: "echo install", postinstall: "echo postinstall", prepare: "echo prepare" },
    }),
    "index.js": "module.exports = {};\n",
  });
  result = await invoke(installHandler, "POST", "/api/marketplace/install", { repo: lifecycleRepo, answers: { __confirm_npm_scripts__: "allow" } });
  check("lifecycle allow 进入安装并返回 done", [result.body?.status, result.body?.type], ["done", "cordis-plugin"]);

  const listInstalled = await invoke(listHandler, "GET", "/api/marketplace/list");
  check("list 标注三类安装结果", [installedMap(listInstalled.body)[skillRepo], installedMap(listInstalled.body)[presetRepo], installedMap(listInstalled.body)[pluginRepo]], [true, true, true]);
  const skillsInstalled = await invoke(skillsHandler, "GET", "/api/marketplace/skills?refresh=1");
  check("Skills 标注已安装 skill", installedMap(skillsInstalled.body)[skillRepo], true);

  const profileInitial = await invoke(profileHandler, "GET", "/api/marketplace/profile");
  check("profile 初始为 web", [profileInitial.status, profileInitial.body?.profile], [200, "web"]);
  check("非法 profile 被拒绝", (await invoke(profileHandler, "POST", "/api/marketplace/profile", { profile: "../evil" })).status, 400);
  check("不存在 profile 被拒绝", (await invoke(profileHandler, "POST", "/api/marketplace/profile", { profile: "ghost" })).status, 400);
  check("profile 切换到 desktop", [(await invoke(profileHandler, "POST", "/api/marketplace/profile", { profile: "desktop" })).status, (await invoke(profileHandler, "GET", "/api/marketplace/profile")).body?.profile], [200, "desktop"]);

  result = await invoke(installHandler, "POST", "/api/marketplace/install", { repo: desktopPluginRepo, answers: {} });
  check("desktop profile plugin 安装到当前 profile", [result.body?.status, existsSync(join(home, "profiles", "desktop", "node_modules", "closure-desktop-plugin", "index.js")), existsSync(join(home, "profiles", "web", "node_modules", "closure-desktop-plugin"))], ["done", true, false]);

  check("profile 切回 web", [(await invoke(profileHandler, "POST", "/api/marketplace/profile", { profile: "web" })).status, (await invoke(profileHandler, "GET", "/api/marketplace/profile")).body?.profile], [200, "web"]);
  result = await invoke(uninstallHandler, "POST", "/api/marketplace/uninstall", { repo: desktopPluginRepo });
  check("跨 profile 卸载删除真实 desktop 目录", [result.body?.status, existsSync(join(home, "profiles", "desktop", "node_modules", "closure-desktop-plugin"))], ["done", false]);

  for (const [repo, location] of [
    [pluginRepo, join(home, "profiles", "web", "node_modules", "closure-plugin")],
    [lifecycleRepo, join(home, "profiles", "web", "node_modules", "closure-lifecycle")],
    [presetRepo, join(presetsRoot, "closure-preset")],
    [skillRepo, join(skillsRoot, "closure-skill")],
  ]) {
    result = await invoke(uninstallHandler, "POST", "/api/marketplace/uninstall", { repo });
    check(`${repo} 卸载返回 done`, [result.status, result.body?.status], [200, "done"]);
    check(`${repo} 卸载后受管目录删除`, existsSync(location), false);
  }

  const listFinal = await invoke(listHandler, "GET", "/api/marketplace/list");
  check("list 安装卸载闭环后标注翻回未安装", [installedMap(listFinal.body)[skillRepo], installedMap(listFinal.body)[presetRepo], installedMap(listFinal.body)[pluginRepo]], [false, false, false]);
  const skillsFinal = await invoke(skillsHandler, "GET", "/api/marketplace/skills?refresh=1");
  check("Skills 安装卸载闭环后标注翻回未安装", installedMap(skillsFinal.body)[skillRepo], false);
} catch (error) {
  fail++;
  console.log(`FAIL runtime closure unexpected error: ${error?.stack ?? error}`);
} finally {
  globalThis.fetch = originalFetch;
  rmSync(home, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
