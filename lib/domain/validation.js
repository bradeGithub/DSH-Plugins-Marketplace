// 校验规则域（分层重构：纯函数，零 IO 零宿主依赖）。
// 环境键规则 / 信任主机 / patch 条目 / bundle 声明 / 版本比较 / 原型污染防护。

/**
 * R2：敏感环境变量判定——第三方 npm 安装/脚本运行时不得携带这些变量
 * （TOKEN / KEY / SECRET / PASSWORD / PASS / CREDENTIAL，大小写不敏感），
 * 防止 GITHUB_TOKEN、各类 API Key 等被插件静默读取上传。
 */
function isSensitiveEnvKey(name) {
  // 注意不能用 \b 词边界：下划线是 \w 单词字符，GITHUB_TOKEN 中 TOKEN 前无边界。
  // 用 (?!...)/(?<!...) 字母数字感知边界：GITHUB_TOKEN / OPENAI_API_KEY / DB_PASSWORD
  // 都命中，而 KEYBOARD_LAYOUT（KEY 后是 B）不误伤。
  // AUTH(?!_)：值端凭据形态（裸 AUTH / BASIC_AUTH / PROXY_AUTH 的 user:pass/token）命中，
  // AUTH_TYPE/AUTH_PATH 等非凭据配置不误伤；AUTH_TOKEN/AUTH_KEY 已由 TOKEN/KEY 覆盖。
  return /(?<![A-Za-z0-9])(TOKEN|KEY|SECRET|PASSWORD|PASS|CREDENTIALS?|AUTH(?!_))(?![A-Za-z0-9])/i.test(String(name ?? ""));
}

/** dsh bootstrap-only 键名（loadLayeredEnv 会拒绝 .env 设置它们，市场也不写）。 */
function isBootstrapOnlyEnvKey(name) {
  return /^DSH_[A-Z0-9_]+$/.test(String(name ?? ""));
}

/** env 键名格式校验：允许 UPPER_SNAKE 与驼峰（与 ENV_PATTERN 一致口径，拒绝 DSH_ 保留前缀）。 */
function isValidEnvKey(name) {
  if (typeof name !== "string" || !name || isBootstrapOnlyEnvKey(name)) return false;
  return /^[A-Z][A-Z0-9_]{1,}$/.test(name) || /^[a-z][A-Za-z0-9]*(?:ApiKey|Token|Secret|Password)$/.test(name);
}

/**
 * R1：Host 是否属于可信白名单——
 * - 本机回环：localhost / 127.0.0.1 / [::1]（DNS rebinding 攻击者域名永远不在其中）；
 * - 局域网私有网段：10.0.0.0/8、172.16.0.0/12、192.168.0.0/16（保留 README 承诺的局域网访问体验）；
 * - 环境变量 DSH_MARKETPLACE_ALLOWED_HOSTS（逗号分隔）可显式追加信任的主机名 / IP。
 */
