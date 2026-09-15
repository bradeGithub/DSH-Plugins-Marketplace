// 校验规则域（分层重构：纯函数，零 IO 零宿主依赖）。
// 环境键规则 / 信任主机 / WebDAV URL 安全 / patch 条目 / bundle 声明 / 版本比较 / 原型污染防护。

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

/**
 * S3：WebDAV 目标地址安全校验（SSRF + Basic 凭证明文外发防护，fail-closed）。
 * webdavUrl 来自请求 body——虽然两个写端点都有 isWriteAllowed 门禁（回环免 token /
 * LAN 需 lanWrite+token），但回环放行意味着本机任意进程都能借插件发请求，仍按
 * 外部输入处理。
 *
 * 规则：
 * - 仅允许 http/https 绝对 URL；解析失败、缺 host、内嵌 user:pass@ 一律拒绝
 *   （凭据走独立字段，内嵌形态 fetch 本身也会拒）；
 * - http 明文只允许局域网主机：私网 IPv4 / ULA IPv6 / .local（mDNS）/ 单标签内网名
 *   ——NAS WebDAV 的典型形态；公网一律要求 https（Basic 凭据与备份内容禁走明文）；
 * - 任意 scheme 都拒绝：回环（127/8、::1）、链路本地（169.254/16、fe80::/10——
 *   云元数据端点所在段）、未指定（0/8、::）、CGNAT（100.64/10）、组播、保留/文档段、
 *   IETF 分配段与过渡机制前缀（Teredo/6to4/NAT64——可在 IPv6 里走私内嵌 IPv4）；
 *   IPv4-mapped/compatible 内嵌地址按内嵌 v4 同规则判定；
 * - 端口不限制：NAS WebDAV 常用 5005/5006 等自定义端口，端口白名单只会误伤；
 * - 域名不做 DNS 解析（纯函数零 IO）：「域名先解析到公网、请求时 rebinding 到内网」
 *   的残留风险存在，但 DNS 预查同样有 TOCTOU 防不住——残余暴露靠端点门禁 +
 *   响应只回传备份 diff（不落库不外显）兜底。
 */
function isSafeWebdavUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl ?? "").trim());
  } catch {
    return false;
  }
  const secure = parsed.protocol === "https:";
  if (parsed.protocol !== "http:" && !secure) return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  const hostname = parsed.hostname;
  if (!hostname) return false;
  let kind;
  if (hostname.startsWith("[")) {
    kind = classifyWebdavIpv6(hostname.slice(1, -1));
  } else {
    // WHATWG 解析已把整数/十六进制/短式 IPv4（2130706433、0x7f.1、127.1）归一
    // 成点分四段——对归一化结果分类即可覆盖全部混淆写法。
    const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
      kind = classifyWebdavIpv4(+m[1], +m[2], +m[3], +m[4]);
    } else {
      if (hostname === "localhost" || hostname.endsWith(".localhost")) return false;
      kind = (hostname.endsWith(".local") || !hostname.includes(".")) ? "lan" : "public";
    }
  }
  if (kind === "deny") return false;
  if (kind === "public") return secure;
  return true;
}

/** IPv4 四段 → "lan"（私网，http/https 均可）/ "public"（须 https）/ "deny"（一律拒绝）。 */
function classifyWebdavIpv4(a, b, c) {
  if (a === 10) return "lan";                                        // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return "lan";                 // 172.16.0.0/12
  if (a === 192 && b === 168) return "lan";                          // 192.168.0.0/16
  if (a === 0) return "deny";                                        // 0.0.0.0/8 本网络/未指定
  if (a === 127) return "deny";                                      // 127.0.0.0/8 回环
  if (a === 169 && b === 254) return "deny";                         // 169.254.0.0/16 链路本地（云元数据）
  if (a === 100 && b >= 64 && b <= 127) return "deny";               // 100.64.0.0/10 CGNAT 共享段
  if (a === 192 && b === 0 && c === 0) return "deny";                // 192.0.0.0/24 IETF 协议分配
  if (a === 192 && b === 0 && c === 2) return "deny";                // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return "deny";              // 192.88.99.0/24 6to4 中继 anycast
  if (a === 198 && (b === 18 || b === 19)) return "deny";            // 198.18.0.0/15 基准测试
  if (a === 198 && b === 51 && c === 100) return "deny";             // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return "deny";              // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return "deny";                                       // 224.0.0.0/4 组播 + 240.0.0.0/4 保留
  return "public";
}

