// 冒烟测试：验证安全加固与纯函数修复（R1 Host 白名单 / R2 env 最小化 / n3 版本比较等）。
// 运行：node scripts/smoke-tests.mjs（CI 的 syntax check 步骤同步执行）
import { compareVersions, isTrustedRequest, isTrustedHost, isSensitiveEnvKey, buildMinimalEnv, buildFilteredEnv, looksLikeDshPlugin } from "../lib/index.js";
import { classifyTree, shouldInheritProbe } from "./build-registry.mjs";
import { inject as marketInject, name as marketName } from "../lib/index.js";
import { extractSubject, validateSubject, COMMIT_TYPES, SYNTAX_CHECK_FILES, hasEmoji, parseHookConfig, LEVELS, DEFAULT_HOOK_CONFIG, loadHookConfigFromText, detectSecret } from "./hooks/validate.mjs";
import { extractHeadings, slugify, generateToc, applyToc, tocIsValid, normalizeEol, isMain, tocInsertIndex, discoverMarkdownFiles, DEFAULT_TOC_EXCLUDES } from "./toc.mjs";

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

// ---- 插件契约: inject 依赖声明（apply() 同步 ctx.get("webServer") 依赖它）----
check("插件名", marketName, "dsh-plugin-marketplace");
check("声明 webServer 依赖注入", Array.isArray(marketInject) && marketInject.includes("webServer"), true);
check("inject 不包含重复项", Array.isArray(marketInject) && new Set(marketInject).size === marketInject.length, true);

// ---- 提交规范校验: validateSubject / extractSubject ----
check("合法主题: fix: 修复", validateSubject("fix: 修复 xxx").ok, true);
check("合法主题: fix(install): 带 scope", validateSubject("fix(install): 修复 xxx").ok, true);
check("合法主题: feat: 带冒号内容", validateSubject("feat: 通用 Skills 栏目前端 tab").ok, true);
check("合法主题: chore: update registry.json", validateSubject("chore: update registry.json").ok, true);
check("非法: 无 type", validateSubject("bad commit message").ok, false);
check("非法: type 后无冒号", validateSubject("fix 修复 xxx").ok, false);
check("非法: 未知 type", validateSubject("unknown: 修复 xxx").ok, false);
check("非法: type 后无描述", validateSubject("fix:").ok, false);
check("非法: 空串", validateSubject("").ok, false);
check("非法: 非字符串", validateSubject(null).ok, false);
check("scope 非法字符", validateSubject("fix(Fix): xxx").ok, false);
check("extractSubject 取首行", extractSubject("fix: a\n\nbody"), "fix: a");
check("extractSubject 去空白", extractSubject("  fix: a  "), "fix: a");
check("extractSubject 空输入", extractSubject(""), "");
check("type 白名单含 fix", COMMIT_TYPES.includes("fix"), true);
check("type 白名单含 assets", COMMIT_TYPES.includes("assets"), true);
check("type 白名单不含 unknown", COMMIT_TYPES.includes("unknown"), false);
check("语法检查清单包含 lib/index.js", SYNTAX_CHECK_FILES.includes("lib/index.js"), true);
check("语法检查清单包含 smoke-tests", SYNTAX_CHECK_FILES.includes("scripts/smoke-tests.mjs"), true);

// ---- emoji 检测: hasEmoji ----
check("hasEmoji 纯文本", hasEmoji("fix: 修复 bug"), false);
check("hasEmoji 常见 emoji", hasEmoji("feat: 新增 ✨ 功能"), true);
check("hasEmoji FE0F 变体", hasEmoji("feat: 🚀"), true);
check("hasEmoji 肤色修饰", hasEmoji("👍🏽"), true);
check("hasEmoji ZWJ 家庭序列", hasEmoji("👨👩👧👦"), true);
check("hasEmoji 旗帜区域指示符", hasEmoji("🇨🇳"), true);
check("hasEmoji 数字 emoji", hasEmoji("1️⃣"), true);
check("hasEmoji 红心变体", hasEmoji("❤️"), true);
check("hasEmoji 箭头变体", hasEmoji("➡️"), true);
check("hasEmoji 数字/标点", hasEmoji("fix: 修复 1+1 的问题"), false);
check("hasEmoji 中文标点", hasEmoji("fix: 修复（重要）"), false);
check("hasEmoji 拉丁字符", hasEmoji("fix: use cache"), false);
check("hasEmoji 数学符号", hasEmoji("fix: 1+1=2"), false);
check("hasEmoji CJK", hasEmoji("feat: 新增功能"), false);
check("hasEmoji 空串", hasEmoji(""), false);
check("hasEmoji 非字符串", hasEmoji(null), false);
check("hasEmoji undefined", hasEmoji(undefined), false);
check("hasEmoji 版权符号(Unicode emoji 属性)", hasEmoji("©"), true);
check("hasEmoji 新 Unicode emoji", hasEmoji("🫠"), true);
check("hasEmoji 标签序列", hasEmoji("🏳️‍🌈"), true);
check("validateSubject 拒绝 emoji 主题", validateSubject("feat: ✨ 新功能").ok, false);
check("validateSubject emoji 原因提示", validateSubject("feat: ✨ 新功能").reason.includes("emoji"), true);

