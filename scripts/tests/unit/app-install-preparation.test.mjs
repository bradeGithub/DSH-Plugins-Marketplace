import { createInstallPreparation } from "../../../lib/app/install.js";
import { normalizeRepoRef } from "../../../lib/domain/normalize.js";

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

function makePreparation({ stat, exists = async () => false, readFile = async () => "", runGit = async () => {}, now = () => 1000 }) {
  const calls = [];
  const logs = [];
  const prepare = createInstallPreparation({
    cacheRoot: "/cache",
    mkdir: async (...args) => calls.push(["mkdir", ...args]),
    stat,
    rm: async (...args) => calls.push(["rm", ...args]),
    exists,
    readFile,
    runGit: async (...args) => {
      calls.push(["runGit", ...args]);
      return runGit(...args);
    },
    parseGitmodulesUrls: (text) => {
      calls.push(["parseGitmodulesUrls", text]);
      return text.includes("unsafe")
        ? { urls: ["file:///etc/passwd"], unsafe: ["file:///etc/passwd"] }
        : { urls: ["https://github.com/upstream/demo.git"], unsafe: [] };
    },
    joinPath: (base, child) => `${base}/${child}`,
    cacheReuseMs: 900,
    now,
    normalizeRepoRef,
    translate: (_lang, key, params) => `${key}${params?.urls ? `:${params.urls}` : ""}`
  });
  return { prepare, calls, logs };
}

{
  const { prepare, calls, logs } = makePreparation({
    stat: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    exists: async (path) => path === "/cache/owner__demo/.gitmodules",
    readFile: async () => '[submodule "upstream"]\nurl = https://github.com/upstream/demo.git\n',
    now: () => 1000
  });
  const result = await prepare({
    repo: "owner/demo",
    cacheDir: "/cache/owner__demo",
    logLine: (line) => logs.push(line),
    lang: "en"
  });
  check("新缓存返回 cloned", result, { cacheDir: "/cache/owner__demo", reused: false });
  check("新缓存准备调用顺序", calls.map(([name]) => name), ["mkdir", "rm", "runGit", "parseGitmodulesUrls", "runGit"]);
  check("新缓存 clone 参数", calls[2], ["runGit", ["clone", "--depth", "1", "https://github.com/owner/demo.git", "/cache/owner__demo"], { timeout: 180000 }]);
  check("新缓存 submodule 参数", calls[4], ["runGit", ["-c", "protocol.file.allow=never", "submodule", "update", "--init", "--recursive", "--depth", "1"], { cwd: "/cache/owner__demo", timeout: 180000 }]);
  check("新缓存日志", logs, ["step1", "cloneDone", "submoduleDone"]);
}

{
  const { prepare, calls, logs } = makePreparation({
    stat: async () => ({ isDirectory: () => true, mtimeMs: 500 }),
    // 新鲜目录存在 → 先探测 clone remote 归属；同源（owner/demo）才允许复用
    runGit: async () => ({ stdout: "https://github.com/owner/demo.git\n" }),
    now: () => 1000
  });
  const result = await prepare({
    repo: "owner/demo",
    cacheDir: "/cache/owner__demo",
    logLine: (line) => logs.push(line),
    lang: "en"
  });
  check("新鲜缓存返回 reused", result, { cacheDir: "/cache/owner__demo", reused: true });
  check("新鲜缓存不 clone（只做 remote 归属探测）", calls.map(([name]) => name), ["mkdir", "runGit"]);
  check("remote 归属探测参数（字面 URL，不走 insteadOf 重写）", calls[1], ["runGit", ["-C", "/cache/owner__demo", "config", "--get", "remote.origin.url"], { timeout: 10000 }]);
  check("新鲜缓存日志", logs, ["step1", "cacheReuse"]);
}

{
  const { prepare, calls, logs } = makePreparation({
    stat: async () => ({ isDirectory: () => true, mtimeMs: 0 }),
    // 过期目录 remote 同源 → 占用原目录重建（rm + clone）
    runGit: async () => ({ stdout: "https://github.com/owner/demo.git\n" }),
    now: () => 1000
  });
  const result = await prepare({
    repo: "owner/demo",
    cacheDir: "/cache/owner__demo",
    logLine: (line) => logs.push(line),
    lang: "en"
  });
  check("过期缓存返回 cloned", result.reused, false);
  check("过期缓存先探测归属再删除 clone", calls.map(([name]) => name), ["mkdir", "runGit", "rm", "runGit"]);
  check("过期缓存日志", logs, ["step1", "cloneDone"]);
}

{
  const { prepare, calls } = makePreparation({
    stat: async () => { throw new Error("missing"); },
    exists: async () => true,
    readFile: async () => '[submodule "unsafe"]\nurl = file:///etc/passwd\n'
  });
  let error;
  try {
    await prepare({ repo: "owner/demo", cacheDir: "/cache/owner__demo", logLine: () => {}, lang: "en" });
  } catch (caught) {
    error = caught;
  }
  check("不安全 submodule 拒绝", error?.message, "submoduleUnsafe:file:///etc/passwd");
  check("不安全 submodule 不执行更新", calls.map(([name]) => name), ["mkdir", "rm", "runGit", "parseGitmodulesUrls"]);
}

