#!/usr/bin/env node
// lib/index.js 导出函数全覆盖测试：mock fetch + 临时 DSH_HOME + 假 ctx。
// 运行：node scripts/lib-tests.mjs
// 与 smoke-tests.mjs 共用 check() 风格；coverage.mjs 同时统计两者。
// 注意：必须用动态 import 控制加载顺序——静态 import 会被提升，lib/index.js
// 求值时 process.env.DSH_HOME 尚未设置，模块级常量会回退到真实 ~/.dsh（污染主目录）。

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

// ---- mock 基建：临时 DSH_HOME（必须在 import lib 之前设置）----
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-libtest-")).replace(/\\/g, "/");
// 预写 installed.json（loadInstalled 在模块加载时执行）：注入一条已安装记录，
// 供 restore/webdav 的 already 分支判定（installedMap 由该文件填充）。
// 键名与全部现有断言解耦（无测试引用该仓库名）。
mkdirSync(join(process.env.DSH_HOME, "marketplace"), { recursive: true });
writeFileSync(join(process.env.DSH_HOME, "marketplace", "installed.json"), JSON.stringify({
  "none/already-installed": { type: "skill", name: "already-installed", location: join(process.env.DSH_HOME, "skills", "already-installed"), installedAt: Date.now() }
}, null, 2), "utf8");

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
  // 回归:插件市场(dsh)模式不得输出 has_skill(否则满屏「未验证」);skills 模式保留三态
  check("normalizeRepo dsh 无 has_skill", "has_skill" in lib.normalizeRepo({ full_name: "a/b", has_skill: null }), false);
  check("normalizeRepo skills 保留三态", lib.normalizeRepo({ full_name: "a/b", has_skill: null }, "skills").has_skill, null);
  check("normalizeRepo skills true", lib.normalizeRepo({ full_name: "a/b", has_skill: true }, "skills").has_skill, true);
  // 回归:构建期盖章字段必须透传(否则徽章永不显示——market_tags/installable 被 normalizeRepo 丢掉)
  check("normalizeRepo 透传 market_tags", JSON.stringify(lib.normalizeRepo({ full_name: "a/b", market_tags: ["verified-install"] }).market_tags), JSON.stringify(["verified-install"]));
  check("normalizeRepo 透传 installable", lib.normalizeRepo({ full_name: "a/b", installable: "manual" }).installable, "manual");
  check("normalizeRepo 忽略无关 installable", lib.normalizeRepo({ full_name: "a/b", installable: "cordis-plugin" }).installable, undefined);
  check("compareVersions 基础", lib.compareVersions("1.0.0", "1.0.1"), -1);
  check("isTrustedHost 本地", lib.isTrustedHost("127.0.0.1:3080"), true);
  check("isTrustedHost 外网", lib.isTrustedHost("evil.com:3080"), false);
  check("isPnpmLocalDependency link", lib.isPnpmLocalDependency("link:../x"), true);
  check("isPnpmLocalDependency 版本", lib.isPnpmLocalDependency("^1.0.0"), false);
  check("langOf zh", lib.langOf({ headers: {} }, "zh-CN"), "zh");
  check("t 中文键", typeof lib.t("zh", "install"), "string");
  check("normalizeRepo 对象入参", lib.normalizeRepo({ full_name: "a/b", html_url: "https://github.com/a/b" }).full_name, "a/b");
  check("sanitizeManifest 返回类型", typeof lib.sanitizeManifest({ name: "x" }), "object");

  // ---- scanCliInstallHint（README 官方 CLI 安装指令识别）----
  const cliDir = join(process.env.DSH_HOME, "cli-hint");
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(join(cliDir, "README.md"), [
    "# Demo",
    "",
    "## 安装",
    "```bash",
    "dsh plugin install owner/demo-plugin",
    "```",
    "也可以 `dsh plugin add owner/demo-plugin`"
  ].join("\n"), "utf8");
  check("cliHint 命中 install 指令", await lib.scanCliInstallHint(cliDir, "owner/demo-plugin"), "dsh plugin install owner/demo-plugin");
  check("cliHint 大小写不敏感", await lib.scanCliInstallHint(cliDir, "OWNER/Demo-Plugin"), "dsh plugin install owner/demo-plugin");
  check("cliHint 其他仓库不命中", await lib.scanCliInstallHint(cliDir, "other/repo"), null);
  // dsh-market 实测写法：flags 在动词前 + 用 npm 包名（`dsh plugin --profile web add dshmarket`）
  const cliFlagsDir = join(process.env.DSH_HOME, "cli-flags");
  mkdirSync(cliFlagsDir, { recursive: true });
  writeFileSync(join(cliFlagsDir, "package.json"), JSON.stringify({ name: "dshmarket", version: "1.0.0", dsh: {} }), "utf8");
  writeFileSync(join(cliFlagsDir, "README.md"), "Install:\n```bash\ndsh plugin --profile web add dshmarket\n```\n", "utf8");
  check("cliHint flags+包名 写法", await lib.scanCliInstallHint(cliFlagsDir, "dsh-market/dsh-market"), "dsh plugin --profile web add dshmarket");
  // 负例：README 指令指向别的包/仓库时不提示（候选 = 仓库全名/仓库名/本包 package.json 的 name）
  const cliOtherDir = join(process.env.DSH_HOME, "cli-other");
  mkdirSync(cliOtherDir, { recursive: true });
  writeFileSync(join(cliOtherDir, "package.json"), JSON.stringify({ name: "dshmarket", version: "1.0.0", dsh: {} }), "utf8");
  writeFileSync(join(cliOtherDir, "README.md"), "Install with:\n```bash\ndsh plugin add somebody-else/another-market\n```\n", "utf8");
  check("cliHint 指令指向他包不命中", await lib.scanCliInstallHint(cliOtherDir, "dsh-market/dsh-market"), null);

  // ---- findCliInstall（安装流程执行用：tier-1 本仓库包 / tier-2 README 首条指令）----
  const cliExec1 = await lib.findCliInstall(cliDir, "owner/demo-plugin");
  check("findCliInstall tier-1 命中本仓库", cliExec1 && cliExec1.target, "owner/demo-plugin");
  check("findCliInstall tier-1 verb", cliExec1 && cliExec1.verb, "install");
  const cliExec2 = await lib.findCliInstall(cliFlagsDir, "dsh-market/dsh-market");
  check("findCliInstall tier-1 包名命中", cliExec2 && cliExec2.target, "dshmarket");
  // tier-2：README 首条指令指向聚合发布包（dsh-web-ui 场景）——scanCliInstallHint 不提示但执行路径采用
  const cliTier2Dir = join(process.env.DSH_HOME, "cli-tier2");
  mkdirSync(cliTier2Dir, { recursive: true });
  writeFileSync(join(cliTier2Dir, "package.json"), JSON.stringify({ name: "dsh-web-ui", version: "1.0.0", dsh: {} }), "utf8");
  writeFileSync(join(cliTier2Dir, "README.md"), "## 安装\n推荐聚合包:\n```bash\ndsh plugin --profile web add @linxin666/dsh-web-ui-all\n```\n", "utf8");
  const cliTier2 = await lib.findCliInstall(cliTier2Dir, "zhu1090093659/dsh-web-ui");
  check("findCliInstall tier-2 采用 README 首条指令", cliTier2 && cliTier2.target, "@linxin666/dsh-web-ui-all");
  check("findCliInstall tier-2 verb=add", cliTier2 && cliTier2.verb, "add");
  check("findCliInstall tier-2 时 scanCliInstallHint 仍为 null", await lib.scanCliInstallHint(cliTier2Dir, "zhu1090093659/dsh-web-ui"), null);
  const cliNone = await lib.findCliInstall(join(process.env.DSH_HOME, "cli-none-dir"), "owner/demo-plugin");
  check("findCliInstall 无指令 null", cliNone, null);

  // 相对路径/本地路径指令拒绝（dsh-deep-whale 场景：README 的 `add ../dsh-deep-whale/maid-atelier`
  // 是作者本地开发用法，依赖 cwd——市场代执行只会装出死链接，必须跳过）
  const cliRelDir = join(process.env.DSH_HOME, "cli-relpath");
  mkdirSync(cliRelDir, { recursive: true });
  writeFileSync(join(cliRelDir, "package.json"), JSON.stringify({ name: "demo-rel", version: "1.0.0", dsh: {} }), "utf8");
  writeFileSync(join(cliRelDir, "README.md"), [
    "# demo-rel",
    "## 安装",
    "```bash",
    "dsh plugin --profile web add ../demo-rel/maid-atelier",
    "```",
    "或本地绝对路径:",
    "```bash",
    "dsh plugin add C:\\work\\demo-rel\\maid-atelier",
    "```",
  ].join("\n"), "utf8");
  check("findCliInstall 相对路径不采用", await lib.findCliInstall(cliRelDir, "owner/demo-rel"), null);
  check("scanCliInstallHint 相对路径不提示", await lib.scanCliInstallHint(cliRelDir, "owner/demo-rel"), null);

  // ---- scanExternalCliHint（第三方 CLI 官方 DSH 接入指令识别，open-design 场景：
  // README 提供 `od agent setup deepseek-harness`，但市场无法代执行——只作展示提示）----
  const extCliDir = join(process.env.DSH_HOME, "cli-external");
  mkdirSync(extCliDir, { recursive: true });
  writeFileSync(join(extCliDir, "package.json"), JSON.stringify({ name: "open-design", version: "1.0.0" }), "utf8");
  writeFileSync(join(extCliDir, "README.md"), [
    "| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | ✅ Native runtime | `od agent setup deepseek-harness` |",
    "For DeepSeek Harness, install the official `dsh` CLI first, then select it in Open Design or run `od agent setup deepseek-harness` to install/repair OD's connection component.",
  ].join("\n"), "utf8");
  const extHint = await lib.scanExternalCliHint(extCliDir);
  check("externalCliHint 识别 od 指令", extHint && extHint.cli, "od");
  check("externalCliHint 命令完整", extHint && extHint.command, "od agent setup deepseek-harness");
  // 第三方 CLI 接入指令不应被当成 dsh plugin 安装指令（不执行、不提示为等效安装）
  check("externalCliHint 不影响 scanCliInstallHint", await lib.scanCliInstallHint(extCliDir, "nexu-io/open-design"), null);
  check("externalCliHint 不影响 findCliInstall", await lib.findCliInstall(extCliDir, "nexu-io/open-design"), null);
  // dsh 自身的 setup 指令不落入第三方扫描
  const extDshDir = join(process.env.DSH_HOME, "cli-external-dsh");
  mkdirSync(extDshDir, { recursive: true });
  writeFileSync(join(extDshDir, "README.md"), "```bash\ndsh agent setup deepseek-harness\n```\n", "utf8");
  check("externalCliHint 忽略 dsh 自身", await lib.scanExternalCliHint(extDshDir), null);
  check("externalCliHint 无指令目录 null", await lib.scanExternalCliHint(join(process.env.DSH_HOME, "nope")), null);

  // ---- findPresetRoots / 嵌套预设识别（dsh-anchored-standard 场景）----
  const presetNestedDir = join(process.env.DSH_HOME, "preset-nested");
  mkdirSync(join(presetNestedDir, "preset"), { recursive: true });
  mkdirSync(join(presetNestedDir, "whoami-standard"), { recursive: true });
  writeFileSync(join(presetNestedDir, "package.json"), JSON.stringify({ name: "demo-preset-nested", version: "1.0.0" }), "utf8");
  for (const sub of ["preset", "whoami-standard"]) {
    writeFileSync(join(presetNestedDir, sub, "preset.yml"), "# p\n", "utf8");
    writeFileSync(join(presetNestedDir, sub, "agent.cordis.yml"), "# a\n", "utf8");
  }
  const presetRoots = await lib.findPresetRoots(presetNestedDir);
  check("findPresetRoots 发现 2 个嵌套预设", presetRoots.length, 2);
  check("findPresetRoots 含 preset 目录", presetRoots.some((r) => r.endsWith("preset")), true);
  check("detectType 嵌套预设 → agent-preset", await lib.detectType(presetNestedDir), "agent-preset");
  const presetRootDir = join(process.env.DSH_HOME, "preset-root");
  mkdirSync(presetRootDir, { recursive: true });
  writeFileSync(join(presetRootDir, "preset.yml"), "# p\n", "utf8");
  writeFileSync(join(presetRootDir, "agent.cordis.yml"), "# a\n", "utf8");
  check("detectType 根预设仍 agent-preset", await lib.detectType(presetRootDir), "agent-preset");

  // ---- classifyInstallFailure（失败分类提示）----
  check("分类 EINTEGRITY", lib.classifyInstallFailure("npm ERR! code EINTEGRITY\nintegrity checksum failed").includes("完整性"), true);
  check("分类 node-gyp", lib.classifyInstallFailure("gyp ERR! stack Error: not found: python3").includes("node-gyp"), true);
  check("分类 网络", lib.classifyInstallFailure("fetch failed: ENOTFOUND registry.npmjs.org", "zh").includes("网络"), true);
  check("分类 版本不存在", lib.classifyInstallFailure("No matching version found for dep@9.9.9").includes("版本不存在"), true);
  // issue #21：git clone 网络失败（`Command failed: git clone ... unable to access ... Couldn't connect`）
  // 必须命中网络类而非笼统的「构建/包管理命令失败」
  check("分类 git clone 网络", lib.classifyInstallFailure("Command failed: git clone --depth 1 https://github.com/a/b.git\nfatal: unable to access 'https://github.com/a/b.git/': Failed to connect to github.com port 443: Couldn't connect to server").includes("网络"), true);
  check("分类 git clone 网络 en", lib.classifyInstallFailure("fatal: unable to access: Couldn't connect to server", "en").includes("proxy"), true);
  check("分类 缺少模块", lib.classifyInstallFailure("internal/modules/cjs/loader: Cannot find module 'foo'", "zh").includes("缺少模块"), true);
  check("分类 构建命令失败", lib.classifyInstallFailure("ERR_PNPM_LOCKFILE_UP_TO_DATE Command failed with exit code 1", "zh").includes("构建"), true);
  check("分类 无匹配返回 null", lib.classifyInstallFailure("just a normal error"), null);
  check("分类 en 语言", lib.classifyInstallFailure("integrity checksum failed", "en").includes("integrity"), true);

  // ---- sanitizeLog（日志脱敏）----
  check("脱敏 Windows 主目录", lib.sanitizeLog("C:\\Users\\wyzin\\.dsh\\marketplace\\cache\\a"), "~\\<user>\\.dsh\\marketplace\\cache\\a");
  check("脱敏 Unix 主目录", lib.sanitizeLog("cd /home/alice/dsh && pwd"), "cd ~/<user> && pwd");
  check("脱敏 sk- 密钥", lib.sanitizeLog("key=sk-ABC12345XYZ"), "key=sk-ABC123…");
  check("脱敏 ghp_ 密钥", lib.sanitizeLog("token=ghp_abcdefgh123456789"), "token=ghp_abcdef…");
  check("脱敏 AKIA", lib.sanitizeLog("AKIAIOSFODNN7EXAMPLE"), "AKIAIOSFOD…");
  check("脱敏不影响普通文本", lib.sanitizeLog("install ok: demo-plugin"), "install ok: demo-plugin");
  const cliNoHintDir = join(process.env.DSH_HOME, "cli-no-hint");
  mkdirSync(cliNoHintDir, { recursive: true });
  writeFileSync(join(cliNoHintDir, "README.md"), "# No command here\nInstall via marketplace.\n", "utf8");
  check("cliHint 无指令返回 null", await lib.scanCliInstallHint(cliNoHintDir, "owner/demo-plugin"), null);
  check("cliHint 目录不存在返回 null", await lib.scanCliInstallHint(join(process.env.DSH_HOME, "nope"), "a/b"), null);

  // ---- dedupeReposByPkgName（pkg_name 冲突消解：已装优先，其次 Star 高者）----
  // 不传 isInstalled 参数：触发默认闭包 `isInstalled = (r) => installedMap.has(r.full_name)`
  // 与内部 `rank` 闭包（isInstalled 命中时 +1e12 权重）。
  const dupRepos = [
    { full_name: "a/low", name: "low", pkg_name: "shared-pkg", stargazers_count: 5 },
    { full_name: "a/high", name: "high", pkg_name: "shared-pkg", stargazers_count: 100 },
  ];
  check("dedupe 默认参数 冲突保留高 Star", lib.dedupeReposByPkgName(dupRepos).repos.map((r) => r.full_name), ["a/high"]);
  check("dedupe 默认参数 只留一条", lib.dedupeReposByPkgName(dupRepos).repos.length, 1);
  check("dedupe 默认参数 返回 dropped 列表", lib.dedupeReposByPkgName(dupRepos).dropped, ["a/low"]);
  const dupInstalled = [
    { full_name: "x/inst", name: "inst", pkg_name: "p", stargazers_count: 0 },
    { full_name: "x/star", name: "star", pkg_name: "p", stargazers_count: 999 },
  ];
  check("dedupe 已装优先（rank 1e12 分支）", lib.dedupeReposByPkgName(dupInstalled, (r) => r.full_name === "x/inst").repos.map((r) => r.full_name), ["x/inst"]);
  check("dedupe 无 pkg_name 不冲突", lib.dedupeReposByPkgName([
    { full_name: "u/v", name: "v", stargazers_count: 1 },
    { full_name: "u/w", name: "w", stargazers_count: 2 },
  ]).repos.map((r) => r.full_name), ["u/v", "u/w"]);

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
  // 所有 registry 源返回 403 → （内置索引存在会先兜底，#12——临时移开以覆盖
  // 更深层路径）→ 磁盘缓存（清空）→ 搜索 API → fetchJson 抛错被捕获（含
  // res.text() 失败时的 .catch(() => "") 分支）→ 降级返回空数组。
  const bundledDsh = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "registry.json");
  renameSync(bundledDsh, bundledDsh + ".bak");
  try {
    // 前文 fetchAllRepos 的内置索引兜底会 fire-and-forget 落盘 list-cache/dsh.json，
    // 先等其写完再清空，否则磁盘缓存层会先命中、覆盖不了搜索兜底路径。
    await new Promise((r) => setTimeout(r, 500));
    rmSync(join(process.env.DSH_HOME, "marketplace", "list-cache", "dsh.json"), { force: true });
    const orig5 = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => { throw new Error("text boom"); } });
    const degraded = await lib.fetchAllRepos("dsh");
    globalThis.fetch = orig5;
    check("fetchAllRepos 全失败降级空数组", Array.isArray(degraded) && degraded.length === 0, true);
  } finally {
    renameSync(bundledDsh + ".bak", bundledDsh);
  }

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

  // ---- restore/webdav handler：WebDAV 拉取备份 → 恢复差异 ----
  // 整条 handler 补测（此前无任何测试触发）：405 / 非法 URL / fetch 失败 / 成功 diff / 非法 backup。
  const restoreWdHandler = registered.find((h) => h.path === "/api/marketplace/restore/webdav")?.handler;
  if (restoreWdHandler) {
    const mkPostReq = (bodyObj) => {
      const bodyStr = JSON.stringify(bodyObj);
      let sent = false;
      return {
        method: "POST",
        headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" },
        url: "/api/marketplace/restore/webdav",
        [Symbol.asyncIterator]() {
          return {
            next: async () => sent ? { value: undefined, done: true } : (sent = true, { value: Buffer.from(bodyStr), done: false }),
          };
        },
      };
    };
    const call = async (req) => {
      let s = 0, b = null;
      await restoreWdHandler(req, { writeHead: (x) => { s = x; }, end: (x) => { try { b = JSON.parse(x); } catch { b = null; } } });
      return { s, b };
    };
    // 方法非 POST → 405
    let r = await call({ method: "GET", headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" } });
    check("restore/webdav 非 POST 405", r.s, 405);
    // 非法协议 URL（非 http/https，防 SSRF）→ 400
    r = await call(mkPostReq({ url: "ftp://evil.example.com/bk.json" }));
    check("restore/webdav 非法 URL 400", r.s, 400);
    // 远端 fetch 失败（HTTP 500）→ 200 failed + webdavFail 日志
    const origFail = mockFetch({}, 500);
    r = await call(mkPostReq({ url: "https://example.com/bk.json" }));
    globalThis.fetch = origFail;
    check("restore/webdav fetch 失败 failed", r.s, 200);
    check("restore/webdav fetch 失败 status=failed", r.b && r.b.status, "failed");
    // 成功：合法 backup（1 条未装 + 1 条已装，触发 missing/already 两个 map 回调）→ 200 done
    const origOk = mockFetch({ repos: [
      { repo: "none/not-installed", type: "skill", name: "x" },
      { repo: "none/already-installed", type: "skill", name: "y" },
    ] });
    r = await call(mkPostReq({ url: "https://example.com/bk.json", username: "u", password: "p" }));
    globalThis.fetch = origOk;
    check("restore/webdav 成功 200", r.s, 200);
    check("restore/webdav missing 未装项", r.b && r.b.missing, ["none/not-installed"]);
    check("restore/webdav already 已装项", r.b && r.b.already, ["none/already-installed"]);
    // 远端返回非法 backup 结构 → 400 badBackup
    const origBad = mockFetch({ repos: "nope" });
    r = await call(mkPostReq({ url: "https://example.com/bk.json" }));
    globalThis.fetch = origBad;
    check("restore/webdav badBackup 400", r.s, 400);
  } else {
    check("restore/webdav handler 存在", false, true);
  }

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

  // ---- readBundledIndex（#12）：随包内置索引可读、去重、排除本体 ----
  {
    const bundled = await lib.readBundledIndex("dsh");
    check("readBundledIndex dsh 非空", Array.isArray(bundled) && bundled.length > 100, true);
    check("readBundledIndex 排除本体", bundled.some((r) => r.name === "deepseek-harness"), false);
    const names = bundled.map((r) => r.full_name);
    check("readBundledIndex 去重", new Set(names).size === names.length, true);
    const bundledSkills = await lib.readBundledIndex("skills");
    check("readBundledIndex skills 非空", Array.isArray(bundledSkills) && bundledSkills.length > 1000, true);
  }

  // ==================== #10 / #11 回归 ====================
  // ---- parseGitmodulesUrls（纯函数）：https 与相对路径放行，file:// / git@ / git:// 拒绝 ----
  {
    const gm = '[submodule "a"]\n\tpath = upstream/a\n\turl = https://github.com/o/a.git\n'
      + '[submodule "b"]\n\tpath = upstream/b\n\turl = ../b.git\n';
    const ok = lib.parseGitmodulesUrls(gm);
    check("gitmodules https+相对路径 urls", ok.urls.length, 2);
    check("gitmodules https+相对路径 unsafe 为空", ok.unsafe, []);
    const bad = lib.parseGitmodulesUrls('[submodule "x"]\n\turl = file:///etc/passwd\n[submodule "y"]\n\turl = git@github.com:o/y.git\n');
    check("gitmodules file/git@ 被拒绝", bad.unsafe, ["file:///etc/passwd", "git@github.com:o/y.git"]);
    check("gitmodules 空文本", lib.parseGitmodulesUrls(""), { urls: [], unsafe: [] });
    check("gitmodules null 入参", lib.parseGitmodulesUrls(null), { urls: [], unsafe: [] });
  }

  // ---- detectType 分层判定 + findSkillRoots vendored 跳过（#11 fixture 回归）----
  const dtBase = join(process.env.DSH_HOME, "detecttype-fixtures");
  const mkFixture = (name, files) => {
    const root = join(dtBase, name);
    for (const [rel, content] of Object.entries(files)) {
      const f = join(root, rel);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, content, "utf8");
    }
    return root;
  };
  const DSH_PLUGIN_PKG = JSON.stringify({ name: "demo", version: "1.0.0", dsh: { client: { platform: "web", inject: [], immediately: true } } });
  // 1. 插件仓库 + vendored 子模块里的上游技能（oh-dsh 形态）→ cordis-plugin（修复前误判 skill）
  check("detectType 插件+vendored技能 → cordis-plugin",
    await lib.detectType(mkFixture("oh-dsh-like", {
      "package.json": DSH_PLUGIN_PKG,
      "upstream/dsh-tui/skills/audit/SKILL.md": "---\nname: audit\n---\n",
      "upstream/dsh-tui/skills/review/SKILL.md": "---\nname: review\n---\n"
    })), "cordis-plugin");
  // 2. 纯 skill 仓库带工具链 package.json（无 dsh 声明）→ skill（分层判定不能翻转为插件）
  check("detectType skill+工具package.json → skill",
    await lib.detectType(mkFixture("skill-with-tooling", {
      "package.json": JSON.stringify({ name: "skill-docs", scripts: { lint: "echo ok" } }),
      "SKILL.md": "---\nname: my-skill\n---\n"
    })), "skill");
  // 3. 嵌套技能集合仓库（无 package.json）→ skill
  check("detectType 嵌套技能集合 → skill",
    await lib.detectType(mkFixture("skill-collection", {
      "skills/a/SKILL.md": "---\nname: a\n---\n",
      "skills/b/SKILL.md": "---\nname: b\n---\n"
    })), "skill");
  // 4. 非插件 package.json（无 SKILL.md）→ cordis-plugin（保留非插件确认弹窗路径）
  check("detectType 非插件package.json → cordis-plugin",
    await lib.detectType(mkFixture("plain-npm", {
      "package.json": JSON.stringify({ name: "plain-project" })
    })), "cordis-plugin");
  // 5. 皮肤/多包仓库（根无清单，子目录有插件清单）→ cordis-plugin（原行为保留）
  check("detectType 皮肤多包 → cordis-plugin",
    await lib.detectType(mkFixture("skins-like", {
      "skins/dark/package.json": DSH_PLUGIN_PKG,
      "README.md": "# skins"
    })), "cordis-plugin");
  // 6. 仅 vendored 目录含 SKILL.md（无 package.json）→ instructions（技能是上游的，不算本仓库内容）
  check("detectType 仅vendored技能 → instructions",
    await lib.detectType(mkFixture("vendored-only", {
      "upstream/x/SKILL.md": "---\nname: x\n---\n",
      "README.md": "# readme"
    })), "instructions");
  check("findSkillRoots 跳过 upstream/", (await lib.findSkillRoots(join(dtBase, "vendored-only"))).length, 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();