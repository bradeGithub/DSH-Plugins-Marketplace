import { createInstallPreparation } from "../../../lib/app/install.js";

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
    now: () => 1000
  });
  const result = await prepare({
    repo: "owner/demo",
    cacheDir: "/cache/owner__demo",
    logLine: (line) => logs.push(line),
    lang: "en"
  });
  check("新鲜缓存返回 reused", result, { cacheDir: "/cache/owner__demo", reused: true });
  check("新鲜缓存不 clone", calls.map(([name]) => name), ["mkdir"]);
  check("新鲜缓存日志", logs, ["step1", "cacheReuse"]);
}

{
  const { prepare, calls, logs } = makePreparation({
    stat: async () => ({ isDirectory: () => true, mtimeMs: 0 }),
    now: () => 1000
  });
  const result = await prepare({
    repo: "owner/demo",
    cacheDir: "/cache/owner__demo",
    logLine: (line) => logs.push(line),
    lang: "en"
  });
  check("过期缓存返回 cloned", result.reused, false);
  check("过期缓存先删除再 clone", calls.map(([name]) => name), ["mkdir", "rm", "runGit"]);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
