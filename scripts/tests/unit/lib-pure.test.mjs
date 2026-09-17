import { compareVersions, shouldUpdate, isTrustedRequest, isTrustedHost, isSensitiveEnvKey, buildMinimalEnv, buildFilteredEnv, looksLikeDshPlugin, wslPosixPath, normalizeRepoRef, dedupeReposByPkgName, slugify, SCRIPT_ENV_KEYS, sanitizeLog, buildFeedbackLogSnapshot, buildEnvProfile, isCliInstallTarget, safeAssign, classifyInstallFailure, classifyInstallFailureKind } from "../../../lib/index.js";
import { isBootstrapOnlyEnvKey, isValidEnvKey, isSafeWebdavUrl } from "../../../lib/domain/validation.js";

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
// semver 规范：numeric identifiers 优先级低于 alphanumeric identifiers——1.0.0-1 < 1.0.0-alpha
// （突变测试 m21 暴露：此前实现按「数字 > 字母」判定，注释与规范都写反了）
check("数字 pre < 字母 pre（semver 规范）", compareVersions("1.0.0-1", "1.0.0-alpha"), -1);
check("字母 pre > 数字 pre（反向对称）", compareVersions("1.0.0-alpha", "1.0.0-1"), 1);
// 性质测试发现：反对称破坏——"rc.01" vs "rc.1" 数值相等时 `<` 恒 false 返回 1（双向都 1）。
// 相等标识应继续比下一段（前导零形态宽容处理，但必须保持反对称）。
check("rc.01 == rc.1（数值相等继续）", compareVersions("1.2.3-rc.01", "1.2.3-rc.1"), 0);
check("rc.1 == rc.01（对称）", compareVersions("1.2.3-rc.1", "1.2.3-rc.01"), 0);
// mutation findings m01/m02：updateAvailable 语义拼接处锁定（<0 即应更新）——抽出的纯函数三态 + 空守卫
check("shouldUpdate 新版 → true", shouldUpdate("1.0.0", "1.0.1"), true);
check("shouldUpdate 相等 → false", shouldUpdate("1.0.1", "1.0.1"), false);
check("shouldUpdate 旧版 → false", shouldUpdate("1.0.1", "1.0.0"), false);
check("shouldUpdate 无 installed → false", shouldUpdate(null, "1.0.1"), false);
check("shouldUpdate 无 latest → false", shouldUpdate("1.0.0", null), false);

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
// 突变测试 m24：172 网段只测了 172.16/172.32 两个端点——网段边界 172.15/172.31 未锁定
check("172.31.255.255 允许（网段上界内）", isTrustedHost("172.31.255.255"), true);
check("172.15.0.1 拒绝（网段下界外）", isTrustedHost("172.15.0.1"), false);
check("172.16.0.0 允许（网段下界）", isTrustedHost("172.16.0.0"), true);
check("172.32.0.1 拒绝（网段上界外）", isTrustedHost("172.32.0.1"), false);
check("isTrustedHost 域名 → 拒绝", isTrustedHost("evil.com:3080"), false);

