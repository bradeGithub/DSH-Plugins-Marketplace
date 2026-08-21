// 日志脱敏模块（纯函数，零依赖）：安装日志附到公开 GitHub issue 前的净化。
// 设计原则：公开渠道是默认拒绝场景——误掩码代价低，漏报代价高（gitleaks/Sentry 同款取舍）。
// 五道机制（按执行顺序）：
//   注入净化——CR/LF 与控制字符（OWASP 日志注入）+ markdown 围栏逃逸防护
//   已知密钥——结构化形态（云厂商前缀/JWT/PEM/连接串/webhook，参考 gitleaks 规则集与 DeepSec 规则语义）
//   用户路径——保留深层结构只隐藏用户名段
//   上下文邻近——关键词(token/password/secret…) + 分隔符 + 值，allowlist 压误报
//   高熵/编码兜底——「熵 + 字符多样性」组合抓无前缀随机串；base64 解码重扫已知形态

/** Shannon 熵（每字符比特，0-8 for byte alphabet）。 */
export function shannonEntropy(s) {
  const str = String(s ?? "");
  if (str.length === 0) return 0;
  const freq = new Map();
  for (const ch of str) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / str.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// ---- allowlist：压上下文邻近误报 ----
// 停用词精选 ~30 词（700 词表无收益，30 词覆盖 90% 场景）——命中即视为非密钥。
const STOPWORDS = new Set([
  "example", "examples", "sample", "samples", "test", "tests", "testing",
  "placeholder", "changeme", "change_me", "changelog", "readme", "docs",
  "mock", "mocked", "dummy", "fake", "fixture", "fixtures", "template",
  "your", "yourname", "your_api_key", "apikey", "api_key", "token",
  "password", "secret", "credentials", "config", "default", "undefined",
  "null", "true", "false"
]);

/** 值是否疑似密钥：非停用词、含数字或混合形态、长度达标。 */
function looksSecretLike(value) {
  const v = String(value ?? "");
  if (v.length < 8 || v.length > 150) return false;
  if (STOPWORDS.has(v.toLowerCase())) return false;
  // 纯小写字母/常见词组合（如 error-module-not-found）是标识符不是密钥
  if (/^[a-z0-9_-]+$/.test(v) && !/\d/.test(v)) return false;
  return true;
}

// ---- 已知密钥规则集（已知前缀/结构化形态）----
// 形态参考 gitleaks 规则集与 DeepSec（MIT）规则语义，JS 正则实现。
const KNOWN_KEY_RULES = [
  // 云厂商密钥（AWS 临时凭证 ASIA/ABIA/ACCA/A3T + base32 字符集无 0189）
  { re: /\b(?:AKIA|ASIA|ABIA|ACCA|A3T)[A-Z2-7]{16,}\b/g, name: "aws" },
  { re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}\b/g, name: "secret-key" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g, name: "github" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g, name: "github-pat" },
  { re: /\bglpat-[A-Za-z0-9_-]{20,255}\b/g, name: "gitlab" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,250}\b/g, name: "slack" },
  { re: /\bnpm_[A-Za-z0-9]{20,64}\b/g, name: "npm" },
  { re: /\bhf_[A-Za-z0-9]{34,40}\b/g, name: "huggingface" },
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, name: "anthropic" },
  { re: /\bAIza[A-Za-z0-9_-]{35}\b/g, name: "google" },
  // JWT 三段式（header.payload.signature）
  { re: /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, name: "jwt" },
  // PEM 私钥块（含跨行）
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g, name: "pem" },
  // DB/服务连接串带凭证（user:pass@）
  { re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp|smtp)(?:\+srv)?:\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/g, name: "db-url" },
  // Webhook（Slack/Discord/Teams）
  { re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9+/]{40,120}/g, name: "slack-webhook" },
  { re: /https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d{10,20}\/[A-Za-z0-9_-]{30,120}/g, name: "discord-webhook" },
];

