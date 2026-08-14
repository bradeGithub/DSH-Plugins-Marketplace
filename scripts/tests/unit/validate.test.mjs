import { extractSubject, validateSubject, COMMIT_TYPES, SYNTAX_CHECK_FILES, hasEmoji, parseHookConfig, LEVELS, DEFAULT_HOOK_CONFIG, loadHookConfigFromText, detectSecret } from "../../hooks/validate.mjs";

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

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


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