// ---- S3: isSafeWebdavUrl（SSRF + 凭证明文外发防护，fail-closed 表驱动）----
// 合法：公网 https / 局域网 http(s)（NAS 场景）/ ULA IPv6 / mDNS / 单标签内网名
const WEBDAV_URL_CASES = [
  ["https 公网域名", "https://dav.example.com/backup.json", true],
  ["https 公网自定义端口", "https://dav.example.com:8443/backup.json", true],
  ["https 公网 IP", "https://8.8.8.8/x", true],
  ["http 私网 192.168（NAS）", "http://192.168.1.5:5005/bk.json", true],
  ["http 私网 10/8", "http://10.0.0.2/dav", true],
  ["http 私网 172.16/12 下界", "http://172.16.0.9/dav", true],
  ["http 私网 172.16/12 上界", "http://172.31.255.255/dav", true],
  ["https 私网 192.168", "https://192.168.1.5/dav", true],
  ["http mDNS .local", "http://nas.local:5005/dav", true],
  ["http 单标签内网名", "http://nas/dav", true],
  ["http ULA IPv6", "http://[fd00::1]/dav", true],
  ["https 全局 IPv6", "https://[2606:4700::1111]/dav", true],
  // 未压缩 8 组 IPv6（不经 "::" 压缩的分支）：WHATWG 对无可压缩零段的地址原样保留
  ["http 未压缩 8 组 IPv6 公网拒绝", "http://[1:2:3:4:5:6:7:8]/dav", false],
  ["https 未压缩 8 组 IPv6 公网", "https://[1:2:3:4:5:6:7:8]/dav", true],
  // v4-mapped：URL 规范化把尾段转成 hex 组（::ffff:8.8.8.8 → ::ffff:808:808），按映射后 IPv4 分类
  ["https IPv4-mapped 公网", "https://[::ffff:8.8.8.8]/dav", true],
  ["http IPv4-mapped 回环拒绝", "http://[::ffff:127.0.0.1]/dav", false],
  // http 公网一律拒绝（Basic 凭据禁走明文）
  ["http 公网域名拒绝", "http://dav.example.com/backup", false],
  ["http 公网 IP 拒绝", "http://8.8.8.8/x", false],
  ["http 172.15（私网段外）拒绝", "http://172.15.0.1/x", false],
  ["http 172.32（私网段外）拒绝", "http://172.32.0.1/x", false],
  // 受限网段：链路本地（云元数据）/ 回环 / 未指定 / CGNAT / 文档段 / 组播保留
  ["http 169.254 元数据端点拒绝", "http://169.254.169.254/latest/meta-data", false],
  ["https 169.254 同拒（scheme 不豁免网段）", "https://169.254.169.254/", false],
  ["http 回环 127.0.0.1 拒绝", "http://127.0.0.1:8080/x", false],
  ["http 回环 127.1 短式拒绝", "http://127.1/x", false],
  ["http 整数 IPv4 混淆拒绝", "http://2130706433/x", false],
  ["http 十六进制 IPv4 混淆拒绝", "http://0x7f.0.0.1/x", false],
  ["http 0.0.0.0 拒绝", "http://0.0.0.0/x", false],
  ["http CGNAT 100.64/10 拒绝", "http://100.64.1.1/x", false],
  ["http CGNAT 边界 100.127 拒绝", "http://100.127.255.254/x", false],
  ["http CGNAT 边界外 100.128 属公网（http 拒）", "http://100.128.0.1/x", false],
  ["http 文档段 192.0.2 拒绝", "http://192.0.2.1/x", false],
  ["http 文档段 198.51.100 拒绝", "http://198.51.100.1/x", false],
  ["http 文档段 203.0.113 拒绝", "http://203.0.113.9/x", false],
  ["http 基准测试段 198.18 拒绝", "http://198.18.0.1/x", false],
  ["http IETF 分配段 192.0.0 拒绝", "http://192.0.0.9/x", false],
  ["http 6to4 anycast 192.88.99 拒绝", "http://192.88.99.1/x", false],
  ["http 组播 224/4 拒绝", "http://224.0.0.1/x", false],
  ["http 保留段 240/4 拒绝", "http://240.0.0.1/x", false],
  ["http 广播 255.255.255.255 拒绝", "http://255.255.255.255/x", false],
  // IPv6 受限：回环 / 链路本地 / 内嵌 v4 走私 / 过渡机制 / 文档段
  ["http [::1] 回环拒绝", "http://[::1]:8080/x", false],
  ["http [::] 未指定拒绝", "http://[::]/x", false],
  ["http [fe80::1] 链路本地拒绝", "http://[fe80::1]/x", false],
  ["http [fe80::1%zone] 解析失败拒绝", "http://[fe80::1%25eth0]/x", false],
  ["http v4-mapped 回环（点分写法）拒绝", "http://[::ffff:127.0.0.1]/x", false],
  ["http v4-mapped 回环（hex 序列化）拒绝", "http://[::ffff:7f00:1]/x", false],
  ["http v4-mapped 链路本地拒绝", "http://[::ffff:a9fe:a9fe]/x", false],
  ["http v4-mapped 私网放行（与 v4 同规则）", "http://[::ffff:0a00:1]/x", true],
  ["http Teredo 前缀拒绝", "http://[2001::7f00:1]/x", false],
  ["http 6to4 前缀拒绝", "http://[2002:a9fe:a9fe::]/x", false],
  ["http NAT64 前缀拒绝", "http://[64:ff9b::a9fe:a9fe]/x", false],
  ["http 文档段 2001:db8 拒绝", "http://[2001:db8::1]/x", false],
  ["http 组播 ff02 拒绝", "http://[ff02::1]/x", false],
  // 凭据内嵌 / 非 http(s) / 无 scheme / 空值 / 畸形
  ["内嵌 user:pass 拒绝", "http://user:pass@192.168.1.5/x", false],
  ["内嵌 user 拒绝", "https://user@dav.example.com/x", false],
  ["javascript: 拒绝", "javascript:alert(1)", false],
  ["file: 拒绝", "file:///etc/passwd", false],
  ["ftp: 拒绝", "ftp://x/y", false],
  ["无 scheme 相对地址拒绝", "//dav.example.com/x", false],
  ["裸主机名拒绝", "dav.example.com/x", false],
  ["空串拒绝", "", false],
  ["null 拒绝", null, false],
  ["undefined 拒绝", undefined, false],
  ["畸形字符串拒绝", "not a url", false],
  ["localhost 域名拒绝", "http://localhost/dav", false],
  ["*.localhost 拒绝", "http://x.localhost/dav", false],
  // 端口不限制（NAS 自定义端口场景）
  ["http 私网非常用端口放行", "http://192.168.1.5:5005/dav", true],
  ["https 公网高位端口放行", "https://dav.example.com:4443/dav", true],
  // 大小写 / 首尾空白归一
  ["scheme 大小写归一", "HTTPS://DAV.EXAMPLE.COM/x", true],
  ["首尾空白裁剪", "  https://dav.example.com/x  ", true]
];
for (const [name, url, expected] of WEBDAV_URL_CASES) {
  check(`isSafeWebdavUrl ${name}`, isSafeWebdavUrl(url), expected);
}

