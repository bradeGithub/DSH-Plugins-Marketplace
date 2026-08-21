import { compareVersions, shouldUpdate, isTrustedRequest, isTrustedHost, isSensitiveEnvKey, buildMinimalEnv, buildFilteredEnv, looksLikeDshPlugin, wslPosixPath, normalizeRepoRef, dedupeReposByPkgName, slugify, SCRIPT_ENV_KEYS, sanitizeLog, buildFeedbackLogSnapshot, buildEnvProfile } from "../../../lib/index.js";

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
  [{ full_name: "a/x", pkg_name: "x" }, { full_name: "a/y", pkg_name: "y" }]
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


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