// ---- Hook 分级: emojiLevel ----
const emojiSubject = "feat: ✨ 新功能";
check("level=error 拒绝", validateSubject(emojiSubject, { emojiLevel: "error" }).ok, false);
const warnR = validateSubject(emojiSubject, { emojiLevel: "warn" });
check("level=warn 放行", warnR.ok, true);
check("level=warn 含警告", warnR.warnings.length, 1);
check("level=off 跳过", validateSubject(emojiSubject, { emojiLevel: "off" }).ok, true);
check("level=warn 无格式问题仍 ok", validateSubject("fix: 修复 bug", { emojiLevel: "warn" }).ok, true);
check("格式错误不受 warn 影响", validateSubject("bad format", { emojiLevel: "warn" }).ok, false);
check("默认 level 为 error", validateSubject(emojiSubject).ok, false);

// ---- Hook 配置解析: parseHookConfig ----
const cfg1 = parseHookConfig("emojiLevel=warn\nrequireCommitMsg=false");
check("parseHookConfig emojiLevel", cfg1.emojiLevel, "warn");
check("parseHookConfig requireCommitMsg", cfg1.requireCommitMsg, false);
const cfg2 = parseHookConfig("# 注释\nemojiLevel=off");
check("parseHookConfig 注释跳过", cfg2.emojiLevel, "off");
check("parseHookConfig 默认值保留", cfg2.requireCommitMsg, true);
check("parseHookConfig 非法值回退默认", parseHookConfig("emojiLevel=banana").emojiLevel, "error");
check("parseHookConfig 空文本默认", parseHookConfig("").emojiLevel, "error");
check("parseHookConfig 非字符串", parseHookConfig(null).emojiLevel, "error");
check("LEVELS 常量", LEVELS.includes("warn") && LEVELS.includes("off") && LEVELS.includes("error"), true);
check("DEFAULT_HOOK_CONFIG 默认 error", DEFAULT_HOOK_CONFIG.emojiLevel, "error");
check("loadHookConfigFromText 解析文本", loadHookConfigFromText("emojiLevel=off").emojiLevel, "off");
check("loadHookConfigFromText 空文本默认", loadHookConfigFromText("").emojiLevel, "error");
check("loadHookConfigFromText 非字符串", loadHookConfigFromText(null).emojiLevel, "error");
check("loadHookConfigFromText 完整配置", (() => {
  const c = loadHookConfigFromText("emojiLevel=warn\nsecretLevel=off\nsecretExclusions=a,b\ntocExclude=x");
  return c.emojiLevel === "warn" && c.secretLevel === "off" && c.secretExclusions.length === 2 && c.tocExclude.length === 1;
})(), true);

// ---- 敏感密钥扫描: detectSecret ----
const fakeOpenAI = "sk-" + "A".repeat(40);
const fakeGh = "ghp_" + "B".repeat(36);
const fakeAws = "AKIA" + "C".repeat(16);
check("detectSecret sk- 密钥", detectSecret(`key=${fakeOpenAI}`).found, true);
check("detectSecret ghp_ 密钥", detectSecret(fakeGh).found, true);
check("detectSecret AWS AKIA", detectSecret(fakeAws).found, true);
check("detectSecret 纯文本", detectSecret("fix: 修复 bug no secrets here").found, false);
check("detectSecret 短 sk- 不误报", detectSecret("sk-abc").found, false);
check("detectSecret 空串", detectSecret("").found, false);
check("detectSecret 非字符串", detectSecret(null).found, false);
check("detectSecret 返回打码样本", detectSecret(`key=${fakeOpenAI}`).samples[0], "sk-A…AAAA");

// ---- 配置: secretLevel / secretExclusions ----
const secCfg = parseHookConfig("secretLevel=warn\nsecretExclusions=.env.example,tests/fixtures");
check("parseHookConfig secretLevel", secCfg.secretLevel, "warn");
check("parseHookConfig secretExclusions 列表", secCfg.secretExclusions.includes(".env.example") && secCfg.secretExclusions.includes("tests/fixtures"), true);
check("parseHookConfig 默认 secretLevel", parseHookConfig("").secretLevel, "error");
check("parseHookConfig 默认 secretExclusions 空", parseHookConfig("").secretExclusions.length, 0);