// ---- R2: 敏感键过滤 ----
check("GITHUB_TOKEN 敏感", isSensitiveEnvKey("GITHUB_TOKEN"), true);
check("OPENAI_API_KEY 敏感", isSensitiveEnvKey("OPENAI_API_KEY"), true);
check("DB_PASSWORD 敏感", isSensitiveEnvKey("DB_PASSWORD"), true);
check("PASSWORD 敏感", isSensitiveEnvKey("PASSWORD"), true);
check("CREDENTIALS 敏感", isSensitiveEnvKey("AWS_CREDENTIALS"), true);
// AUTH 形态（值端凭据）：裸 AUTH / BASIC_AUTH / PROXY_AUTH 是真凭据（user:pass 或 token），
// 词表此前只有 TOKEN/KEY/SECRET/PASSWORD/PASS/CREDENTIALS——AUTH 形态全漏网。
check("AUTH 敏感", isSensitiveEnvKey("AUTH"), true);
check("BASIC_AUTH 敏感", isSensitiveEnvKey("BASIC_AUTH"), true);
check("PROXY_AUTH 敏感", isSensitiveEnvKey("PROXY_AUTH"), true);
check("HTTP_AUTH 敏感", isSensitiveEnvKey("HTTP_AUTH"), true);
check("AUTH_TYPE 不敏感（认证方式配置，非凭据）", isSensitiveEnvKey("AUTH_TYPE"), false);
check("AUTH_PATH 不敏感（认证令牌路径，非凭据）", isSensitiveEnvKey("AUTH_PATH"), false);
check("AUTHORIZATION 不敏感（词形不是凭据变量名）", isSensitiveEnvKey("AUTHORIZATION"), false);
// 突变测试 m23：/i 标志删除后敏感用例全用大写键名测不出——小写键名必须同样敏感
check("小写 github_token 敏感（/i 标志）", isSensitiveEnvKey("github_token"), true);
check("小写 api_key 敏感", isSensitiveEnvKey("api_key"), true);
check("小写 db_password 敏感", isSensitiveEnvKey("db_password"), true);
check("PATH 不敏感", isSensitiveEnvKey("PATH"), false);
check("TEMP 不敏感", isSensitiveEnvKey("TEMP"), false);
check("KEYBOARD_LAYOUT 不敏感", isSensitiveEnvKey("KEYBOARD_LAYOUT"), false);
check("MONKEY 不敏感", isSensitiveEnvKey("MONKEY"), false);
check("npm_config_registry 不敏感", isSensitiveEnvKey("npm_config_registry"), false);
check("NODE_OPTIONS 不敏感", isSensitiveEnvKey("NODE_OPTIONS"), false);

