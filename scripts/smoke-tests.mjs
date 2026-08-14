// 冒烟测试：验证安全加固与纯函数修复（R1 Host 白名单 / R2 env 最小化 / n3 版本比较等）。
// 运行：node scripts/smoke-tests.mjs（CI 的 syntax check 步骤同步执行）
import { compareVersions, isTrustedRequest, isTrustedHost, isSensitiveEnvKey, buildMinimalEnv, buildFilteredEnv, looksLikeDshPlugin, dedupeReposByPkgName, needsPluginBuild, hasPatchEntry } from "../lib/index.js";
import { classifyTree, shouldInheritProbe, starRangeQuery, midDateStr, splitSegment, classifyRepo, dedupeByPkgName } from "./build-registry.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ---- n3: compareVersions ----
check("1.2.3 vs 1.2.3", compareVersions("1.2.3", "1.2.3"), 0);
check("1.2.3 vs 1.2.4", compareVersions("1.2.3", "1.2.4"), -1);
check("1.2.4 vs 1.2.3", compareVersions("1.2.4", "1.2.3"), 1);
check("正式版 > 预发布", compareVersions("1.2.3", "1.2.3-rc.1"), 1);
check("rc.1 < 正式版", compareVersions("1.2.3-rc.1", "1.2.3"), -1);
check("rc.10 > rc.9 (数字比较)", compareVersions("1.0.0-rc.10", "1.0.0-rc.9"), 1);
check("rc.9 < rc.10", compareVersions("1.0.0-rc.9", "1.0.0-rc.10"), -1);
check("beta.2 > alpha.5 (字母段)", compareVersions("1.0.0-beta.2", "1.0.0-alpha.5"), 1);
check("两位版本 1.2 == 1.2.0", compareVersions("1.2", "1.2.0"), 0);
check("一位版本 1 == 1.0.0", compareVersions("1", "1.0.0"), 0);
check("v 前缀", compareVersions("v1.2.3", "1.2.3"), 0);
check("1.2.3.4 回退字符串比较", compareVersions("1.2.3.4", "1.2.3.5"), -1);
check("预发布相等", compareVersions("1.0.0-rc.1", "1.0.0-rc.1"), 0);

