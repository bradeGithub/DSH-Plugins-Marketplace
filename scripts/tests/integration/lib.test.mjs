#!/usr/bin/env node
// lib/index.js 导出函数全覆盖测试：mock fetch + 临时 DSH_HOME + 假 ctx。
// 运行：node scripts/lib-tests.mjs
// 与 smoke-tests.mjs 共用 check() 风格；coverage.mjs 同时统计两者。
// 注意：必须用动态 import 控制加载顺序——静态 import 会被提升，lib/index.js
// 求值时 process.env.DSH_HOME 尚未设置，模块级常量会回退到真实 ~/.dsh（污染主目录）。

import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---- mock 基建：临时 DSH_HOME（必须在 import lib 之前设置）----
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-libtest-")).replace(/\\/g, "/");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

// ---- mock：全局 fetch ----
function mockFetch(payload, status = 200) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
  });
  return orig;
}

(async () => {
  const lib = await import("../../../lib/index.js");

  // ==================== 纯函数 ====================
  check("isSensitiveEnvKey GITHUB_TOKEN", lib.isSensitiveEnvKey("GITHUB_TOKEN"), true);
  check("isSensitiveEnvKey PATH", lib.isSensitiveEnvKey("PATH"), false);
  check("buildMinimalEnv 过滤", lib.buildMinimalEnv({ GITHUB_TOKEN: "x", PATH: "y" }).PATH !== undefined, true);
  check("looksLikeDshPlugin 插件", lib.looksLikeDshPlugin({ dsh: {} }), true);
  check("normalizeRepoRef 前缀", lib.normalizeRepoRef("https://github.com/a/b"), "a/b");
  check("normalizeRepoRef 裸", lib.normalizeRepoRef("a/b"), "a/b");
  check("hasPatchEntry 存在", lib.hasPatchEntry("name: b", "b"), true);
  check("hasPatchEntry 缺失", lib.hasPatchEntry("name: a", "b"), false);
  check("normalizeRepo github", lib.normalizeRepo({ full_name: "owner/repo", html_url: "https://github.com/owner/repo" }).full_name, "owner/repo");
  check("compareVersions 基础", lib.compareVersions("1.0.0", "1.0.1"), -1);
  check("isTrustedHost 本地", lib.isTrustedHost("127.0.0.1:3080"), true);
  check("isTrustedHost 外网", lib.isTrustedHost("evil.com:3080"), false);
  check("isPnpmLocalDependency link", lib.isPnpmLocalDependency("link:../x"), true);
  check("isPnpmLocalDependency 版本", lib.isPnpmLocalDependency("^1.0.0"), false);
  check("langOf zh", lib.langOf({ headers: {} }, "zh-CN"), "zh");
  check("t 中文键", typeof lib.t("zh", "install"), "string");
  check("normalizeRepo 对象入参", lib.normalizeRepo({ full_name: "a/b", html_url: "https://github.com/a/b" }).full_name, "a/b");
  check("sanitizeManifest 返回类型", typeof lib.sanitizeManifest({ name: "x" }), "object");

  // ---- dedupeReposByPkgName（pkg_name 冲突消解：已装优先，其次 Star 高者）----
  // 不传 isInstalled 参数：触发默认闭包 `isInstalled = (r) => installedMap.has(r.full_name)`
  // 与内部 `rank` 闭包（isInstalled 命中时 +1e12 权重）。
  const dupRepos = [
    { full_name: "a/low", name: "low", pkg_name: "shared-pkg", stargazers_count: 5 },
    { full_name: "a/high", name: "high", pkg_name: "shared-pkg", stargazers_count: 100 },
  ];
  check("dedupe 默认参数 冲突保留高 Star", lib.dedupeReposByPkgName(dupRepos).map((r) => r.full_name), ["a/high"]);
  check("dedupe 默认参数 只留一条", lib.dedupeReposByPkgName(dupRepos).length, 1);
  const dupInstalled = [
    { full_name: "x/inst", name: "inst", pkg_name: "p", stargazers_count: 0 },
    { full_name: "x/star", name: "star", pkg_name: "p", stargazers_count: 999 },
  ];
  check("dedupe 已装优先（rank 1e12 分支）", lib.dedupeReposByPkgName(dupInstalled, (r) => r.full_name === "x/inst").map((r) => r.full_name), ["x/inst"]);
  check("dedupe 无 pkg_name 不冲突", lib.dedupeReposByPkgName([
    { full_name: "u/v", name: "v", stargazers_count: 1 },
    { full_name: "u/w", name: "w", stargazers_count: 2 },
  ]).map((r) => r.full_name), ["u/v", "u/w"]);

  // ==================== 文件 IO（临时 DSH_HOME）====================
  // 构造临时仓库目录（含 package.json）
  const repoDir = join(process.env.DSH_HOME, "test-repo");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "test/pkg", version: "1.2.3", repository: { url: "https://github.com/test/pkg" } }));

  check("readPackageSummary name", (await lib.readPackageSummary(repoDir))?.name, "test/pkg");
  check("loadOwnRepo 返回对象或 null", (() => { const r = lib.loadOwnRepo(); return r === null || typeof r === "object"; })(), true);
  check("detectSkillInstalled 无", await lib.detectSkillInstalled("none"), false);
  check("isOfficialPackage 官方", await lib.isOfficialPackage("@deepseek-ai/dsh"), true);
  check("isOfficialPackage 非官方", await lib.isOfficialPackage("owner/x"), false);
  check("readLifecycleScripts 空返回数组", Array.isArray(await lib.readLifecycleScripts(repoDir)), true);

  // needsPluginBuild / collectExportTargets（递归收集 exports 子树全部字符串入口）
  const srcOnly = join(process.env.DSH_HOME, "src-only");
  mkdirSync(srcOnly, { recursive: true });
  writeFileSync(join(srcOnly, "package.json"), JSON.stringify({
    name: "src-only",
    version: "1.0.0",
    scripts: { build: "tsc" },
    main: "dist/index.js",
    exports: {
      ".": { import: "./dist/index.mjs", require: { default: "./dist/index.cjs" } },
      "./client": "./dist/client.js",
    },
  }));
  check("needsPluginBuild 源码缺失需构建", await lib.needsPluginBuild(srcOnly), true);
  const built = join(process.env.DSH_HOME, "built");
  mkdirSync(built, { recursive: true });
  writeFileSync(join(built, "package.json"), JSON.stringify({ name: "built", version: "1.0.0", scripts: { build: "tsc" }, main: "index.js" }));
  writeFileSync(join(built, "index.js"), "export default {}\n");
  check("needsPluginBuild main 存在不需构建", await lib.needsPluginBuild(built), false);
  const noBuild = join(process.env.DSH_HOME, "no-build");
  mkdirSync(noBuild, { recursive: true });
  writeFileSync(join(noBuild, "package.json"), JSON.stringify({ name: "no-build", version: "1.0.0", main: "index.js" }));
  check("needsPluginBuild 无 build 脚本", await lib.needsPluginBuild(noBuild), false);

  // scanProfilePackages（Map 类型）
  const scanned = await lib.scanProfilePackages();
  check("scanProfilePackages 是 Map", scanned instanceof Map, true);

  // matchProfileEntry（Map profile + repo 对象 + keys）
  const prof = new Map([["a/b", { name: "a/b", version: "1.0.0", repository: "a/b" }]]);
  const matched = await lib.matchProfileEntry(prof, { full_name: "a/b" }, ["a/b"]);
  check("matchProfileEntry 命中", matched?.name, "a/b");
  const matchedNull = await lib.matchProfileEntry(new Map(), { full_name: "x/y" }, ["x/y"]);
  check("matchProfileEntry 未命中", matchedNull, null);

  // detectInstalled（repo 对象，返回 boolean；无安装记录 → false）
  check("detectInstalled 未装", await lib.detectInstalled({ full_name: "none/repo", name: "repo" }), false);
  check("detectInstalled 类型", typeof (await lib.detectInstalled({ full_name: "owner/repo", name: "repo" })), "boolean");

  // appendPatchEntry（entryId + pkgName，返回 boolean 是否追加）
  mkdirSync(join(process.env.DSH_HOME, "profiles", "web"), { recursive: true });
  const appended = await lib.appendPatchEntry("test-entry", "test/pkg");
  check("appendPatchEntry 返回布尔", typeof appended, "boolean");

  // 网络类（mock fetch）
  const items = [{ full_name: "a/b", stargazers_count: 5, updated_at: "2026-01-01T00:00:00Z", description: "x", html_url: "https://github.com/a/b", clone_url: "https://github.com/a/b.git" }];
  const orig1 = mockFetch({ items, total_count: 1 });
  const list = await lib.getList("dsh", true);
  globalThis.fetch = orig1;
  check("getList mock 数组", Array.isArray(list), true);

  // fetchAllRepos
  const orig2 = mockFetch({ items, total_count: 1 });
  const all = await lib.fetchAllRepos();
  globalThis.fetch = orig2;
  check("fetchAllRepos 数组", Array.isArray(all), true);

  // fetchRegistryRepos（registry 结构: { repos: [], generated_at }）
  const registryPayload = { repos: [{ full_name: "a/b", stargazers_count: 5, updated_at: "2026-01-01T00:00:00Z", description: "x", html_url: "https://github.com/a/b" }], generated_at: new Date().toISOString() };
  const orig3 = mockFetch(registryPayload);
  const reg = await lib.fetchRegistryRepos("dsh");
  globalThis.fetch = orig3;
  check("fetchRegistryRepos 数组", Array.isArray(reg), true);

  // fetchJson 错误路径（fetchJson 未导出，经 fetchAllRepos 内部触发）：
  // 所有 registry 源返回 403 → 回退搜索 API → fetchJson 抛错被捕获（含
  // res.text() 失败时的 .catch(() => "") 分支）→ 降级返回空数组。
  const orig5 = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => { throw new Error("text boom"); } });
  const degraded = await lib.fetchAllRepos("dsh");
  globalThis.fetch = orig5;
  check("fetchAllRepos 全失败降级空数组", Array.isArray(degraded) && degraded.length === 0, true);

  // apply(ctx) mock：验证路由注册（install handler 依赖真实 git/npm 子进程，属 e2e 覆盖）
  let registered = [];
  const fakeCtx = {
    get: (s) => (s === "webServer" ? { register: (r) => registered.push(r) } : undefined),
    logger: { warn: () => {} },
    slots: { inject: () => {} },
  };
  lib.apply(fakeCtx);
  check("apply 注册路由", registered.length > 0, true);
  check("apply 注册 install 路由", registered.some((r) => r.path === "/api/marketplace/install"), true);
  check("apply 注册 skills 路由", registered.some((r) => r.path === "/api/marketplace/skills"), true);

  // ---- list handler：触发并发 worker 闭包 + pkg 冲突消解 + 已安装置顶排序 ----
  // 造一个 skills/<slug> 目录让 o/a 命中 detectInstalled 目录启发式（已安装）。
  mkdirSync(join(process.env.DSH_HOME, "skills", "a"), { recursive: true });
  const mkRepo = (full_name, name, over = {}) => ({
    full_name, name, stargazers_count: 0, html_url: `https://github.com/${full_name}`,
    updated_at: "2026-01-01T00:00:00Z", description: "x", topics: [], license: null,
    default_branch: "main", has_skill: null, has_install_script: null, ...over,
  });
  const repos4 = [
    mkRepo("o/a", "a", { pkg_name: "shared-pkg", stargazers_count: 5, has_skill: false }),
    mkRepo("o/b", "b", { pkg_name: "shared-pkg", stargazers_count: 50, has_skill: true }),
    mkRepo("o/c", "c", { pkg_name: "shared-pkg2", stargazers_count: 3, has_skill: null }),
    mkRepo("o/d", "d", { pkg_name: "shared-pkg2", stargazers_count: 30, has_skill: true }),
  ];
  const listHandler = registered.find((h) => h.path === "/api/marketplace/list")?.handler;
  if (listHandler) {
    const origList = mockFetch({ repos: repos4, generated_at: new Date().toISOString() });
    let listStatus = 0;
    let listBody = null;
    await listHandler({ method: "GET", headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" }, url: "/api/marketplace/list?refresh=1" },
      { writeHead: (s) => { listStatus = s; }, end: (b) => { try { listBody = JSON.parse(b); } catch { listBody = null; } } });
    globalThis.fetch = origList;
    check("list worker 标注 200", listStatus, 200);
    // 注：响应会叠加适配层（adaptor.json）补入的真实条目（如 yejiming/dsh-museai-tavern），
    // 断言按 mock 前缀 o/ 过滤，与适配层内容解耦。
    const mockRepos = listBody && listBody.repos.filter((r) => r.full_name.startsWith("o/"));
    check("list worker 已安装置顶 + 冲突保留", mockRepos && mockRepos.map((r) => r.full_name), ["o/a", "o/d"]);
    check("list worker installed 标注", mockRepos && mockRepos.map((r) => r.installed), [true, false]);
    check("list worker updateAvailable 布尔", listBody && typeof listBody.repos[0].updateAvailable, "boolean");
  } else {
    check("list handler 存在", false, true);
  }

  // ---- skills handler：过滤 has_skill!==false + 已安装标注 + 排序 ----
  const skillsHandler = registered.find((h) => h.path === "/api/marketplace/skills")?.handler;
  if (skillsHandler) {
    const origSkills = mockFetch({ repos: repos4, generated_at: new Date().toISOString() });
    let skillsStatus = 0;
    let skillsBody = null;
    await skillsHandler({ method: "GET", headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" }, url: "/api/marketplace/skills?refresh=1" },
      { writeHead: (s) => { skillsStatus = s; }, end: (b) => { try { skillsBody = JSON.parse(b); } catch { skillsBody = null; } } });
    globalThis.fetch = origSkills;
    check("skills 过滤 200", skillsStatus, 200);
    check("skills 过滤 has_skill!==false + 冲突保留", skillsBody && skillsBody.repos.map((r) => r.full_name), ["o/b", "o/d"]);
    check("skills filtered 计数", skillsBody && skillsBody.filtered, 3);
  } else {
    check("skills handler 存在", false, true);
  }

  // ---- 适配层（adaptor.json 硬编码重定向）----
  check("adaptorRedirectRepo MuseAI → tavern", lib.adaptorRedirectRepo("yejiming/MuseAI"), "yejiming/dsh-museai-tavern");
  check("adaptorRedirectRepo 无关仓库 null", lib.adaptorRedirectRepo("some/other"), null);
  check("adaptorRedirectRepo 空值 null", lib.adaptorRedirectRepo(null), null);
  const adapted = lib.applyAdaptorList([
    { full_name: "yejiming/MuseAI", name: "MuseAI" },
    { full_name: "a/b", name: "b" }
  ]);
  check("applyAdaptorList 移除错误条目", adapted.some((r) => r.full_name === "yejiming/MuseAI"), false);
  check("applyAdaptorList 补入真实条目", adapted.some((r) => r.full_name === "yejiming/dsh-museai-tavern"), true);
  check("applyAdaptorList 保留无关条目", adapted.some((r) => r.full_name === "a/b"), true);
  check("applyAdaptorList 非数组原样返回", lib.applyAdaptorList(null), null);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