// ---- WSL 路径转换（script 型插件 install.sh 执行器）----
// win32 下 PATH 的 bash 可能是 WSL（C:\Windows\system32\bash.exe）：WSL 是真实 Linux
// bash，不认 `D:\...` 反斜杠路径（转义吞掉 → 127 找不到文件），必须转 /mnt/<盘>/...。
// Git Bash（MSYS）argv 层自动转换，无需处理。
check("wslPosixPath 反斜杠转 /mnt/<盘>", wslPosixPath("D:\\dogepy\\x\\install.sh"), "/mnt/d/dogepy/x/install.sh");
check("wslPosixPath 盘符小写", wslPosixPath("C:\\a\\b.sh"), "/mnt/c/a/b.sh");
check("wslPosixPath 已 POSIX 原样", wslPosixPath("/mnt/d/a.sh"), "/mnt/d/a.sh");
check("wslPosixPath 无盘符原样", wslPosixPath("relative/install.sh"), "relative/install.sh");

// ---- 规范化与去重语义（突变测试 m06/m16 + 性质测试：调用点行为未锁定/幂等性）----
check("normalizeRepoRef 大小写归一", normalizeRepoRef("Owner/Repo"), "owner/repo");
check("normalizeRepoRef https 大写域名", normalizeRepoRef("https://GITHUB.COM/Owner/Repo.GIT"), "owner/repo");
// 性质测试发现：非幂等——"Owner/Repo.git#main" 的 .git 剥离被 # 片段阻挡（$ 锚点在
// 片段末尾），首过输出 "owner/repo.git" 再归一才得 "owner/repo"——installedKey 不一致
check("normalizeRepoRef 幂等（#片段 + .git 组合）", normalizeRepoRef("https://github.com/Owner/Repo.git#main"), "owner/repo");
check("normalizeRepoRef 幂等（二次归一不变）", normalizeRepoRef(normalizeRepoRef("https://github.com/Owner/Repo.git#main")), "owner/repo");
check("dedupe 已装低星优先（同名包保已装）", dedupeReposByPkgName(
  [{ full_name: "b/new", name: "new", pkg_name: "same", stargazers_count: 999 },
   { full_name: "a/old", name: "old", pkg_name: "same", stargazers_count: 1 }],
  (r) => r.full_name === "a/old"
).repos[0].full_name, "a/old");
check("dedupe 无已装时高星优先", dedupeReposByPkgName(
  [{ full_name: "b/new", name: "new", pkg_name: "same", stargazers_count: 999 },
   { full_name: "a/old", name: "old", pkg_name: "same", stargazers_count: 1 }],
  () => false
).repos[0].full_name, "b/new");
check("dedupe 不同 pkg_name 不去重", dedupeReposByPkgName(
  [{ full_name: "a/x", pkg_name: "x" }, { full_name: "a/y", pkg_name: "y" }],
  () => false
).repos.length, 2);
// 性质测试发现：已装条目 stargazers_count 非数值（NaN）时 rank = 1e12 + NaN = NaN，
// 与未装条目比较恒不成立 → 已装条目被顶掉（1e12 保底只在 stars 数值时成立）。
check("dedupe 已装 + NaN stars 仍保留", dedupeReposByPkgName(
  [{ full_name: "b/new", name: "new", pkg_name: "same", stargazers_count: 999 },
   { full_name: "a/old", name: "old", pkg_name: "same", stargazers_count: NaN }],
  (r) => r.full_name === "a/old"
).repos[0].full_name, "a/old");
// 突变测试 m19/m22：slugify 与 SCRIPT_ENV_KEYS 未导出无测试——大小写归一是
// 缓存目录命名/键匹配的基础语义，白名单清单内容必须被测试锁定（同源比较测不出
// 「清单内容变了」——硬编码期望值断言清单本身）
check("slugify 大小写归一", slugify("My-Repo_1"), "my-repo-1");
check("slugify 特殊字符替换", slugify("a/b c!d"), "a-b-c-d");
check("slugify 空/纯符号回退", slugify(""), "plugin");
check("SCRIPT_ENV_KEYS 含 PATH", SCRIPT_ENV_KEYS.includes("PATH"), true);
check("SCRIPT_ENV_KEYS 含 TEMP", SCRIPT_ENV_KEYS.includes("TEMP"), true);
check("SCRIPT_ENV_KEYS 含 HOME", SCRIPT_ENV_KEYS.includes("HOME"), true);
check("SCRIPT_ENV_KEYS 含 APPDATA", SCRIPT_ENV_KEYS.includes("APPDATA"), true);
check("buildMinimalEnv 键集 ⊆ SCRIPT_ENV_KEYS（同源不脱节）", Object.keys(buildMinimalEnv()).every((k) => SCRIPT_ENV_KEYS.includes(k)), true);