// 用户路径脱敏：保留深层结构只隐藏用户名段（诊断价值与隐私平衡）。
// 捕获组排除集含 $（防 /home/x/y$HOME/z 粘连）与常见日志分隔符 |;,)(（防多路径粘连吞段）。
const PATH_RULES = [
  { re: /[A-Za-z]:\\Users\\[^\\]+((?:\\[^\s"\\:|;,)]+)*)/gi, to: (_m, rest) => `~\\<user>${rest}` },
  { re: /\$HOME\/[^\s"]+|\/home\/[^/\s"$]+((?:\/[^\s"/:$();|,]+)*)/g, to: (_m, rest) => `~/<user>${rest}` },
];

const MASK = "[REDACTED]";

/** 上下文邻近：密钥关键词 + 分隔符 + 值。宽松策略——关键词命中且值过 allowlist 即掩码。 */
const CONTEXT_RE = /\b(?:password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|auth[-_]?token|bearer|credential[s]?|private[-_]?key|client[-_]?secret)\b["']?\s*(?:[:=]|=>|:=)\s*["']?([^\s"',;)}\]]{8,150})/gi;

// 控制字符类（除 \n \t）：可打印性校验与注入净化共用
const CONTROL_CHARS = "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]";

/** base64 严格解码：仅接受解码结果为可打印文本（含控制字符/乱码返回 null）。
 *  用于编码密钥重扫——解码失败（非 base64）或解码出乱码都按原串处理。 */
function tryDecodeBase64(tok) {
  try {
    const decoded = Buffer.from(tok, "base64").toString("utf8");
    if (decoded.length === 0) return null;
    if (new RegExp(CONTROL_CHARS).test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * 日志脱敏主入口：
 * 1. 注入净化（CR/LF 统一 + 控制字符剔除）
 * 2. 已知密钥掩码
 * 3. 用户路径脱敏
 * 4. Bearer/Basic 头凭证掩码
 * 5. 上下文邻近捕获 + allowlist 过滤
 * 6. 高熵/编码串兜底（熵+多样性组合；base64 解码重扫已知形态）
 * 7. markdown 围栏净化（防击穿 issue 的 details 折叠块）
 */
export function redactLog(text) {
  let s = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(new RegExp(CONTROL_CHARS, "g"), "");
  for (const rule of KNOWN_KEY_RULES) s = s.replace(rule.re, `[${rule.name.toUpperCase()}-REDACTED]`);
  for (const rule of PATH_RULES) s = s.replace(rule.re, rule.to);
  s = s.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._+/=-]{16,2048}/gi, (_m, scheme) => `${scheme} ${MASK}`);
  // 已掩码值（[ 开头）跳过——已知密钥规则处理过的不再二次掩码（避免 [AWS-REDACTED] 被截成 [REDACTED]]）
  s = s.replace(CONTEXT_RE, (match, value) => {
    if (value.startsWith("[") || !looksSecretLike(value)) return match;
    return match.slice(0, match.length - value.length) + MASK;
  });
  // 高熵混合串兜底 + base64 解码重扫：候选串先试解码——解码后命中已知密钥/路径形态才掩
  //（低熵编码密钥如 base64(AKIA...) 靠这层）；解码不命中且「熵≥3.5 + 字母数字混合」按随机串掩。
  // 纯熵阈值不可行——实测 base64 密钥 4.1-4.4、md5 3.6，均低于 gitleaks 的 4.5 参考值。
  // 前后不邻接 / .（URL 路径段/域名/版本号特征）；= 并入 token（base64 padding）。
  s = s.replace(/(?<![/\w.])[A-Za-z0-9+/=]{20,}(?![/\w.])/g, (tok) => {
    const decoded = tryDecodeBase64(tok);
    if (decoded) {
      for (const rule of KNOWN_KEY_RULES) {
        if (rule.re.test(decoded)) return MASK;
        rule.re.lastIndex = 0;
      }
      if (/[A-Za-z]:\\Users\\|\/home\/|\$HOME\//.test(decoded)) return MASK;
    }
    const mixed = /[A-Za-z]/.test(tok) && /\d/.test(tok);
    if (mixed && shannonEntropy(tok) >= 3.5) return MASK;
    return tok;
  });
  // markdown 围栏逃逸防护（附 issue 特有：``` 会击穿 details 折叠块）
  s = s.replace(/`{3,}/g, "'''");
  return s;
}

/**
 * markdown 围栏逃逸防护（附 issue 特有）：日志中的 ``` 会击穿 details 折叠块，
 * 把后续内容渲染为正文。把围栏序列替换为不可击穿的等价形式。
 */
export function neutralizeMarkdownFences(text) {
  return String(text ?? "").replace(/`{3,}/g, "'''");
}
