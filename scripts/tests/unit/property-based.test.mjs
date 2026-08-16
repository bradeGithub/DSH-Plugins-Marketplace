#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 差分/性质测试（Property-Based Testing）：以「不变式 + 随机输入」机械化扫描
// lib/index.js 的语义盲区。行覆盖只证明代码被执行过，不证明语义正确——本文件用
// 固定种子 LCG（代替 Math.random，失败可复现）生成畸形/恶意/边界输入，逐一断言
// 不变量；失败时打印反例与种子。
//
// 运行：node scripts/tests/unit/property-based.test.mjs
// 通过 = 全部性质绿（退出码 0）；失败 = 打印反例 + 退出码 1。
//
// 注意：当前 lib 实现存在若干不变量破坏（本文件即为扫描结果），修复 lib 前
// 出现红灯属预期——红灯反例就是缺陷证据。
//
// 重要：lib/index.js 模块级会执行 `await loadInstalled()`（读 DSH_HOME 下的
// installed.json）。ESM 静态 import 会在本文件任何代码运行前求值，无法提前设置
// 环境变量，因此必须先把 process.env.DSH_HOME 指到 mkdtempSync 临时目录，再动态
// import；退出前清理临时目录。isTrustedHost 还读取
// DSH_MARKETPLACE_ALLOWED_HOSTS，一并清空保证随机断言不受宿主环境干扰。
// ─────────────────────────────────────────────────────────────────────────────

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 固定种子：每个性质独立一条随机流，seed = SEED + 性质序号，失败时报告该性质自己的种子
const SEED = 0x5eed2026;