// ---- sanitizeLog 脱敏完整性（性质测试观察项：词边界黏连 + 小写路径）----
// \b 词边界下 "xsk-<token>"（sk- 前接字母）不命中 → 完整密钥原样泄漏；Windows 路径
// 正则仅匹配大写 Users——真实文件系统大小写不敏感，小写路径同样必须脱敏。
const glued = sanitizeLog("error xsk-abcdef1234567890xyz end");
check("sanitizeLog 黏连形态脱敏（sk- 前接字母）", glued.includes("sk-abcdef1234567890xyz"), false);
check("sanitizeLog 黏连形态保留脱敏标记", /x?sk-abcdef…/.test(glued), true);
const lowPath = sanitizeLog("c:\\users\\alice\\.ssh\\config");
check("sanitizeLog 小写 users 路径脱敏", lowPath.includes("alice"), false);
check("sanitizeLog 小写路径含脱敏标记", lowPath.includes("~\\<user>"), true);
// 路径脱敏保留结构（AppData/Temp 等深层目录名），只隐藏用户名段——诊断价值与隐私平衡
const deepPath = sanitizeLog(String.raw`C:\Users\bob\AppData\Local\Temp\dsh-x`);
check("sanitizeLog 深层路径隐藏用户名", deepPath.includes("bob"), false);
check("sanitizeLog 深层路径保留结构", deepPath.includes(String.raw`~\<user>\AppData\Local\Temp`), true);
// /home 深层路径同款
const homeDeep = sanitizeLog("/home/carol/.dsh/profiles/web/node_modules/x");
check("sanitizeLog /home 深层隐藏用户名", homeDeep.includes("carol"), false);