// ---- R1: isTrustedRequest（Host 白名单 + 自定义头 + Origin）----
const req = (headers) => ({ headers });
check("本机回环+头 → 允许", isTrustedRequest(req({ "x-dsh-marketplace": "1", host: "127.0.0.1:3080" })), true);
check("localhost → 允许", isTrustedRequest(req({ "x-dsh-marketplace": "1", host: "localhost:3080" })), true);
check("IPv6 [::1] → 允许", isTrustedRequest(req({ "x-dsh-marketplace": "1", host: "[::1]:3080" })), true);
check("局域网 192.168 → 允许", isTrustedRequest(req({ "x-dsh-marketplace": "1", host: "192.168.1.5:3080" })), true);
check("局域网 10.x → 允许", isTrustedRequest(req({ "x-dsh-marketplace": "1", host: "10.0.0.2:3080" })), true);
check("局域网 172.16 → 允许", isTrustedRequest(req({ "x-dsh-marketplace": "1", host: "172.16.0.2:3080" })), true);
check("172.32（非私有段）→ 拒绝", isTrustedRequest(req({ "x-dsh-marketplace": "1", host: "172.32.0.2:3080" })), false);
check("evil.com → 拒绝", isTrustedRequest(req({ "x-dsh-marketplace": "1", host: "evil.com:3080" })), false);
check("DNS rebinding 场景 → 拒绝", isTrustedRequest(req({ "x-dsh-marketplace": "1", host: "evil.com:3080", origin: "http://evil.com:3080" })), false);
check("本机 + Origin 一致 → 允许", isTrustedRequest(req({ "x-dsh-marketplace": "1", host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" })), true);
check("本机 + Origin 不一致 → 拒绝", isTrustedRequest(req({ "x-dsh-marketplace": "1", host: "127.0.0.1:3080", origin: "http://evil.com" })), false);
check("缺自定义头 → 拒绝", isTrustedRequest(req({ host: "127.0.0.1:3080" })), false);
check("无 Host → 拒绝", isTrustedRequest(req({ "x-dsh-marketplace": "1" })), false);

// ---- R1: isTrustedHost 直接验证 ----
check("isTrustedHost localhost", isTrustedHost("localhost:3080"), true);
check("isTrustedHost 127.0.0.1", isTrustedHost("127.0.0.1"), true);
check("isTrustedHost [::1]:3080", isTrustedHost("[::1]:3080"), true);
check("isTrustedHost 公网 IP → 拒绝", isTrustedHost("8.8.8.8"), false);
check("isTrustedHost 域名 → 拒绝", isTrustedHost("evil.com:3080"), false);

// ---- R2: 敏感键过滤 ----
check("GITHUB_TOKEN 敏感", isSensitiveEnvKey("GITHUB_TOKEN"), true);
check("OPENAI_API_KEY 敏感", isSensitiveEnvKey("OPENAI_API_KEY"), true);
check("DB_PASSWORD 敏感", isSensitiveEnvKey("DB_PASSWORD"), true);
check("PASSWORD 敏感", isSensitiveEnvKey("PASSWORD"), true);
check("CREDENTIALS 敏感", isSensitiveEnvKey("AWS_CREDENTIALS"), true);
check("PATH 不敏感", isSensitiveEnvKey("PATH"), false);
check("TEMP 不敏感", isSensitiveEnvKey("TEMP"), false);
check("KEYBOARD_LAYOUT 不敏感", isSensitiveEnvKey("KEYBOARD_LAYOUT"), false);
check("MONKEY 不敏感", isSensitiveEnvKey("MONKEY"), false);
check("npm_config_registry 不敏感", isSensitiveEnvKey("npm_config_registry"), false);
check("NODE_OPTIONS 不敏感", isSensitiveEnvKey("NODE_OPTIONS"), false);

// ---- R2: env 构造 ----
const filtered = buildFilteredEnv();
const sensitiveLeft = Object.keys(filtered).filter((k) => isSensitiveEnvKey(k));
check("buildFilteredEnv 无敏感键残留", sensitiveLeft, []);
const minimal = buildMinimalEnv();
const nonWhitelist = Object.keys(minimal).filter((k) => !["PATH", "PATHEXT", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "TEMP", "TMP", "TMPDIR", "SYSTEMROOT", "WINDIR", "COMSPEC", "SHELL", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "PWD", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramData", "COMPUTERNAME", "NODE_ENV", "CI", "GITHUB_ACTIONS"].includes(k));
check("buildMinimalEnv 只含白名单键", nonWhitelist, []);

// ---- 步骤1: classifyTree（Trees 探测判定）----
const blob = (path) => ({ type: "blob", path });
const tree = (path) => ({ type: "tree", path });
check("根目录 SKILL.md → 有 skill", classifyTree([blob("SKILL.md")], false), { has_skill: true, has_install_script: false });
check("子目录 SKILL.md → 有 skill", classifyTree([blob("skills/foo/SKILL.md"), blob("README.md")], false), { has_skill: true, has_install_script: false });
check("无 SKILL.md 且未截断 → false", classifyTree([blob("README.md")], false), { has_skill: false, has_install_script: false });
check("truncated 且无 SKILL.md → null 未知", classifyTree([blob("README.md")], true), { has_skill: null, has_install_script: null });
check("truncated 但有 SKILL.md → skill true、script null", classifyTree([blob("SKILL.md")], true), { has_skill: true, has_install_script: null });
check("非 blob 的 SKILL.md 不算", classifyTree([tree("SKILL.md")], false), { has_skill: false, has_install_script: false });
check("大小写不敏感", classifyTree([blob("dir/skill.MD")], false), { has_skill: true, has_install_script: false });
check("install.sh 命中", classifyTree([blob("install.sh")], false), { has_skill: false, has_install_script: true });
check("子目录 install.ps1 命中", classifyTree([blob("scripts/install.ps1")], false), { has_skill: false, has_install_script: true });
check("myinstall.sh 不误伤", classifyTree([blob("myinstall.sh")], false), { has_skill: false, has_install_script: false });
check("非数组 tree 容错", classifyTree(null, false), { has_skill: false, has_install_script: false });

// ---- 步骤1: shouldInheritProbe（增量继承判定）----
const oldRepo = { full_name: "a/b", updated_at: "2026-01-01T00:00:00Z", has_skill: true, has_install_script: false, pkg_name: "abc" };
check("updated_at 相同且已有结果 → 继承", shouldInheritProbe({ full_name: "a/b", updated_at: "2026-01-01T00:00:00Z" }, oldRepo), true);
check("updated_at 变了 → 重新探测", shouldInheritProbe({ full_name: "a/b", updated_at: "2026-02-01T00:00:00Z" }, oldRepo), false);
check("旧条目无探测结果 → 重新探测", shouldInheritProbe({ full_name: "a/b", updated_at: "2026-01-01T00:00:00Z" }, { full_name: "a/b", updated_at: "2026-01-01T00:00:00Z" }), false);
check("has_skill=null（护栏中断）→ 重新探测", shouldInheritProbe({ full_name: "a/b", updated_at: "2026-01-01T00:00:00Z" }, { full_name: "a/b", updated_at: "2026-01-01T00:00:00Z", has_skill: null }), false);
check("has_skill=false（真实结果）→ 继承", shouldInheritProbe({ full_name: "a/b", updated_at: "2026-01-01T00:00:00Z" }, { full_name: "a/b", updated_at: "2026-01-01T00:00:00Z", has_skill: false }), true);
check("无旧条目 → 重新探测", shouldInheritProbe({ full_name: "c/d", updated_at: "2026-01-01T00:00:00Z" }, null), false);

// ---- 非插件判定: looksLikeDshPlugin ----
check("有 dsh 字段 → 插件", looksLikeDshPlugin({ name: "x", dsh: { client: {} } }), true);
check("peer 依赖 @deepseek-ai/cordis → 插件", looksLikeDshPlugin({ name: "x", peerDependencies: { "@deepseek-ai/cordis": "^1" } }), true);
check("依赖 @deepseek-ai/dsh → 插件", looksLikeDshPlugin({ name: "x", dependencies: { "@deepseek-ai/dsh": "^1" } }), true);
check("依赖 @deepseek-ai/dsh-client-runtime → 插件", looksLikeDshPlugin({ name: "x", dependencies: { "@deepseek-ai/dsh-client-runtime": "^1" } }), true);
check("普通 npm 项目（无 dsh 声明）→ 非插件", looksLikeDshPlugin({ name: "ipollowork", dependencies: { react: "^18" } }), false);
check("无依赖无字段 → 非插件", looksLikeDshPlugin({ name: "x" }), false);
check("空对象 → 非插件", looksLikeDshPlugin({}), false);
check("null → 未知", looksLikeDshPlugin(null), null);
check("非对象 → 未知", looksLikeDshPlugin("str"), null);

// ---- v1.3: star 分段查询构造（Search API 全量抓取）----
check("stars:>=1000", starRangeQuery("agent-skills", { min: 1000, max: null }), "topic:agent-skills stars:>=1000");
check("stars:100..999", starRangeQuery("agent-skills", { min: 100, max: 999 }), "topic:agent-skills stars:100..999");
check("stars:0 单值", starRangeQuery("agent-skills", { min: 0, max: 0 }), "topic:agent-skills stars:0");
check("stars:0 + 时间窗口", starRangeQuery("agent-skills", { min: 0, max: 0, timeRange: "2020-01-01..2026-12-31" }), "topic:agent-skills stars:0 pushed:2020-01-01..2026-12-31");
check("midDateStr 取中", midDateStr("2020-01-01", "2026-12-31"), "2023-07-02");
check("splitSegment 普通段对半", JSON.stringify(splitSegment({ min: 10, max: 99 })), JSON.stringify([{ min: 10, max: 54 }, { min: 55, max: 99 }]));
check("splitSegment 单值段时间二分", JSON.stringify(splitSegment({ min: 0, max: 0 })), JSON.stringify([
  { min: 0, max: 0, timeRange: "2008-01-01..2017-07-01" },
  { min: 0, max: 0, timeRange: "2017-07-01..2026-12-31" }
]));
check("splitSegment 1 天窗口无法再分", splitSegment({ min: 0, max: 0, timeRange: "2026-01-01..2026-01-01" }), []);
check("splitSegment ≤30 天窗口无法再分", splitSegment({ min: 0, max: 0, timeRange: "2026-06-01..2026-06-25" }), []);
check("splitSegment 大窗口正常二分", JSON.stringify(splitSegment({ min: 0, max: 0, timeRange: "2026-01-01..2026-12-31" })), JSON.stringify([
  { min: 0, max: 0, timeRange: "2026-01-01..2026-07-02" },
  { min: 0, max: 0, timeRange: "2026-07-02..2026-12-31" }
]));

// ---- 插件分类: classifyRepo ----
check("vision: OCR 图片", classifyRepo({ description: "OCR and image understanding for text-only models", name: "modlens", topics: ["vision"] }), "vision");
check("vision: 截图/视觉", classifyRepo({ description: "让纯文本模型看图：截图识别与 UI 还原", name: "dsh-vision-toolkit", topics: [] }), "vision");
check("document: PDF", classifyRepo({ description: "PDF toolbox: extract text and pages", name: "dsh-pdf", topics: ["pdf"] }), "document");
check("document: Excel", classifyRepo({ description: "talk to Excel: create and edit spreadsheets", name: "dsh-excel-chat", topics: [] }), "document");
check("memory: 长期记忆", classifyRepo({ description: "跨会话长期记忆与知识管理", name: "dsh-memory-evolve", topics: [] }), "memory");
check("model: token 用量", classifyRepo({ description: "token usage and balance monitor", name: "dsh-balance-monitor", topics: [] }), "model");
check("notify: 通知", classifyRepo({ description: "Desktop notifications for turn completion", name: "dsh-notification", topics: [] }), "notify");
check("coding: TUI 终端", classifyRepo({ description: "terminal TUI for DSH, Claude Code style", name: "dsh-cc-tui", topics: ["tui"] }), "coding");
check("coding: VS Code", classifyRepo({ description: "Open workspace in VS Code", name: "dsh-open-in-vscode", topics: [] }), "coding");
check("conversation: 对话分享", classifyRepo({ description: "一键分享你的对话", name: "dsh-share", topics: [] }), "conversation");
check("conversation: 批注", classifyRepo({ description: "选中批注，随消息发送", name: "dsh-annotation", topics: [] }), "conversation");
check("web-ui: 皮肤", classifyRepo({ description: "鲸鱼娘皮肤系列（深海女仆工坊）", name: "dsh-deep-whale", topics: [] }), "web-ui");
check("web-ui: 侧边栏", classifyRepo({ description: "侧边栏完整工作台，支持三方拓展 Tab", name: "DSH-better-sidebar", topics: [] }), "web-ui");
check("web-ui: 小游戏", classifyRepo({ description: "右侧小游戏面板：18 款离线小游戏", name: "dsh-minigames", topics: [] }), "web-ui");
check("agent: 工作流", classifyRepo({ description: "把一次性多 Agent 调度升级为可治理的 Workflow 层", name: "dsh_workflow", topics: [] }), "agent");
check("agent: 桌面应用", classifyRepo({ description: "local-first AI agent desktop app", name: "Abu-Cowork", topics: [] }), "agent");
check("tool: MCP server", classifyRepo({ description: "A MCP server for Stata", name: "mcp-for-stata", topics: ["mcp"] }), "tool");
check("tool: 沙箱", classifyRepo({ description: "Open-source sandboxes for AI agents", name: "axern", topics: [] }), "tool");
check("resource: awesome 聚合", classifyRepo({ description: "Awesome DSH Plugins directory", name: "awesome-dsh-plugins", topics: ["awesome"] }), "resource");
check("resource: 手册", classifyRepo({ description: "DSH 从 0 到 1 深度手册", name: "dsh-handbook", topics: [] }), "resource");
check("other: 无法分类", classifyRepo({ description: "Random thingamajig", name: "weird-repo", topics: [] }), "other");
check("other: 空简介", classifyRepo({ description: null, name: "x", topics: [] }), "other");
check("分类优先级: vision 优先于 coding", classifyRepo({ description: "vision OCR toolkit for coding agents", name: "agent-vision-toolkit", topics: ["vision"] }), "vision");

// ---- PR#3: pkg_name 冲突消解（索引构建 + 运行时）----
check("构建期冲突保留高 Star", dedupeByPkgName([
  { full_name: "a/x", pkg_name: "shared", stargazers_count: 1 },
  { full_name: "b/x", pkg_name: "shared", stargazers_count: 5 }
]).repos.map((r) => r.full_name), ["b/x"]);
check("构建期 dropped 记录低 Star", dedupeByPkgName([
  { full_name: "a/x", pkg_name: "shared", stargazers_count: 1 },
  { full_name: "b/x", pkg_name: "shared", stargazers_count: 5 }
]).dropped, ["a/x"]);
check("无 pkg_name 不参与冲突", dedupeByPkgName([
  { full_name: "a/x", pkg_name: null, stargazers_count: 1 },
  { full_name: "b/x", pkg_name: null, stargazers_count: 5 }
]).repos.length, 2);
const dupRepos = [
  { full_name: "a/lo", pkg_name: "shared", stargazers_count: 2 },
  { full_name: "b/hi", pkg_name: "shared", stargazers_count: 10 },
  { full_name: "c/solo", pkg_name: null, stargazers_count: 0 }
];
check("运行时默认保留高 Star", dedupeReposByPkgName(dupRepos).map((r) => r.full_name), ["b/hi", "c/solo"]);
check("运行时已安装优先保留", dedupeReposByPkgName(dupRepos, (r) => r.full_name === "a/lo").map((r) => r.full_name), ["a/lo", "c/solo"]);

// ---- PR#3: needsPluginBuild（源码型插件判定）----
const tmpSmoke = mkdtempSync(join(tmpdir(), "dsh-mp-smoke-"));
try {
  const srcOnly = join(tmpSmoke, "src-only");
  mkdirSync(srcOnly);
  writeFileSync(join(srcOnly, "package.json"), JSON.stringify({
    name: "x",
    main: "lib/index.js",
    scripts: { build: "tsdown" },
    exports: { "./client": { default: "./lib/client.js" } }
  }));
  check("main 缺失 → 需要构建", await needsPluginBuild(srcOnly), true);
  mkdirSync(join(srcOnly, "lib"));
  writeFileSync(join(srcOnly, "lib/index.js"), "//x");
  writeFileSync(join(srcOnly, "lib/client.js"), "//x");
  check("产物齐全 → 无需构建", await needsPluginBuild(srcOnly), false);
  writeFileSync(join(srcOnly, "package.json"), JSON.stringify({ name: "x", main: "lib/index.js" }));
  check("无 build 脚本 → 无需构建", await needsPluginBuild(srcOnly), false);
  writeFileSync(join(srcOnly, "package.json"), JSON.stringify({ name: "x", scripts: { build: "tsdown" } }));
  check("无 main/client 入口 → 无需构建", await needsPluginBuild(srcOnly), false);
  // conditional exports：{ "./client": { "import": "./dist/client.js" } } 也应识别为需要构建
  writeFileSync(join(srcOnly, "package.json"), JSON.stringify({
    name: "x",
    scripts: { build: "tsdown" },
    exports: { "./client": { "import": "./dist/client.js" } }
  }));
  check("conditional exports import 缺失 → 需要构建", await needsPluginBuild(srcOnly), true);
  mkdirSync(join(srcOnly, "dist"));
  writeFileSync(join(srcOnly, "dist/client.js"), "//x");
  check("conditional exports 产物齐全 → 无需构建", await needsPluginBuild(srcOnly), false);
  // 嵌套条件：{ "./client": { "browser": { "default": "./dist/client.js" } } }
  rmSync(join(srcOnly, "dist"), { recursive: true, force: true });
  writeFileSync(join(srcOnly, "package.json"), JSON.stringify({
    name: "x",
    scripts: { build: "tsdown" },
    exports: { "./client": { "browser": { "default": "./dist/client.js" } } }
  }));
  check("嵌套条件 default 缺失 → 需要构建", await needsPluginBuild(srcOnly), true);
  mkdirSync(join(srcOnly, "dist"));
  writeFileSync(join(srcOnly, "dist/client.js"), "//x");
  check("嵌套条件产物齐全 → 无需构建", await needsPluginBuild(srcOnly), false);
} finally {
  rmSync(tmpSmoke, { recursive: true, force: true });
}

// ---- PR#3: hasPatchEntry scoped 包引号兼容 ----
check("引号形式命中", hasPatchEntry('  - insert:\n    - id: x\n      name: "@a/b"\n', "@a/b"), true);
check("单引号形式命中", hasPatchEntry("      name: '@a/b'\n", "@a/b"), true);
check("无引号形式命中", hasPatchEntry("      name: @a/b\n", "@a/b"), true);
check("不同包名不命中", hasPatchEntry("      name: other\n", "@a/b"), false);
check("前缀子串不误伤", hasPatchEntry("      name: @a/bc\n", "@a/b"), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