{
  const expected = new Error("clone failed");
  const { prepare } = makePreparation({
    stat: async () => { throw new Error("missing"); },
    runGit: async () => { throw expected; }
  });
  let error;
  try {
    await prepare({ repo: "owner/demo", cacheDir: "/cache/owner__demo", logLine: () => {}, lang: "en" });
  } catch (caught) {
    error = caught;
  }
  check("clone 失败原错误传播", error, expected);
}

{
  const { prepare, calls } = makePreparation({
    stat: async () => { throw new Error("missing"); },
    exists: async () => true,
    readFile: async () => { throw new Error("unreadable"); }
  });
  const result = await prepare({
    repo: "owner/demo",
    cacheDir: "/cache/owner__demo",
    logLine: () => {},
    lang: "en"
  });
  check("gitmodules 读取失败仍返回 cloned", result.reused, false);
  check("gitmodules 读取失败继续初始化", calls.map(([name]) => name), ["mkdir", "rm", "runGit", "parseGitmodulesUrls", "runGit"]);
}

// ---- slug 碰撞（slugify 有损：a/foo.bar 与 a/foo-bar 同键 a__foo-bar）----
{
  // 新鲜目录被他人（a/foo.bar）占用 → 不得复用也不得删除，顺延到 ~2 目录克隆
  const { prepare, calls, logs } = makePreparation({
    stat: async (path) => {
      if (path === "/cache/a__foo-bar") return { isDirectory: () => true, mtimeMs: 500 };
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    runGit: async (args) => args[0] === "-C" ? { stdout: "https://github.com/a/foo.bar.git\n" } : {},
    now: () => 1000
  });
  const result = await prepare({
    repo: "a/foo-bar",
    cacheDir: "/cache/a__foo-bar",
    logLine: (line) => logs.push(line),
    lang: "en"
  });
  check("slug 碰撞 → 占用带后缀目录", result, { cacheDir: "/cache/a__foo-bar~2", reused: false });
  check("slug 碰撞调用顺序（探测→占用~2克隆）", calls.map(([name]) => name), ["mkdir", "runGit", "rm", "runGit"]);
  check("slug 碰撞 clone 进带后缀目录", calls[3], ["runGit", ["clone", "--depth", "1", "https://github.com/a/foo-bar.git", "/cache/a__foo-bar~2"], { timeout: 180000 }]);
  check("slug 碰撞不误删他人目录", calls.some((c) => c[0] === "rm" && c[1] === "/cache/a__foo-bar"), false);
  check("slug 碰撞日志不复用", logs, ["step1", "cloneDone"]);
}

{
  // 他人的基础目录 + 本仓库的 ~2 目录都在 → 探测到 ~2 同源且新鲜 → 复用 ~2
  const { prepare, calls, logs } = makePreparation({
    stat: async (path) => {
      if (path === "/cache/a__foo-bar" || path === "/cache/a__foo-bar~2") return { isDirectory: () => true, mtimeMs: 500 };
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    runGit: async (args) => args[0] === "-C"
      ? { stdout: args[1] === "/cache/a__foo-bar" ? "https://github.com/a/foo.bar.git\n" : "https://github.com/a/foo-bar.git\n" }
      : {},
    now: () => 1000
  });
  const result = await prepare({
    repo: "a/foo-bar",
    cacheDir: "/cache/a__foo-bar",
    logLine: (line) => logs.push(line),
    lang: "en"
  });
  check("slug 碰撞复用本仓库后缀目录", result, { cacheDir: "/cache/a__foo-bar~2", reused: true });
  check("碰撞复用只探测不 clone", calls.map(([name]) => name), ["mkdir", "runGit", "runGit"]);
  check("碰撞复用日志", logs, ["step1", "cacheReuse"]);
}

{
  // 顺延目录上 clone 失败 → 错误必须带实际占用目录（installCacheDir），
  // 调用方据此清理 ~2 而不是误删他人占用的基础目录
  const expected = new Error("clone failed");
  const { prepare } = makePreparation({
    stat: async (path) => {
      if (path === "/cache/a__foo-bar") return { isDirectory: () => true, mtimeMs: 500 };
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    runGit: async (args) => {
      if (args[0] === "-C") return { stdout: "https://github.com/a/foo.bar.git\n" };
      throw expected;
    },
    now: () => 1000
  });
  let error;
  try {
    await prepare({ repo: "a/foo-bar", cacheDir: "/cache/a__foo-bar", logLine: () => {}, lang: "en" });
  } catch (caught) {
    error = caught;
  }
  check("顺延目录 clone 失败原错误传播", error, expected);
  check("顺延目录 clone 失败标注 installCacheDir", error?.installCacheDir, "/cache/a__foo-bar~2");
}

{
  // remote 无法识别（非 git 目录/git 不可用）的新鲜目录：宁可顺延也不得误删
  const { prepare, calls } = makePreparation({
    stat: async (path) => {
      if (path === "/cache/owner__demo") return { isDirectory: () => true, mtimeMs: 500 };
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    runGit: async (args) => {
      if (args[0] === "-C") throw new Error("not a git repo"); // 仅 remote 探测失败
      return {};
    },
    now: () => 1000
  });
  const result = await prepare({
    repo: "owner/demo",
    cacheDir: "/cache/owner__demo",
    logLine: () => {},
    lang: "en"
  });
  check("来源不明目录不复用（顺延 ~2）", result, { cacheDir: "/cache/owner__demo~2", reused: false });
  check("来源不明目录不误删", calls.some((c) => c[0] === "rm" && c[1] === "/cache/owner__demo"), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