// ---- TOC: extractHeadings ----
const TOC_MD = [
  "# Title",
  "",
  "## A 标题",
  "### A.1 子节",
  "#### A.1.1 太深",
  "## B 标题",
  "",
  "<!-- TOC -->",
  "<!-- /TOC -->",
].join("\n");
const hs = extractHeadings(TOC_MD);
check("extractHeadings 数 h2+h3", hs.length, 3);
check("extractHeadings level", hs[0].level, 2);
check("extractHeadings 排除 h4", hs.some((h) => h.level === 4), false);
check("extractHeadings 排除 TOC 占位", hs.some((h) => h.text.includes("TOC -->")), false);

// ---- TOC: slugify ----
check("slugify 英文", slugify("Quick install"), "quick-install");
check("slugify 中文去空格", slugify("一键安装（复制即用）"), "一键安装复制即用");
check("slugify 去 emoji", slugify("⚡ 一键安装"), "一键安装");
check("slugify 标点去除", slugify("A.B, C!"), "ab-c");
check("slugify 连字符保留", slugify("a-b c"), "a-b-c");

// ---- TOC: generateToc ----
const toc = generateToc(TOC_MD);
check("generateToc 含占位开始", toc.startsWith("<!-- TOC -->\n"), true);
check("generateToc 含链接", toc.includes("(#a-标题)"), true);
check("generateToc 子节缩进", toc.includes("  - [A.1 子节]"), true);
check("generateToc 排除 h4", toc.includes("a11"), false);

// ---- TOC: applyToc ----
const applied = applyToc(TOC_MD, toc);
check("applyToc 替换占位", applied.includes("- [A 标题](#a-标题)"), true);
check("applyToc 无占位返回 null", applyToc("# No toc", "<!-- TOC -->\nx\n<!-- /TOC -->"), null);
const crlfMd = "<!-- TOC -->\r\n<!-- /TOC -->\r\n## A 标题";
const crlfApplied = applyToc(crlfMd, "<!-- TOC -->\n- [A](#a)\n<!-- /TOC -->");
check("applyToc 保留 CRLF", crlfApplied.includes("<!-- TOC -->\r\n"), true);

// ---- TOC: tocIsValid ----
check("tocIsValid 正常通过", tocIsValid(applyToc(TOC_MD, toc)), true);
check("tocIsValid 无 h2 无占位 true(无需 TOC)", tocIsValid("# No placeholder"), true);
check("tocIsValid 无占位但有 h2 false", tocIsValid("# T\n\n## A 标题"), false);
check("tocIsValid 内容过期 false", tocIsValid("<!-- TOC -->\n- [旧](#旧)\n<!-- /TOC -->\n## 新 标题"), false);
check("tocIsValid CRLF 兼容", tocIsValid("<!-- TOC -->\r\n- [A 标题](#a-标题)\r\n<!-- /TOC -->\r\n## A 标题"), true);

// ---- TOC: tocInsertIndex ----
const idxMd = "# 主标题\n\n引言\n\n## 第一节\n内容\n## 第二节";
check("tocInsertIndex 定位第一个 h2 前", (() => {
  const idx = tocInsertIndex(idxMd);
  return idxMd.slice(idx, idx + 2) === "##";
})(), true);
check("tocInsertIndex 无 h2 返回 -1", tocInsertIndex("# 只有标题"), -1);
check("tocInsertIndex 空文档 -1", tocInsertIndex(""), -1);

// ---- TOC: discoverMarkdownFiles 自动扫描 ----
check("DEFAULT_TOC_EXCLUDES 含 CHANGELOG", DEFAULT_TOC_EXCLUDES.includes("CHANGELOG.md"), true);
// 用绝对路径（不依赖调用方 cwd）
const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1").replace(/\//g, "\\");
const mdFiles = discoverMarkdownFiles(REPO_ROOT);
check("自动发现含 README.md", mdFiles.includes("README.md"), true);
check("自动发现含 docs/DEVELOPMENT.md", mdFiles.includes("docs/DEVELOPMENT.md"), true);
check("排除 CHANGELOG.md", mdFiles.includes("CHANGELOG.md"), false);
check("排除 node_modules", mdFiles.some((f) => f.startsWith("node_modules/")), false);
check("路径排序稳定", JSON.stringify(mdFiles) === JSON.stringify([...mdFiles].sort()), true);
const excl = discoverMarkdownFiles(REPO_ROOT, ["docs/README.md"]);
check("extraExcludes 追加排除", excl.includes("docs/README.md"), false);

// ---- TOC: normalizeEol ----
check("normalizeEol CRLF→LF", normalizeEol("a\r\nb"), "a\nb");
check("normalizeEol LF 不变", normalizeEol("a\nb"), "a\nb");

// ---- TOC: isMain ----
check("isMain 无 argv1 false", (() => {
  const orig = process.argv[1];
  delete process.argv[1];
  const r = isMain();
  process.argv[1] = orig;
  return r;
})(), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