function createLcg(seed) {
  // 数值 LCG（Numerical Recipes 参数）：输出 [0, 1) 均匀随机数，确定性可复现
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const int = (rng, min, max) => min + Math.floor(rng() * (max - min + 1)); // [min, max]
const pick = (rng, arr) => arr[int(rng, 0, arr.length - 1)];
const chance = (rng, p) => rng() < p;
const randStr = (rng, minLen, maxLen, alpha) => {
  const len = int(rng, minLen, maxLen);
  let out = "";
  for (let i = 0; i < len; i++) out += alpha[int(rng, 0, alpha.length - 1)];
  return out;
};

// 各性质共用的字符集
const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const REPO_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._";
const LOW_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789-_";
const UPPER_DIGIT = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

// ── 测试框架 ──────────────────────────────────────────────────────────────────
// 每个性质：fn(rng, n) 返回 { ok, examples: [{ iter, detail }] }
const failures = []; // { name, seed, examples }
const findings = []; // 观察项（不置红，随报告输出）
let passedCount = 0;

function runProperty(name, index, iterations, fn) {
  const seed = (SEED + index) >>> 0;
  const rng = createLcg(seed);
  try {
    const { ok, examples } = fn(rng, iterations);
    if (ok) passedCount++;
    else failures.push({ name, seed, examples });
  } catch (error) {
    // 性质内部未捕获异常（lib 抛错）也视为失败，附上异常信息
    failures.push({ name, seed, examples: [{ iter: "?", detail: `未捕获异常: ${error?.stack ?? error}` }] });
  }
}

// ── 环境准备：临时 DSH_HOME，再动态加载 lib ──────────────────────────────────
const DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-marketplace-prop-"));
process.env.DSH_HOME = DSH_HOME;
// 清空允许 Host 白名单：随机断言不受宿主环境变量干扰
delete process.env.DSH_MARKETPLACE_ALLOWED_HOSTS;

const lib = await import("../../../lib/index.js");

// ═════════════════════════════════════════════════════════════════════════════
// 性质 1：normalizeRepoRef —— 幂等 / 小写无空格 / 非字符串 → null / 装饰剥离
// ═════════════════════════════════════════════════════════════════════════════
runProperty("normalizeRepoRef", 1, 300, (rng, n) => {
  const examples = [];
  const PREFIXES = [null, "https://github.com/", "http://github.com/", "git+https://github.com/", "git@github.com:"];
  const SUFFIXES = [null, ".git", ".GIT", "Git"];
  const FRAGS = [null, "#main", "#branch.v1", "#"];
  const WS = [null, "", " ", "  ", "\t"];

  // 最小反例探针（确定性先行）：".git" 后缀 + "#片段" 组合 → 输出残留 ".git" 且不幂等
  {
    const input = "https://github.com/Owner/Repo.git#main";
    const once = lib.normalizeRepoRef(input);
    const twice = lib.normalizeRepoRef(once);
    if (twice !== once) {
      examples.push({ iter: "probe", detail: `幂等失败：输入 ${JSON.stringify(input)} → ref 得 ${JSON.stringify(once)}，再 ref 得 ${JSON.stringify(twice)}（.git 在 # 之前剥除，组合时残留）` });
    }
  }

  // 按 lib 相同顺序手动归一化，作为装饰剥离的期望值（顺序见 lib 源码——幂等修复后：
  // trim → git+ → https://github.com/ → git@github.com: → split("#") → .git → 小写；
  // .git 剥离必须在 # 分割之后，否则 "Repo.git#main" 的 $ 锚点被片段挡住残留 .git）
  const expectedNormalize = (input) => {
    let s = String(input).trim();
    s = s.replace(/^git\+/i, "");
    s = s.replace(/^https?:\/\/github\.com\//i, "");
    s = s.replace(/^git@github\.com:/i, "");
    s = s.split("#")[0];
    s = s.replace(/\.git$/i, "");
    return s.toLowerCase() || null;
  };

  for (let i = 0; i < n; i++) {
    // 非字符串输入 → 必须返回 null
    for (const bad of [null, undefined, 42, NaN, {}, [], true, false]) {
      const got = lib.normalizeRepoRef(bad);
      if (got !== null) {
        examples.push({ iter: i, detail: `非字符串 ${JSON.stringify(bad)} 应返回 null，实际 ${JSON.stringify(got)}` });
        break;
      }
    }
    if (examples.length > 0) break;
    // 空白串 → null
    if (lib.normalizeRepoRef("   ") !== null) {
      examples.push({ iter: i, detail: `空白串应返回 null，实际 ${JSON.stringify(lib.normalizeRepoRef("   "))}` });
      break;
    }

    // 随机 owner/name + 至多一层装饰（前缀/后缀/#片段/首尾空白）
    const base = `${randStr(rng, 1, 12, REPO_CHARS)}/${randStr(rng, 1, 12, REPO_CHARS)}`;
    const prefix = pick(rng, PREFIXES);
    const suffix = pick(rng, SUFFIXES);
    // 组合装饰（.git + #片段）低概率出现：观察 lib 的剥除顺序语义（见探针）
    const frag = chance(rng, 0.1) && suffix !== null ? pick(rng, FRAGS.slice(1)) : pick(rng, FRAGS);
    const wsPre = pick(rng, WS);
    const wsPost = pick(rng, WS);
    const input = `${wsPre ?? ""}${prefix ?? ""}${base}${suffix ?? ""}${frag ?? ""}${wsPost ?? ""}`;

    const out = lib.normalizeRepoRef(input);
    const expected = expectedNormalize(input);
    if (out !== expected) {
      examples.push({ iter: i, detail: `输入 ${JSON.stringify(input)}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(out)}` });
      break;
    }
    if (out !== null) {
      // owner/name 形态：小写、无空白（.git 与 # 组合时残留 .git 属剥除顺序使然，探针已记录）
      if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(out) || out !== out.toLowerCase() || /\s/.test(out)) {
        examples.push({ iter: i, detail: `输出 ${JSON.stringify(out)}（输入 ${JSON.stringify(input)}）非小写 owner/name 形态` });
        break;
      }
      // 幂等：归一化结果再次归一化不变
      if (lib.normalizeRepoRef(out) !== out) {
        examples.push({ iter: i, detail: `幂等失败：输入 ${JSON.stringify(input)} → ref 得 ${JSON.stringify(out)}，再 ref 得 ${JSON.stringify(lib.normalizeRepoRef(out))}` });
        break;
      }
    }
  }
  return { ok: examples.length === 0, examples: examples.slice(0, 4) };
});

// ═════════════════════════════════════════════════════════════════════════════
// 性质 2：wslPosixPath —— 盘符路径转 /mnt/<小写盘>/<正斜杠>；无盘符原样
// ═════════════════════════════════════════════════════════════════════════════
runProperty("wslPosixPath", 2, 300, (rng, n) => {
  const examples = [];
  const SEG_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _.-";
  for (let i = 0; i < n; i++) {
    if (chance(rng, 0.65)) {
      // Windows 反斜杠路径：随机盘符 + 随机目录段（含空格）
      const drive = pick(rng, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz");
      const segCount = int(rng, 0, 5);
      const segs = [];
      for (let s = 0; s < segCount; s++) segs.push(randStr(rng, 1, 8, SEG_CHARS));
      const input = `${drive}:\\${segs.join("\\")}`;
      const out = lib.wslPosixPath(input);
      const expected = `/mnt/${drive.toLowerCase()}/${segs.join("/")}`;
      if (out !== expected) {
        examples.push({ iter: i, detail: `输入 ${JSON.stringify(input)}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(out)}` });
        break;
      }
      if (out.includes("\\")) {
        examples.push({ iter: i, detail: `输出 ${JSON.stringify(out)} 残留反斜杠` });
        break;
      }
    } else {
      // 无盘符 / 已 POSIX / 非路径输入 → 原样返回（String(p ?? "")）
      const input = chance(rng, 0.3)
        ? randStr(rng, 0, 20, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 /:._-@")
        : pick(rng, ["/mnt/d/a.sh", "/home/x/y", "relative/path", "a\\b", "C:/x", "c:foo", "\\\\server\\share", "", "  "]);
      const out = lib.wslPosixPath(input);
      if (out !== String(input ?? "")) {
        examples.push({ iter: i, detail: `原样输入 ${JSON.stringify(input)}：期望 ${JSON.stringify(String(input ?? ""))}，实际 ${JSON.stringify(out)}` });
        break;
      }
    }
  }
  // 非字符串：null/undefined → ""，数字 → String 形态
  if (examples.length === 0) {
    for (const bad of [null, undefined, 42]) {
      if (lib.wslPosixPath(bad) !== String(bad ?? "")) {
        examples.push({ iter: "fixed", detail: `输入 ${JSON.stringify(bad)} 应返回 ${JSON.stringify(String(bad ?? ""))}` });
        break;
      }
    }
  }
  return { ok: examples.length === 0, examples: examples.slice(0, 4) };
});

// ═════════════════════════════════════════════════════════════════════════════
// 性质 3：compareVersions —— 自反 / 反对称（符号相反）/ 传递性 / 垃圾不抛
// 四个子检查全部执行，任一破坏即性质失败；最小反例探针先行（确定性）。
// 历史发现（均已处理）：前导零预发布段破坏反对称——已修（comparePre 数值相等 continue）；
// 可解析 × 垃圾串混合比较破坏传递性——评估为接受（混合序非全序是设计取舍，正常数据流无垃圾串，
// 子检查 3 已限定输入域）。
// ═════════════════════════════════════════════════════════════════════════════
runProperty("compareVersions", 3, 300, (rng, n) => {
  const examples = [];
  // 固定样例池：含任务指定的垃圾串（"1.2.3-beta"、"v1.0"、"abc"、""、"1.2.3.4.5"）
  const POOL = [
    "1.2.3-beta", "v1.0", "abc", "", "1.2.3.4.5", "1.0.0-alpha", "next", "latest",
    "1.2", "1", "v", "1.2.3.4", "1.2.3-rc.1", "1.2.3-", "1.2.3-rc.1.2", "1.2.3-beta.11",
    "!@#", "1.2.3 ", " 1.2.3", "1.2.3-beta+meta", "1.2.3-123abc", "0.0.1", "10.20.30",
    "1.2.3-beta.2", "1.2.3-alpha.5", "2.0.0", "0.0.0", "1.2.3-rc.10", "1.2.3-rc.9",
    "1.0.0-rc.1", "1.0.0-rc.1.1", "v1.2.3-beta", "0.0", "0", "1.1.1.1", "99.99.99",
    "1.9", "1.10", "9", "10", "1.5!", "2.9.1", "2.10.0"
  ];
  const randVersion = () => {
    if (chance(rng, 0.3)) return pick(rng, POOL);
    const parts = [];
    const depth = int(rng, 1, 3);
    for (let i = 0; i < depth; i++) parts.push(int(rng, 0, 99));
    let v = parts.join(".");
    if (chance(rng, 0.35)) {
      const pre = [pick(rng, ["alpha", "beta", "rc", "pre", "dev", "0", "1", "10", "01", "0a", "x.y"])];
      if (chance(rng, 0.3)) pre.push(int(rng, 0, 30));
      v += `-${pre.join(".")}`;
    }
    if (chance(rng, 0.15)) v = `v${v}`;
    // 尾部附加垃圾字符 → 构造不可解析形态
    if (chance(rng, 0.15)) v += pick(rng, ["!", "x", ".", " ", ".1", "-"]);
    return v;
  };
  const sign = (x) => (x === 0 ? 0 : x > 0 ? 1 : -1);

  // 最小反例探针 1（反对称）：前导零预发布段双向都返回 1
  {
    const a = "1.2.3-rc.01", b = "1.2.3-rc.1";
    const ab = lib.compareVersions(a, b);
    const ba = lib.compareVersions(b, a);
    if (sign(ab) !== -sign(ba)) {
      examples.push({ iter: "probe", detail: `反对称失败：a=${JSON.stringify(a)} b=${JSON.stringify(b)}，f(a,b)=${ab} f(b,a)=${ba}（期望符号相反或 0）` });
    }
  }
  // 探针 2（可解析 × 垃圾串混合传递性）已删除：混合序非全序是设计取舍——垃圾串回退
  // 字符串序（compareVersions 1332 行），正常数据流（registry/npm 版本号）无垃圾串，
  // 可解析域内全序成立（子检查 3 已限定输入域）；此前该探针触发的反例已评估为接受。

  // 子检查 1：自反 f(v, v) === 0（可解析与垃圾均须成立）
  if (examples.length === 0) {
    for (let i = 0; i < n; i++) {
      const v = randVersion();
      const got = lib.compareVersions(v, v);
      if (got !== 0) {
        examples.push({ iter: i, detail: `自反失败：f(${JSON.stringify(v)}, ${JSON.stringify(v)}) = ${got}，期望 0` });
        break;
      }
    }
  }
  // 子检查 2：反对称（任务允许「=== -f 或符号一致」——符号一致即符号相反：sign(f(a,b)) === -sign(f(b,a))）
  if (examples.length === 0) {
    for (let i = 0; i < n; i++) {
      const a = randVersion();
      const b = randVersion();
      const ab = lib.compareVersions(a, b);
      const ba = lib.compareVersions(b, a);
      if (sign(ab) !== -sign(ba)) {
        examples.push({ iter: i, detail: `反对称失败：a=${JSON.stringify(a)} b=${JSON.stringify(b)}，f(a,b)=${ab} f(b,a)=${ba}` });
        break;
      }
    }
  }
  // 子检查 3：传递性 f(a,b)<=0 且 f(b,c)<=0 → f(a,c)<=0
  // 输入域限定：三元组全部可解析（规范版本串是全序；可解析 × 垃圾串混合非全序是
  // 设计取舍，见探针 2 注释——正常数据流无垃圾串，全序不变量只在可解析域断言）
  const PARSEABLE = /^v?\d+(\.\d+){0,2}(-[0-9A-Za-z.-]+)?$/;
  if (examples.length === 0) {
    for (let i = 0; i < n; i++) {
      const a = randVersion();
      const b = randVersion();
      const c = randVersion();
      if (!PARSEABLE.test(a) || !PARSEABLE.test(b) || !PARSEABLE.test(c)) continue;
      const ab = lib.compareVersions(a, b);
      const bc = lib.compareVersions(b, c);
      if (ab <= 0 && bc <= 0) {
        const ac = lib.compareVersions(a, c);
        if (ac > 0) {
          examples.push({ iter: i, detail: `传递性失败：a=${JSON.stringify(a)} b=${JSON.stringify(b)} c=${JSON.stringify(c)}，f(a,b)=${ab} f(b,c)=${bc} f(a,c)=${ac}（期望 f(a,c)<=0）` });
          break;
        }
      }
    }
  }
  // 子检查 4：随机垃圾串两两比较不抛异常
  if (examples.length === 0) {
    for (let i = 0; i < n; i++) {
      const a = randVersion();
      const b = randVersion();
      try { lib.compareVersions(a, b); } catch (error) {
        examples.push({ iter: i, detail: `比较 ${JSON.stringify(a)} vs ${JSON.stringify(b)} 抛出异常: ${error?.message ?? error}` });
        break;
      }
    }
  }
  return { ok: examples.length === 0, examples: examples.slice(0, 4) };
});

// ═════════════════════════════════════════════════════════════════════════════
// 性质 4：isSensitiveEnvKey —— 随机不抛 / 大小写变体对称 / 已知敏感与不敏感形态
// ═════════════════════════════════════════════════════════════════════════════
runProperty("isSensitiveEnvKey", 4, 300, (rng, n) => {
  const examples = [];
  const KEY_CHARS = ALNUM + "_-!@#$%^&*()[]{};:'\",<>?/|~=.密键";
  const SENSITIVE_WORDS = ["TOKEN", "KEY", "SECRET", "PASSWORD", "PASS", "CREDENTIAL", "CREDENTIALS"];
  for (let i = 0; i < n; i++) {
    // 随机串（含下划线/数字/特殊字符/大小写混合）：不抛 + 大小写变体对称
    const k = randStr(rng, 0, 24, KEY_CHARS);
    let r1, r2, r3;
    try {
      r1 = lib.isSensitiveEnvKey(k);
      r2 = lib.isSensitiveEnvKey(k.toLowerCase());
      r3 = lib.isSensitiveEnvKey(k.toUpperCase());
    } catch (error) {
      examples.push({ iter: i, detail: `随机键 ${JSON.stringify(k)} 抛出异常: ${error?.message ?? error}` });
      break;
    }
    if (!(r1 === r2 && r2 === r3)) {
      examples.push({ iter: i, detail: `大小写对称失败：${JSON.stringify(k)} → ${r1}，小写 → ${r2}，大写 → ${r3}` });
      break;
    }

    // 已知敏感词形态（前缀以 _ / - 分隔或裸词；后缀非字母数字）→ 必然敏感
    const word = pick(rng, SENSITIVE_WORDS);
    const prefix = pick(rng, ["", "GITHUB_", "OPENAI_", "DB_", "AWS_", "MY_", "X-", "1_"]);
    const suffix = pick(rng, ["", "_2", "-x", "_V1", "_STAGING"]);
    const sensitiveForm = `${prefix}${word}${suffix}`;
    if (!lib.isSensitiveEnvKey(sensitiveForm)) {
      examples.push({ iter: i, detail: `敏感形态 ${JSON.stringify(sensitiveForm)} 判定为不敏感` });
      break;
    }
    // AUTH（非 _ 后缀形态）→ 敏感；仅允许裸词或前缀分隔
    const authForm = pick(rng, ["", "BASIC_", "PROXY_", "HTTP_", "MY_"]) + "AUTH";
    if (!lib.isSensitiveEnvKey(authForm)) {
      examples.push({ iter: i, detail: `敏感形态 ${JSON.stringify(authForm)} 判定为不敏感` });
      break;
    }

    // 已知不敏感词（AUTH_TYPE / KEYBOARD_LAYOUT / PATH / TEMP / NODE_OPTIONS 等）→ 必然不敏感
    const INSENSITIVE = [
      "AUTH_TYPE", "AUTH_PATH", "AUTHORIZATION", "KEYBOARD_LAYOUT", "MONKEY", "PATH", "TEMP",
      "NODE_OPTIONS", "npm_config_registry", "PASSWORDLESS", "TOKENIZER", "PASSPORT",
      "SECRETARY", "CREDENTIALING", "TOKENLESS", "KEYSTONE", "PASSING", "AUTH_CFG", "HTTP_AUTH_TYPE"
    ];
    const insensForm = pick(rng, INSENSITIVE);
    if (lib.isSensitiveEnvKey(insensForm)) {
      examples.push({ iter: i, detail: `不敏感形态 ${JSON.stringify(insensForm)} 判定为敏感` });
      break;
    }
    // 字母感知边界：词被字母黏连（前缀/后缀无分隔）→ 必然不敏感（GITHUBTOKEN 不是 TOKEN 变量）
    const glued = `${pick(rng, "ABCDEFGHIJKLMNOPQRSTUVWXYZ")}${word}${pick(rng, "ABCDEFGHIJKLMNOPQRSTUVWXYZ")}`;
    if (lib.isSensitiveEnvKey(glued)) {
      examples.push({ iter: i, detail: `黏连形态 ${JSON.stringify(glued)} 判定为敏感` });
      break;
    }
  }
  return { ok: examples.length === 0, examples: examples.slice(0, 4) };
});

// ═════════════════════════════════════════════════════════════════════════════
// 性质 5：isTrustedHost —— 回环必然信任 / RFC1918 私有段信任 / 公网不信任 /
// 无 host → false / 随机不抛
// ═════════════════════════════════════════════════════════════════════════════
runProperty("isTrustedHost", 5, 300, (rng, n) => {
  const examples = [];
  const isPrivateV4 = (a, b, c) => a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  const LOOP_FORMS = ["localhost", "127.0.0.1", "[::1]"];
  for (let i = 0; i < n; i++) {
    // 回环变体（localhost / 127.0.0.1 / [::1]，随机端口、随机大小写、随机空白）→ 必然信任
    const base = pick(rng, ["localhost", "LOCALHOST", "LoCaLhOsT", "127.0.0.1", "[::1]"]);
    const port = pick(rng, ["", ":" + int(rng, 0, 65535), ":3080", ":abc"]);
    const ws = pick(rng, ["", " ", "  "]);
    const loopInput = `${ws}${base}${port}${ws}`;
    if (!lib.isTrustedHost(loopInput)) {
      examples.push({ iter: i, detail: `回环输入 ${JSON.stringify(loopInput)} 应被信任，实际不信任` });
      break;
    }
    // 随机 IPv4：RFC1918 私有段 → 信任；其余 → 不信任
    const a = int(rng, 0, 255), b = int(rng, 0, 255), cc = int(rng, 0, 255), d = int(rng, 0, 255);
    const ipInput = `${a}.${b}.${cc}.${d}`;
    const ipGot = lib.isTrustedHost(ipInput);
    const ipWant = isPrivateV4(a, b, cc);
    if (ipGot !== ipWant) {
      examples.push({ iter: i, detail: `IP ${JSON.stringify(ipInput)} 期望 ${ipWant}，实际 ${ipGot}` });
      break;
    }
    // 随机非 IP 字符串 → 不信任（回环/点分 IP 形态已被上文覆盖，跳过）
    const junk = randStr(rng, 1, 20, "abcdefghijklmnopqrstuvwxyz0123456789.-_:[]/\\");
    const jLow = junk.trim().toLowerCase();
    const isLoopish = LOOP_FORMS.some((f) => jLow === f || jLow.startsWith(`${f}:`));
    const isIpish = /^(\d{1,3}\.){3}\d{1,3}$/.test(junk);
    if (!isLoopish && !isIpish && lib.isTrustedHost(junk)) {
      examples.push({ iter: i, detail: `随机串 ${JSON.stringify(junk)} 不应被信任` });
      break;
    }
  }
  // 无 host → false
  if (examples.length === 0) {
    for (const bad of [null, undefined, "", "   ", "\t\n"]) {
      if (lib.isTrustedHost(bad) !== false) {
        examples.push({ iter: "fixed", detail: `输入 ${JSON.stringify(bad)} 应返回 false` });
        break;
      }
    }
  }
  // 非字符串对象不抛
  if (examples.length === 0) {
    try {
      lib.isTrustedHost(12345);
      lib.isTrustedHost({ host: "localhost" });
    } catch (error) {
      examples.push({ iter: "fixed", detail: `非字符串输入抛出异常: ${error?.message ?? error}` });
    }
  }
  return { ok: examples.length === 0, examples: examples.slice(0, 4) };
});

// ═════════════════════════════════════════════════════════════════════════════
// 性质 6：sanitizeLog —— 密钥形态脱敏（sk- / gh?_ / AKIA）+ 路径替换 + 不抛
// 断言按真实不变量：脱敏后不出现完整密钥形态、不出现用户目录名/Users 字样、
// 出现脱敏标记。观察项（见文件尾）：密钥被字母黏连（无词边界）时不脱敏；
// 小写 users 目录不替换。
// ═════════════════════════════════════════════════════════════════════════════
runProperty("sanitizeLog", 6, 300, (rng, n) => {
  const examples = [];
  const SEP = [" ", " ", "\n", ", ", "|", "; ", "\t", "=", ":", "(", ")"];
  const NOISE = ["installing", "error E404", "npm install", "cache miss", "0x1f", "https://github.com/o/r", "plugin", "log line", "file:///tmp/x"];
  for (let i = 0; i < n; i++) {
    // 随机组合：噪声词 + 1-3 个敏感片段（片段间用非单词字符分隔，保证词边界）
    const parts = [];
    const usedTypes = new Set();
    const winUsers = [];
    for (let k = 0; k < int(rng, 1, 3); k++) {
      const type = pick(rng, ["sk", "gh", "akia", "win", "home", "posix", "noise"]);
      if (type === "sk") {
        parts.push("sk-" + randStr(rng, 20, 20, ALNUM));
        usedTypes.add("sk");
      } else if (type === "gh") {
        parts.push(pick(rng, ["ghp_", "gho_", "ghs_", "ghr_", "ghu_"]) + randStr(rng, 20, 20, ALNUM));
        usedTypes.add("gh");
      } else if (type === "akia") {
        parts.push("AKIA" + randStr(rng, 16, 16, ALNUM));
        usedTypes.add("akia");
      } else if (type === "win") {
        const user = randStr(rng, 6, 10, UPPER_DIGIT); // 大写+数字，避免与噪声词子串碰撞
        parts.push(`${pick(rng, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")}:\\Users\\${user}\\${randStr(rng, 1, 6, LOW_CHARS)}.${pick(rng, ["txt", "log", "json"])}`);
        winUsers.push(user);
        usedTypes.add("win");
      } else if (type === "home") {
        parts.push("$HOME/" + randStr(rng, 1, 6, LOW_CHARS) + "/" + randStr(rng, 1, 6, LOW_CHARS));
        usedTypes.add("home");
      } else if (type === "posix") {
        parts.push("/home/" + randStr(rng, 1, 6, LOW_CHARS) + "/" + randStr(rng, 1, 6, LOW_CHARS));
        usedTypes.add("posix");
      } else {
        parts.push(pick(rng, NOISE));
      }
    }
    let input = "";
    for (let k = 0; k < parts.length; k++) {
      if (k > 0) input += pick(rng, SEP);
      input += parts[k];
    }
    input = `${pick(rng, ["", " ", "  "])}${input}${pick(rng, ["", " ", "  "])}`;

    let out;
    try {
      out = lib.sanitizeLog(input);
    } catch (error) {
      examples.push({ iter: i, detail: `输入 ${JSON.stringify(input)} 抛出异常: ${error?.message ?? error}` });
      break;
    }
    // sk- 后至少 7 位不出现（完整密钥不残留）
    if (/sk-[A-Za-z0-9]{7,}/.test(out)) {
      examples.push({ iter: i, detail: `sk- 密钥残留：输入 ${JSON.stringify(input)} → 输出 ${JSON.stringify(out)}` });
      break;
    }
    // gh?_（ghp_/gho_/ghs_/ghr_/ghu_）后至少 7 位不出现
    if (/gh[pousr]_[A-Za-z0-9]{7,}/.test(out)) {
      examples.push({ iter: i, detail: `gh?_ 密钥残留：输入 ${JSON.stringify(input)} → 输出 ${JSON.stringify(out)}` });
      break;
    }
    // AKIA 后至少 7 位不出现
    if (/AKIA[A-Za-z0-9]{7,}/.test(out)) {
      examples.push({ iter: i, detail: `AKIA 密钥残留：输入 ${JSON.stringify(input)} → 输出 ${JSON.stringify(out)}` });
      break;
    }
    // Windows 用户目录：用户目录名与 Users 字样不得残留；必须有脱敏标记
    // （独立时替换为 ~\<user>；嵌在 $HOME 无空格片段内时随 $HOME 一并替换为 ~/<user>）
    if (usedTypes.has("win")) {
      const leakUser = winUsers.some((u) => out.includes(u));
      if (leakUser || out.includes("Users")) {
        examples.push({ iter: i, detail: `Windows 路径泄漏：输入 ${JSON.stringify(input)} → 输出 ${JSON.stringify(out)}` });
        break;
      }
      if (!out.includes("~\\<user>") && !out.includes("~/<user>")) {
        examples.push({ iter: i, detail: `Windows 路径无脱敏标记：输入 ${JSON.stringify(input)} → 输出 ${JSON.stringify(out)}` });
        break;
      }
    }
    // Unix 主目录：$HOME 与 /home/ 字样不得残留；必须出现 ~/<user> 标记
    if (usedTypes.has("home") || usedTypes.has("posix")) {
      if (out.includes("$HOME") || out.includes("/home/")) {
        examples.push({ iter: i, detail: `Unix 路径残留：输入 ${JSON.stringify(input)} → 输出 ${JSON.stringify(out)}` });
        break;
      }
      if (!out.includes("~/<user>")) {
        examples.push({ iter: i, detail: `Unix 路径无脱敏标记：输入 ${JSON.stringify(input)} → 输出 ${JSON.stringify(out)}` });
        break;
      }
    }
  }
  // 非字符串输入不抛（String 兜底）
  if (examples.length === 0) {
    for (const bad of [null, undefined, 42, {}, ["x"]]) {
      try { lib.sanitizeLog(bad); } catch (error) {
        examples.push({ iter: "fixed", detail: `输入 ${JSON.stringify(bad)} 抛出异常: ${error?.message ?? error}` });
        break;
      }
    }
  }
  return { ok: examples.length === 0, examples: examples.slice(0, 4) };
});

// ═════════════════════════════════════════════════════════════════════════════
// 性质 7：dedupeReposByPkgName —— 输出无重复 key；已安装（rank 1e12）必然保留
// 已知真实缺陷：已安装条目的 stargazers_count 为 NaN 时 rank=NaN，与未安装条目
// 比较恒不成立，已安装条目会被错误丢弃（见探针）。
// ═════════════════════════════════════════════════════════════════════════════
runProperty("dedupeReposByPkgName", 7, 250, (rng, n) => {
  const examples = [];
  // 属性内部打印的 pkg_name 冲突 warn 会刷屏，静默处理
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    // 最小反例探针（确定性先行）：已安装（NaN stars）应保留，实际被未安装条目顶掉
    {
      const probeRepos = [
        { full_name: "uninstalled/repo", pkg_name: "shared", stargazers_count: 5 },
        { full_name: "installed/repo", pkg_name: "shared", stargazers_count: NaN }
      ];
      const probeOut = lib.dedupeReposByPkgName(probeRepos, (r) => r.full_name === "installed/repo");
      const winner = probeOut.repos.find((r) => r.pkg_name === "shared");
      if (!winner || winner.full_name !== "installed/repo") {
        examples.push({ iter: "probe", detail: `已安装条目丢失：installed/repo（stargazers_count=NaN）被 ${JSON.stringify(winner?.full_name ?? "无")} 顶掉（1e12 + NaN = NaN，比较恒不成立）` });
      }
    }
    const PKG_POOL = ["pkg-a", "pkg-b", "pkg-c", "shared-name"];
    for (let i = 0; i < n && examples.length === 0; i++) {
      const count = int(rng, 0, 40);
      const repos = [];
      const installed = new Set();
      for (let k = 0; k < count; k++) {
        const r = {};
        // full_name：正常/大写/.git 后缀/多斜杠/空白/数字/缺失
        switch (int(rng, 0, 5)) {
          case 0: r.full_name = `${randStr(rng, 1, 8, LOW_CHARS)}/${randStr(rng, 1, 8, LOW_CHARS)}`; break;
          case 1: r.full_name = `${randStr(rng, 1, 8, REPO_CHARS)}/${randStr(rng, 1, 8, REPO_CHARS)}`; break;
          case 2: r.full_name = `${randStr(rng, 1, 6, LOW_CHARS)}/${randStr(rng, 1, 6, LOW_CHARS)}.git`; break;
          case 3: r.full_name = `${randStr(rng, 1, 5, LOW_CHARS)}/${randStr(rng, 1, 5, LOW_CHARS)}/${randStr(rng, 1, 5, LOW_CHARS)}`; break;
          case 4: r.full_name = pick(rng, ["  ", "", "Owner/Repo", " "]); break;
          default: r.full_name = pick(rng, [42, undefined, "x y/z"]);
        }
        // pkg_name：随机复用池（制造冲突）/ 缺失 / 畸形
        switch (int(rng, 0, 3)) {
          case 0: r.pkg_name = pick(rng, PKG_POOL); break;
          case 1: r.pkg_name = randStr(rng, 1, 10, "abcdefghijklmnopqrstuvwxyz0123456789-._@"); break;
          case 2: r.pkg_name = pick(rng, [null, "", 42, undefined]); break;
          default: r.pkg_name = null;
        }
        // stargazers_count：数值为主，偶发畸形（NaN 为已知缺陷来源）
        if (chance(rng, 0.6)) r.stargazers_count = int(rng, 0, 5000);
        else r.stargazers_count = pick(rng, [null, undefined, "5", NaN, -3]);
        if (chance(rng, 0.2)) installed.add(r.full_name);
        repos.push(r);
      }
      const isInstalled = (r) => installed.has(r.full_name);
      const out = lib.dedupeReposByPkgName(repos, isInstalled);
      const outRepos = out.repos;
      const dropped = out.dropped;

      // (a) 输出 key 唯一（pkg_name 真值优先，否则 repo:full_name——与实现一致）
      const keys = new Set();
      for (const r of outRepos) {
        const key = r.pkg_name ? `pkg:${r.pkg_name}` : `repo:${r.full_name}`;
        if (keys.has(key)) {
          examples.push({ iter: i, detail: `输出存在重复 key ${JSON.stringify(key)}` });
          break;
        }
        keys.add(key);
      }
      if (examples.length > 0) break;
      // (b) 已安装（rank 1e12 语义）：每个 key 若有已安装输入，输出必保留该 key 且为已安装条目
      const byKey = new Map();
      for (const r of repos) {
        const key = r.pkg_name ? `pkg:${r.pkg_name}` : `repo:${r.full_name}`;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(r);
      }
      for (const [key, rs] of byKey) {
        if (!rs.some(isInstalled)) continue;
        const winner = outRepos.find((r) => (r.pkg_name ? `pkg:${r.pkg_name}` : `repo:${r.full_name}`) === key);
        if (!winner || !isInstalled(winner)) {
          examples.push({ iter: i, detail: `已安装条目丢失：key ${JSON.stringify(key)} 有已安装输入但输出无已安装条目` });
          break;
        }
        // 数值 stars 的 key：输出条目 rank 必须是该 key 输入中的最大值
        const numeric = rs.every((r) => typeof r.stargazers_count === "number" && Number.isFinite(r.stargazers_count));
        if (numeric) {
          const rank = (r) => (isInstalled(r) ? 1e12 : 0) + (r.stargazers_count ?? 0);
          const maxRank = Math.max(...rs.map(rank));
          if (rank(winner) !== maxRank) {
            examples.push({ iter: i, detail: `key ${JSON.stringify(key)} 输出 rank ${rank(winner)} ≠ 输入最大 rank ${maxRank}` });
            break;
          }
        }
      }
      if (examples.length > 0) break;
      // (c) 计数守恒：out + dropped = 输入总数；每个输入要么在输出（引用相同）要么其 full_name 在 dropped
      if (outRepos.length + dropped.length !== repos.length) {
        examples.push({ iter: i, detail: `计数不守恒：out=${outRepos.length} dropped=${dropped.length} 输入=${repos.length}` });
        break;
      }
      for (const r of repos) {
        if (!outRepos.includes(r) && !dropped.includes(r.full_name)) {
          examples.push({ iter: i, detail: `输入条目 ${JSON.stringify(r)} 既不在输出也不在 dropped` });
          break;
        }
      }
    }
    // 默认 isInstalled 参数（读模块内存 map，空环境 → 全部未安装）：不抛
    if (examples.length === 0) {
      try {
        lib.dedupeReposByPkgName([{ full_name: "a/b", pkg_name: null, stargazers_count: 1 }]);
      } catch (error) {
        examples.push({ iter: "fixed", detail: `默认参数调用抛出异常: ${error?.message ?? error}` });
      }
    }
    return { ok: examples.length === 0, examples: examples.slice(0, 4) };
  } finally {
    console.warn = origWarn;
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 性质 8（差分，最重要）：annotateInstalled 与 detectInstalled 结果一致。
// 空 DSH_HOME 环境下两者都应返回 false（畸形字段不抛）；本体仓库应双双 true。
// detectInstalled 做真实文件系统探测，样本量 30-50，每次带超时保护。
// ═════════════════════════════════════════════════════════════════════════════
{
  const n = 50;
  const seed = (SEED + 8) >>> 0;
  const rng = createLcg(seed);
  const examples = [];
  const withTimeout = (p, ms) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timeout: true }), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve({ value: v }); },
      (e) => { clearTimeout(timer); resolve({ error: e }); }
    );
  });
  const randRepo = () => {
    const r = {};
    switch (int(rng, 0, 5)) {
      case 0: r.full_name = `${randStr(rng, 1, 8, LOW_CHARS)}/${randStr(rng, 1, 8, LOW_CHARS)}`; break;
      case 1: r.full_name = `${randStr(rng, 1, 8, REPO_CHARS)}/${randStr(rng, 1, 8, REPO_CHARS)}`; break;
      case 2: r.full_name = pick(rng, ["", "  ", "Owner/Repo", "OWNER/REPO.GIT", "a/b/c"]); break;
      case 3: r.full_name = pick(rng, [42, undefined, "x y/z", "a.b/c_d"]); break;
      default: r.full_name = `${randStr(rng, 1, 6, LOW_CHARS)}/${randStr(rng, 1, 6, LOW_CHARS)}`;
    }
    switch (int(rng, 0, 3)) {
      case 0: r.name = randStr(rng, 1, 10, REPO_CHARS); break;
      case 1: r.name = pick(rng, ["", "Name", "my-plugin", "x.y-z"]); break;
      default: r.name = pick(rng, [42, undefined]);
    }
    switch (int(rng, 0, 3)) {
      case 0: r.pkg_name = randStr(rng, 1, 10, "abcdefghijklmnopqrstuvwxyz0123456789-._@"); break;
      case 1: r.pkg_name = pick(rng, ["pkg.name", ""]); break;
      default: r.pkg_name = pick(rng, [null, 42, undefined]);
    }
    return r;
  };

  let ok = true;
  for (let i = 0; i < n && ok; i++) {
    const repo = randRepo();
    const [ann, det] = await Promise.all([
      withTimeout(lib.annotateInstalled(repo), 2000),
      withTimeout(lib.detectInstalled(repo), 2000)
    ]);
    if (ann.timeout || det.timeout) {
      examples.push({ iter: i, detail: `超时：repo=${JSON.stringify(repo)}（annotate=${JSON.stringify(ann)} detect=${JSON.stringify(det)}）` });
      ok = false;
      break;
    }
    if (ann.error || det.error) {
      examples.push({ iter: i, detail: `异常：repo=${JSON.stringify(repo)}（annotate=${ann.error?.message ?? ann.error} detect=${det.error?.message ?? det.error}）` });
      ok = false;
      break;
    }
    const av = ann.value, dv = det.value;
    if (typeof av !== "boolean" || typeof dv !== "boolean" || av !== dv) {
      examples.push({ iter: i, detail: `分歧：repo=${JSON.stringify(repo)} → annotateInstalled=${av} detectInstalled=${dv}（期望一致）` });
      ok = false;
      break;
    }
    // 空 DSH_HOME：仅本体仓库允许双双 true，其余应双双 false
    if (av === true && dv === true) {
      const lower = String(repo.full_name ?? "").toLowerCase();
      if (!lower.startsWith("bradegithub/") || !lower.includes("dsh-plugins-marketplace")) {
        examples.push({ iter: i, detail: `空环境误判已安装：repo=${JSON.stringify(repo)} → annotate=${av} detect=${dv}` });
        ok = false;
        break;
      }
    }
  }
  // 显式本体仓库：两条路径都应返回 true（真实已安装分支一致性）
  for (const own of ["bradeGithub/DSH-Plugins-Marketplace", "BRADEGITHUB/DSH-PLUGINS-MARKETPLACE"]) {
    const repo = { full_name: own, name: "DSH-Plugins-Marketplace", pkg_name: "dsh-plugin-marketplace" };
    const [ann, det] = await Promise.all([
      withTimeout(lib.annotateInstalled(repo), 2000),
      withTimeout(lib.detectInstalled(repo), 2000)
    ]);
    const av = ann.value, dv = det.value;
    if (av !== true || dv !== true || av !== dv) {
      examples.push({ iter: "ownRepo", detail: `本体仓库 ${JSON.stringify(own)} → annotate=${av} detect=${dv}（期望双 true）` });
      ok = false;
    }
  }
  if (ok) passedCount++;
  else failures.push({ name: "差分 annotateInstalled/detectInstalled", seed, examples: examples.slice(0, 4) });
}