function isTrustedHost(rawHost) {
  const host = String(rawHost ?? "").trim().toLowerCase();
  if (!host) return false;
  // 去掉端口部分（IPv6 形如 [::1]:3080，直接取括号内整体）
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1") return true;
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  const extra = (process.env.DSH_MARKETPLACE_ALLOWED_HOSTS ?? "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return extra.includes(hostname);
}

/** patch 中是否已有该包名的注册条目（行级精确匹配，避免前缀子串误判）。
 *  scoped 包名（@scope/name）以 @ 开头，YAML plain scalar 不允许，写入时加了引号，
 *  因此同时接受带单/双引号与不带引号的 name 行（兼容历史无引号条目）。 */
function hasPatchEntry(patchText, pkgName) {
  const escaped = pkgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp("^\\s*name:\\s*(?:\"|')?" + escaped + "(?:\"|')?\\s*$", "m");
  return pattern.test(patchText);
}

function hasDshPluginDeclaration(pkg) {
  if (!pkg || typeof pkg !== "object") return false;
  if (pkg.dsh && typeof pkg.dsh === "object") return true;
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
  const names = Object.keys(deps);
  return names.includes("@deepseek-ai/cordis")
    || names.includes("@deepseek-ai/dsh")
    || names.some((n) => n.startsWith("@deepseek-ai/dsh-"));
}

/**
 * 包是否声明 bundle 形态（dsh.bundle.patch）。bundle 包的实质内容在其 patch 层
 * （子插件行），单条 insert 只会挂载空壳入口——必须经 profile bundles 层注册（issue #134）。
 */
function isBundlePackage(pkg) {
  return Boolean(pkg && typeof pkg === "object" && pkg.dsh && typeof pkg.dsh === "object"
    && pkg.dsh.bundle && typeof pkg.dsh.bundle === "object"
    && typeof pkg.dsh.bundle.patch === "string" && pkg.dsh.bundle.patch.length > 0);
}

/**
 * 轻量语义版本比较：v1.2.3-rc.1 < v1.2.3；返回 -1/0/1；无法解析时回退字符串比较。
 * n3：预发布标识按「.」分段逐段比较（数字段按数值，rc.10 > rc.9）；
 * 支持两位/一位版本号（1.0、1 视为 1.0.0）；整串不匹配（如 1.2.3.4）视为无法解析。
 */
function compareVersions(a, b) {
  const parse = (v) => {
    const s = String(v).trim().replace(/^v/i, "");
    const m = s.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/);
    if (!m || m[0] !== s) return null;
    return {
      major: +m[1],
      minor: m[2] === undefined ? 0 : +m[2],
      patch: m[3] === undefined ? 0 : +m[3],
      pre: m[4] ?? null
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return String(a) === String(b) ? 0 : String(a) < String(b) ? -1 : 1;
  for (const key of ["major", "minor", "patch"]) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  return comparePre(pa.pre, pb.pre);
}

/** n3：预发布标识比较——无 pre > 有 pre；数字段按数值、数字标识 < 字母数字标识
 * （semver 规范 item 11：numeric identifiers always have lower precedence——
 * 1.0.0-1 < 1.0.0-alpha；突变测试 m21 暴露此前按相反规则判定）。 */
function comparePre(a, b) {
  if (a === b) return 0;
  if (!a) return 1; // 正式版 > 预发布
  if (!b) return -1;
  const pa = String(a).split(".");
  const pb = String(b).split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "";
    const y = pb[i] ?? "";
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      // 性质测试发现：数值相等（前导零形态 rc.01 vs rc.1）时 `<` 恒 false 返回 1 →
      // 双向都 1 破坏反对称；相等标识继续比下一段
      const nx = Number(x), ny = Number(y);
      if (nx !== ny) return nx < ny ? -1 : 1;
      continue;
    }
    if (xNum) return -1; // 数字标识 < 字母数字标识（semver）
    if (yNum) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** 是否有可用更新（纯函数）：installed 与 latest 都是有效版本且最新 > 已装。
 *  自更新两处 updateAvailable 判定共用此语义（<0 拼接处锁定，见 mutation findings m01/m02）。 */
function shouldUpdate(installed, latest) {
  return Boolean(installed && latest && compareVersions(installed, latest) < 0);
}

/** 判断依赖值是否为 pnpm 专用本地链接协议（npm 无法解析，会报 EUNSUPPORTEDPROTOCOL）。 */
function isPnpmLocalDependency(value) {
  return /^(link|workspace):/.test(String(value ?? ""));
}

function safeAssign(target, ...sources) {
  for (const s of sources) {
    for (const k of Object.keys(s)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      target[k] = s[k];
    }
  }
  return target;
}

export { isSensitiveEnvKey, isBootstrapOnlyEnvKey, isValidEnvKey, isTrustedHost, hasPatchEntry, hasDshPluginDeclaration, isBundlePackage, compareVersions, comparePre, shouldUpdate, isPnpmLocalDependency, safeAssign };
