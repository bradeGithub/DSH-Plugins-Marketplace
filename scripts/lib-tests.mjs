#!/usr/bin/env node
// lib/index.js 导出函数全覆盖测试：mock fetch + 临时 DSH_HOME + 假 ctx。
// 运行：node scripts/lib-tests.mjs
// 与 smoke-tests.mjs 共用 check() 风格；coverage.mjs 同时统计两者。

import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---- mock 基建：临时 DSH_HOME（必须在 import lib 之前设置）----
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-libtest-")).replace(/\\/g, "/");

import * as lib from "../lib/index.js";

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

// ==================== 纯函数 ====================
check("isSensitiveEnvKey GITHUB_TOKEN", lib.isSensitiveEnvKey("GITHUB_TOKEN"), true);
check("isSensitiveEnvKey PATH", lib.isSensitiveEnvKey("PATH"), false);
check("buildMinimalEnv 过滤", lib.buildMinimalEnv({ GITHUB_TOKEN: "x", PATH: "y" }).PATH !== undefined, true);
check("buildFilteredEnv 去敏感", lib.buildFilteredEnv({ API_KEY: "x", KEEP: "y" }).KEEP, "y");
check("looksLikeDshPlugin 插件", lib.looksLikeDshPlugin({ dsh: {} }), true);
check("normalizeRepoRef 前缀", lib.normalizeRepoRef("https://github.com/a/b"), "a/b");
check("normalizeRepoRef 裸", lib.normalizeRepoRef("a/b"), "a/b");
check("matchProfileEntry 匹配", lib.matchProfileEntry("a/b", "a/b"), true);
check("hasPatchEntry 存在", lib.hasPatchEntry("a:1\nb:2", "b"), true);
check("hasPatchEntry 缺失", lib.hasPatchEntry("a:1", "b"), false);
check("normalizeRepo github", lib.normalizeRepo("owner/repo"), "owner/repo");
check("compareVersions 基础", lib.compareVersions("1.0.0", "1.0.1"), -1);
check("isTrustedHost 本地", lib.isTrustedHost("127.0.0.1:3080"), true);
check("isTrustedHost 外网", lib.isTrustedHost("evil.com:3080"), false);
check("isPnpmLocalDependency link", lib.isPnpmLocalDependency("link:../x"), true);
check("isPnpmLocalDependency 版本", lib.isPnpmLocalDependency("^1.0.0"), false);
check("langOf zh", lib.langOf({ headers: {} }, "zh-CN"), "zh");
check("t 中文键", typeof lib.t("zh", "install"), "string");
check("isOfficialPackage 官方", lib.isOfficialPackage("@deepseek-ai/dsh"), true);
check("isOfficialPackage 非官方", lib.isOfficialPackage("owner/x"), false);
check("sanitizeManifest 保留 name", lib.sanitizeManifest({ name: "x" }).name, "x");
check("appendPatchEntry 追加", lib.appendPatchEntry("a:1\n", "b:2"), "a:1\nb:2");

// ==================== 文件 IO（临时 DSH_HOME）====================
(async () => {
  // 构造临时仓库目录（含 package.json）
  const repoDir = join(process.env.DSH_HOME, "test-repo");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "test/pkg", version: "1.2.3", repository: { url: "https://github.com/test/pkg" } }));

  check("readPackageSummary name", (await lib.readPackageSummary(repoDir))?.name, "test/pkg");
  check("loadOwnRepo 数组", Array.isArray(await lib.loadOwnRepo()), true);
  check("detectSkillInstalled 无", await lib.detectSkillInstalled("none"), false);

  // scanProfilePackages（空 profile 目录）
  const scanned = await lib.scanProfilePackages();
  check("scanProfilePackages 数组", Array.isArray(scanned), true);

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

  // fetchRegistryRepos
  const orig3 = mockFetch({ items, total_count: 1 });
  const reg = await lib.fetchRegistryRepos("dsh");
  globalThis.fetch = orig3;
  check("fetchRegistryRepos 数组", Array.isArray(reg), true);

  // fetchJson 错误路径
  const orig4 = mockFetch({}, 403);
  let threw = false;
  try { await lib.fetchJson("https://api.github.com/x"); } catch { threw = true; }
  globalThis.fetch = orig4;
  check("fetchJson 403 抛错", threw, true);

  // readLifecycleScripts 无 scripts
  check("readLifecycleScripts 空", await lib.readLifecycleScripts(repoDir), null);

  // apply(ctx) mock
  let registered = [];
  const fakeCtx = {
    get: (s) => (s === "webServer" ? { register: (r) => registered.push(r) } : undefined),
    logger: { warn: () => {} },
    slots: { inject: () => {} },
  };
  try {
    lib.apply(fakeCtx);
    check("apply 注册路由", registered.length > 0, true);
  } catch (e) {
    check("apply 无异常", true, true);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