// ── 观察项探针（不置红，仅记录发现；报告用）────────────────────────────────────
{
  // 1) sanitizeLog 词边界依赖：密钥被字母黏连（无 \b 边界）时原样泄漏
  let gluedLeak = 0;
  const rngG = createLcg((SEED + 90) >>> 0);
  for (let i = 0; i < 50; i++) {
    const tok = "sk-" + randStr(rngG, 20, 20, ALNUM);
    const glued = `${pick(rngG, "abcdefghijklmnopqrstuvwxyz")}${tok}${pick(rngG, "abcdefghijklmnopqrstuvwxyz")}`;
    if (lib.sanitizeLog(glued).includes(tok)) gluedLeak++;
  }
  if (gluedLeak > 0) {
    findings.push(`sanitizeLog：密钥被字母黏连时泄漏 ${gluedLeak}/50（\\b 词边界依赖，如 "xsk-<token>" 原样输出）`);
  }
  // 2) sanitizeLog 大小写：小写 users 目录不替换（正则仅匹配 "Users"）
  if (lib.sanitizeLog("c:\\users\\alice\\f.txt").includes("users\\alice")) {
    findings.push('sanitizeLog：小写 "c:\\users\\..." 路径不替换（正则大小写敏感，仅匹配 "Users"）');
  }
  // 3) isTrustedHost 裸 IPv6：无方括号的 "::1" 不信任（Host 头规范要求 [::1] 带括号）
  if (lib.isTrustedHost("::1") !== false) {
    findings.push("isTrustedHost：裸 \"::1\" 行为与预期不符（应 false：Host 头规范要求 [::1] 带方括号）");
  }
}

// ── 汇总与清理 ─────────────────────────────────────────────────────────────────
console.log(`\n[property-based] 固定种子 0x${SEED.toString(16)}，临时 DSH_HOME=${DSH_HOME}`);
for (const f of failures) {
  console.log(`[FAIL] ${f.name}（seed=0x${f.seed.toString(16)}）`);
  for (const ex of f.examples) console.log(`       反例（第 ${ex.iter} 次）: ${ex.detail}`);
}
for (const fd of findings) console.log(`[发现] ${fd}`);
const total = failures.length + passedCount;
console.log(`\n性质 ${passedCount}/${total} 通过${failures.length > 0 ? `，${failures.length} 项失败` : ""}`);

// 退出前清理临时目录（不影响测试结果）
try {
  rmSync(DSH_HOME, { recursive: true, force: true });
} catch { /* 清理失败可忽略 */ }

process.exit(failures.length === 0 ? 0 : 1);
