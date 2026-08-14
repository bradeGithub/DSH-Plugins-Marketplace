// 冒烟测试：验证安全加固与纯函数修复（R1 Host 白名单 / R2 env 最小化 / n3 版本比较等）。
// 运行：node scripts/smoke-tests.mjs（CI 的 syntax check 步骤同步执行）
import { compareVersions, isTrustedRequest, isTrustedHost, isSensitiveEnvKey, buildMinimalEnv, buildFilteredEnv, looksLikeDshPlugin } from "../lib/index.js";
import { classifyTree, shouldInheritProbe, starRangeQuery, midDateStr, splitSegment } from "./build-registry.mjs";

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
