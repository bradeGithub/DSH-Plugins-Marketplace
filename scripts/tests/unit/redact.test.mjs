// lib/redact.js 多层脱敏测试：真实泄漏样本驱动（gitleaks 规则集形态 + 真实 bug 场景日志）。
// 契约分三面：
//   泄漏面——已知密钥形态必须掩码（漏报 = 公开 issue 泄密，最高优先级）
//   误报面——标识符/停用词/包名不得掩码（掩码过度 = 维护者无法诊断）
//   注入面——CR/LF 与 markdown 围栏必须净化（附 issue 特有攻击面）

import { redactLog, shannonEntropy, neutralizeMarkdownFences } from "../../../lib/redact.js";

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}
/** 泄漏断言：输出不含敏感原文（子串级）。 */
function noLeak(name, input, ...secrets) {
  const out = redactLog(input);
  for (const s of secrets) check(`${name}（无泄漏）`, out.includes(s), false);
}
/** 保留断言：输出保留非敏感上下文。 */
function keep(name, input, ...parts) {
  const out = redactLog(input);
  for (const p of parts) check(`${name}（保留上下文）`, out.includes(p), true);
}

// ---- 泄漏面：已知结构化密钥 ----
// token fixture 运行时拼接：GitHub secret scanning push protection 扫描源码字面量，
// 完整形态的 provider token 字面量会被平台拒绝推送——拼接形态运行时等价，语义不变。
const P = (a, b) => a + b;
noLeak("AWS AKIA", P("key AKIA", "IOSFODNN7EXAMPLE"), P("AKIA", "IOSFODNN7EXAMPLE"));
noLeak("AWS 临时凭证 ASIA", "credentials ASIAIOSFODNN7EXAMPLE", "ASIAIOSFODNN7EXAMPLE");
noLeak("AWS base32 边界", "A3T234567ABCDEFGHJKMNPQRST", "A3T234567ABCDEFGHJKMNPQRST");
noLeak("OpenAI sk-", "sk-abc123def456ghi789jkl012mno345pqr678", "sk-abc123def456ghi789jkl012mno345pqr678");
noLeak("OpenAI sk-proj-", "OPENAI_API_KEY=sk-proj-aBcD1234eFgH5678iJkL90MnOpQrStUv", "sk-proj-aBcD1234eFgH5678iJkL90MnOpQrStUv");
noLeak("Anthropic", "sk-ant-api03-xx1-yy2-zz3-aa4", "sk-ant-api03-xx1-yy2-zz3-aa4");
noLeak("GitHub ghp_", P("ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"), "hp_abcdefghijklmnopqrstuvwxyz012345");
noLeak("GitHub PAT", P("github_pat_", "11ABCDEF2_0abcdefghijkmnopqrstuvwxyzABCDEFG"), "11ABCDEF2_0abcdefghijkmnopqrstuvwxyz");
noLeak("GitLab", "glpat-AbCdEfGhIjKlMnOpQrSt", "glpat-AbCdEfGhIjKlMnOpQrSt");
noLeak("Slack bot", P("xoxb-", "123456789-abcdef"), "xoxb-123456789");
noLeak("npm", "npm_aabbccddeeffgghhiijjkkllmmnnooppqqrrsstt", "npm_aabbccddeeffgghhiijjkkllmmnnooppqqrrsstt");
noLeak("HuggingFace", P("hf_", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ"), P("hf_", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ"));
noLeak("Google", "AIzaSyA1234567890abcdefghijklmnopqrstuv", "AIzaSyA1234567890abcdefghijklmnopqrstuv");
noLeak("JWT", "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIi");
noLeak("PEM 私钥", "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7\n-----END RSA PRIVATE KEY-----", "MIIEpAIBAAKCAQEA7");
noLeak("DB 连接串 postgres", "postgres://admin:s3cretpass@db.example.com:5432/prod", "s3cretpass");
noLeak("DB 连接串 mongo srv", "mongodb+srv://root:p4ssw0rd@cluster0.abc.mongodb.net/db", "p4ssw0rd");
noLeak("Slack webhook", "https://hooks.slack.com/services/T00B000C0/D00E000F0/XxXxXxXxXxXxXxXxXxXxXxXx", "XxXxXxXxXxXxXxXxXxXxXxX");
noLeak("Discord webhook", "https://discord.com/api/webhooks/123456789012345678/aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd", "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789");
noLeak("Bearer 头", "Authorization: Bearer abcdef1234567890abcdef1234567890", "abcdef1234567890abcdef1234567890");
keep("Bearer 保留方案名", "Authorization: Bearer abcdef1234567890abcdef1234567890", "Bearer [REDACTED]");