// ---- 反馈诊断快照（真实 bug 场景样本驱动）----
{
  const realLog = [
    "[1/5] 克隆 https://github.com/lynx-gt/dsh-subagent-cwd ...",
    "克隆完成。",
    "[2/5] 识别安装类型: bundle 插件",
    "        判定报告：命中特征「package.json 声明 bundle 形态（dsh.bundle.patch）」→ 理由：bundle 包经 profile bundles 层注册",
    "[4/5] 开始安装 ...",
    "安装失败: pnpm 安装后仍未在 profile node_modules 解析到 dsh-subagent-cwd——pnpm 输出：Command failed: cmd.exe /c pnpm install",
  ];
  const snap = buildFeedbackLogSnapshot(realLog);
  check("快照含类型判定锚点行", snap.includes("[2/5]"), true);
  check("快照含判定报告锚点", snap.includes("判定报告"), true);
  check("快照含尾部错误行", snap.includes("pnpm 安装后仍未"), true);
  // 隐私：快照注入用户路径后必须脱敏
  const withPath = buildFeedbackLogSnapshot([...realLog, "Command failed: git clone C:\\Users\\secretname\\AppData\\Local\\Temp\\x"]);
  check("快照路径脱敏（无用户名）", withPath.includes("secretname"), false);
  check("快照路径脱敏（含 <user> 标记）", withPath.includes("~\\<user>"), true);
  // 密钥形态脱敏
  const withKey = buildFeedbackLogSnapshot(["npm warn token sk-abcdef123456789012345"]);
  check("快照密钥脱敏", withKey.includes("sk-abcdef1234567890"), false);
  // 限幅：超长日志截断到 2000 + 截断标记
  const bigLog = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(50)}`);
  const bigSnap = buildFeedbackLogSnapshot(bigLog);
  check("快照限幅 ≤2000+标记", bigSnap.length <= 2000 + 20 && bigSnap.includes("…(前段截断)…"), true);
  // 非数组容错
  check("快照非数组 → 空串", buildFeedbackLogSnapshot(null), "");
}
// ---- 环境画像（无个人数据）----
{
  const p = buildEnvProfile();
  check("画像 platform 字段", typeof p.platform, "string");
  check("画像 node 字段", typeof p.node, "string");
  check("画像 market 字段", typeof p.market, "string");
  check("画像无用户名/路径字段", JSON.stringify(p).match(/users|home|AppData|Lenovo/i), null);
}

// ---- R2: env 构造 ----
const filtered = buildFilteredEnv();
const sensitiveLeft = Object.keys(filtered).filter((k) => isSensitiveEnvKey(k));
check("buildFilteredEnv 无敏感键残留", sensitiveLeft, []);
const minimal = buildMinimalEnv();
const nonWhitelist = Object.keys(minimal).filter((k) => !["PATH", "PATHEXT", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "TEMP", "TMP", "TMPDIR", "SYSTEMROOT", "WINDIR", "COMSPEC", "SHELL", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "PWD", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramData", "COMPUTERNAME", "NODE_ENV", "CI", "GITHUB_ACTIONS"].includes(k));
check("buildMinimalEnv 只含白名单键", nonWhitelist, []);

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

// ---- isBootstrapOnlyEnvKey / isValidEnvKey（env 键校验纯函数）----
check("DSH_HOME 是 bootstrap-only", isBootstrapOnlyEnvKey("DSH_HOME"), true);
check("DSH_API_KEY 是 bootstrap-only", isBootstrapOnlyEnvKey("DSH_API_KEY"), true);
check("OPENAI_API_KEY 非 bootstrap-only", isBootstrapOnlyEnvKey("OPENAI_API_KEY"), false);
check("小写 dsh_ 非 bootstrap-only", isBootstrapOnlyEnvKey("dsh_home"), false);
check("非字符串 null 非 bootstrap-only", isBootstrapOnlyEnvKey(null), false);
check("UPPER_SNAKE 合法", isValidEnvKey("MY_API_KEY"), true);
check("驼峰 ApiKey 合法", isValidEnvKey("openaiApiKey"), true);
check("驼峰 Token 合法", isValidEnvKey("githubToken"), true);
check("DSH_ 保留前缀非法", isValidEnvKey("DSH_HOME"), false);
check("小写开头非法", isValidEnvKey("mykey"), false);
check("含空格非法", isValidEnvKey("BAD KEY"), false);
check("空串非法", isValidEnvKey(""), false);
check("非字符串非法", isValidEnvKey(42), false);

// ---- isCliInstallTarget（README dsh plugin 指令代执行目标白名单）----
// 安全契约：进入 runDsh argv 的 target 只允许 npm 包名（[@scope/]name[@ver]）或
// owner/repo 形态；win32 下经 cmd.exe /c 拼接，元字符 = 命令注入原语。
check("npm 裸包名", isCliInstallTarget("dsh-market"), true);
check("npm scope 包", isCliInstallTarget("@linxin666/dsh-web-ui-all"), true);
check("npm 包带版本", isCliInstallTarget("pkg@1.2.3"), true);
check("npm 包带 dist-tag", isCliInstallTarget("pkg@latest"), true);
check("npm scope+版本", isCliInstallTarget("@scope/name@2.0.0-beta.1"), true);
check("仓库 owner/repo", isCliInstallTarget("owner/repo"), true);
check("仓库名带下划线点", isCliInstallTarget("some_owner/re.po-x"), true);
check("& 命令分隔拒绝", isCliInstallTarget("a&calc"), false);
check("| 管道拒绝", isCliInstallTarget("a|whoami"), false);
check("; 分隔拒绝", isCliInstallTarget("a;b"), false);
check("% 变量展开拒绝", isCliInstallTarget("p%CD%x"), false);
check("! 延迟展开拒绝", isCliInstallTarget("a!b"), false);
check("> 重定向拒绝", isCliInstallTarget("a>b"), false);
check("() 子命令拒绝", isCliInstallTarget("a(b)"), false);
check("^ 转义组合拒绝（^^& 仍可逃逸）", isCliInstallTarget("a^^&b"), false);
check("^ 范围版本拒绝（fail-closed）", isCliInstallTarget("pkg@^1.2.3"), false);
check("$ 展开拒绝", isCliInstallTarget("a$PATH"), false);
check("反引号拒绝", isCliInstallTarget("a`id`"), false);
check("flag 注入拒绝", isCliInstallTarget("--force"), false);
check("仓库段 flag 注入拒绝", isCliInstallTarget("-x/repo"), false);
check("缺 repo 段拒绝", isCliInstallTarget("owner/"), false);
check("相对路径拒绝", isCliInstallTarget("../x/y"), false);
check("绝对路径拒绝", isCliInstallTarget("/etc/passwd"), false);
check("空值拒绝", isCliInstallTarget(""), false);
check("null 拒绝", isCliInstallTarget(null), false);
check("超长拒绝（>214）", isCliInstallTarget("a".repeat(215)), false);
check("前后空白容忍（trim）", isCliInstallTarget("  owner/repo  "), true);

// ---- classifyInstallFailure / classifyInstallFailureKind（共享 INSTALL_FAILURE_RULES 规则表）----
// 8 条规则各造一例 + 未命中兜底 unclassified；key 即反馈入队的 errorClass。
const KIND_CASES = [
  ["network", "fetch failed: ENOTFOUND registry.npmjs.org"],
  ["git-connectivity", "fatal: unable to access 'https://github.com/a/b.git/': Failed to connect to github.com port 443"],
  ["integrity", "npm ERR! code EINTEGRITY\nintegrity checksum failed"],
  ["version-missing", "No matching version found for dep@9.9.9"],
  ["native-build", "gyp ERR! stack Error: not found: python3"],
  ["module-missing", "internal/modules/cjs/loader: Cannot find module 'foo'"],
  ["command-failed", "ERR_PNPM_LOCKFILE_UP_TO_DATE Command failed with exit code 1"],
  ["permission", "npm ERR! code EACCES\nnpm ERR! syscall mkdir"]
];
for (const [kind, sample] of KIND_CASES) {
  check(`kind ${kind}`, classifyInstallFailureKind(sample), kind);
}
check("kind 未命中 → unclassified", classifyInstallFailureKind("just a normal error"), "unclassified");
check("kind null 输入 → unclassified", classifyInstallFailureKind(null), "unclassified");
// 规则顺序锁定：git clone 失败文本同时含「Command failed」与 git 连接签名，
// git-connectivity 必须先于 command-failed 命中（否则归类被笼统化为构建失败）。
check("kind git clone 复合文本 → git-connectivity", classifyInstallFailureKind(
  "Command failed: git clone --depth 1 https://github.com/a/b.git\nfatal: unable to access 'https://github.com/a/b.git/': Couldn't connect to server"
), "git-connectivity");
// classifyInstallFailure 返回值回归：规则表化后 hint 文案与 null 语义不变
check("hint 网络 zh", classifyInstallFailure("ENOTFOUND x", "zh").includes("网络"), true);
check("hint 网络 en", classifyInstallFailure("ENOTFOUND x", "en").includes("Network"), true);
check("hint git en 含 proxy", classifyInstallFailure("fatal: unable to access: Couldn't connect to server", "en").includes("proxy"), true);
check("hint 完整性 zh", classifyInstallFailure("EINTEGRITY", "zh").includes("完整性"), true);
check("hint 权限 en", classifyInstallFailure("EPERM: operation not permitted", "en").includes("Permission"), true);
check("hint 无匹配 → null", classifyInstallFailure("just a normal error"), null);

// ---- safeAssign 原型污染防护 ----
{
  const source = JSON.parse('{"__proto__":{"polluted":true},"ok":1}');
  const merged = safeAssign({}, source);
  check("safeAssign 不改变目标原型", Object.getPrototypeOf(merged), Object.prototype);
  check("safeAssign 不创建 __proto__ 自有键", Object.hasOwn(merged, "__proto__"), false);
  check("safeAssign 保留普通字段", merged.ok, 1);
}


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