/** IPv6 字面量（不含方括号）→ 同三态；解析失败返回 "deny"（fail-closed）。 */
function classifyWebdavIpv6(inner) {
  const b = parseIpv6Bytes(inner);
  if (b === null) return "deny";
  // ::/96（v4-compatible/未指定/回环）与 ::ffff:0:0/96（v4-mapped）：内嵌 v4 按 v4 规则判定
  // —— ::1 → 0.0.0.1（0/8 拒绝）、[::ffff:7f00:1] → 127.0.0.1 都由这张表覆盖。
  if (b[10] === 0xff && b[11] === 0xff && b.slice(0, 10).every((x) => x === 0)) {
    return classifyWebdavIpv4(b[12], b[13], b[14], b[15]);
  }
  if (b.slice(0, 12).every((x) => x === 0)) {
    return classifyWebdavIpv4(b[12], b[13], b[14], b[15]);
  }
  if (b[0] === 0xff) return "deny";                                  // ff00::/8 组播
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return "deny";        // fe80::/10 链路本地
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return "deny"; // 2001:db8::/32 文档段
  if (b[0] === 0x3f && (b[1] & 0xf0) === 0xf0) return "deny";        // 3fff::/20 文档段
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return "deny"; // 2001::/32 Teredo
  if (b[0] === 0x20 && b[1] === 0x02) return "deny";                 // 2002::/16 6to4
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return "deny"; // 64:ff9b::/32 NAT64
  if ((b[0] & 0xfe) === 0xfc) return "lan";                          // fc00::/7 ULA 私网
  return "public";
}

/** IPv6 字面量 → 16 字节数组；非法输入返回 null。支持 "::" 压缩与尾段内嵌 IPv4。 */
function parseIpv6Bytes(input) {
  let s = String(input ?? "");
  if (s === "" || /[^0-9a-fA-F:.]/.test(s)) return null;
  let tail = null;
  const v4 = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const oct = v4.slice(1).map(Number);
    if (oct.some((o) => o > 255)) return null;
    tail = oct;
    s = s.slice(0, s.length - v4[0].length);
    if (s.endsWith(":") && !s.endsWith("::")) s = s.slice(0, -1);
  }
  let groups;
  const dc = s.indexOf("::");
  if (dc >= 0) {
    if (dc !== s.lastIndexOf("::")) return null;                     // 至多一个 "::"
    const lp = s.slice(0, dc) === "" ? [] : s.slice(0, dc).split(":");
    const rp = s.slice(dc + 2) === "" ? [] : s.slice(dc + 2).split(":");
    if (lp.some((g) => g === "") || rp.some((g) => g === "")) return null;
    const need = 8 - lp.length - rp.length - (tail ? 2 : 0);
    if (need < 1) return null;                                       // "::" 至少压缩一组
    groups = lp.concat(new Array(need).fill("0"), rp);
  } else {
    groups = s.split(":");
    if (groups.some((g) => g === "")) return null;
    if (groups.length + (tail ? 2 : 0) !== 8) return null;
  }
  const bytes = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const v = Number.parseInt(g, 16);
    bytes.push(v >> 8, v & 0xff);
  }
  if (tail) bytes.push(tail[0], tail[1], tail[2], tail[3]);
  return bytes.length === 16 ? bytes : null;
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

/**
 * README 提取的 `dsh plugin install/add <target>` 代执行目标白名单判定（纯函数）。
 * 合法形态仅两种：npm 包名（`[@scope/]name`，可带 `@version`/`@dist-tag`）
 * 或 GitHub `owner/repo`。字符集刻意排除 shell/cmd 元字符
 * （& | ; < > ( ) % ! ^ $ ` " ' 空白等）：win32 下 runDsh 经 cmd.exe /c
 * 拼接参数，元字符会被解释为命令分隔/重定向/变量展开（`a&calc`、`pkg@%CD%`）。
 * `^` 单独看是转义符，但与元字符组合可逃脱（`^^&` → 字面 ^ 后仍剩 &），一并排除。
 * 每段必须字母数字开头，防 `-x`/`--flag` 形态被 dsh 参数解析当成选项注入。
 */
function isCliInstallTarget(target) {
  const t = String(target ?? "").trim();
  if (!t || t.length > 214) return false;
  // npm 形态：[@scope/]name[@version|dist-tag]
  if (/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.*~+-]+)?$/i.test(t)) return true;
  // 仓库形态：owner/repo（段首允许 . 兼容 `.github` 类仓库名，但不允许 - 开头的 flag 形态）
  return /^[a-z0-9][\w-]*\/[a-z0-9._][\w.-]*$/i.test(t);
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

export { isSensitiveEnvKey, isBootstrapOnlyEnvKey, isValidEnvKey, isTrustedHost, isSafeWebdavUrl, hasPatchEntry, hasDshPluginDeclaration, isBundlePackage, compareVersions, comparePre, shouldUpdate, isPnpmLocalDependency, isCliInstallTarget, safeAssign };