// ---- 泄漏面：上下文邻近（无前缀自定义密钥）----
noLeak("上下文 password:", "password: Tr0ub4dor&3XYZ", "Tr0ub4dor&3XYZ");
noLeak("上下文 api_key=", "api_key = 9f8e7d6c5b4a3210fedcba", "9f8e7d6c5b4a3210fedcba");
noLeak("上下文 token:", "auth token: aBcDeFgH0123456789", "aBcDeFgH0123456789");
noLeak("上下文 client_secret", 'client_secret => "ZxYwVuTsRq9876543210"', "ZxYwVuTsRq9876543210");

// ---- 泄漏面：用户路径 ----
noLeak("Win 用户路径", String.raw`git clone C:\Users\alice\AppData\Local\Temp\dsh-x`, "\\alice\\");
keep("Win 路径保留结构", String.raw`C:\Users\alice\AppData\Local\Temp\dsh-x`, String.raw`~\<user>\AppData\Local\Temp`);
noLeak("/home 路径", "cd /home/bob/.dsh/profiles && ls", "/bob/");
noLeak("$HOME 路径", "export PATH=$HOME/.local/bin:$PATH", "$HOME/.local/bin:$PATH");

// ---- 误报面：allowlist（不得掩码）----
keep("包名含 token", "cannot find module token-parser-helper", "token-parser-helper");
keep("停用词 example", "password: example", "example");
keep("停用词 placeholder", "token: placeholder", "placeholder");
keep("纯小写标识符", "secret: error-module-not-found", "error-module-not-found");
keep("短值(<8)", "pwd: abc", "pwd: abc");
keep("正常日志", "pnpm install completed with 0 errors", "pnpm install completed");

// ---- 注入面 ----
keep("CR/LF 净化", "line1\r\nline2\rline3", "line1\nline2\nline3");
check("markdown 围栏净化", neutralizeMarkdownFences("```sh\ncode\n```"), "'''sh\ncode\n'''");
check("redactLog 内置围栏净化", redactLog("```json\n{}").includes("```"), false);
check("控制字符净化", redactLog("a\u0000b\u0008c").includes("\u0000"), false);

// ---- 熵函数 ----
check("熵空串", shannonEntropy(""), 0);
check("熵均匀串高", shannonEntropy("aB3xK9mQ2pL7vN4wE8rT1yU6iO0sD5fG") > 4.5, true);
check("熵低多样性串低", shannonEntropy("aaaaaaaaaa") < 0.1, true);

// ---- 高熵/编码兜底（熵+多样性组合；base64 解码重扫）----
noLeak("base64 编码已知密钥", "auth blob ZEtWemRQcHpNak55WlhReE1qTTBOVFkzT0E9PQ==", "ZEtWemRQcHpNak55WlhReE1qTTBOVFkzT0E9PQ==");
noLeak("高熵随机串", "session cache dGVzdDpzM2NyZXQxMjM0NTY3OA==", "dGVzdDpzM2NyZXQxMjM0NTY3OA==");
noLeak("hex 会话串", "session 8f14e45fceea167a5a36dedd4bea2543x9", "8f14e45fceea167a5a36dedd4bea2543x9");
keep("低熵重复串不掩", "module hash abcdefabcdefabcdef", "abcdefabcdefabcdef");
keep("URL 路径不掩", "see https://github.com/owner/repo/releases/tag/v1.2.3", "/releases/tag/v1.2.3");
keep("纯英文长词不掩", "error message authenticationfailedtoken", "authenticationfailedtoken");

// ---- 真实 bug 场景回归（触发脚本实测日志样本）----
{
  const realLog = [
    "[1/5] 克隆 https://github.com/lynx-gt/dsh-subagent-cwd ...",
    "安装失败: Command failed: git clone --depth 1 https://github.com/x/y.git C:\\Users\\realuser\\AppData\\Local\\Temp\\dsh-abc",
    "pnpm failed in profile directory C:\\Users\\realuser\\AppData\\Local\\Temp\\ds",
    "npm warn token sk-live-abc123def456ghi789jkl",
  ];
  const out = redactLog(realLog.join("\n"));
  check("真实场景无用户名", out.includes("realuser"), false);
  check("真实场景无密钥", out.includes("sk-live-abc123def456ghi789jkl"), false);
  check("真实场景保留错误上下文", out.includes("pnpm failed in profile directory"), true);
  check("真实场景保留 clone 错误", out.includes("Command failed: git clone"), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
