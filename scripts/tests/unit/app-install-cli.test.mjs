import { createInstallCliFlow } from "../../../lib/app/install.js";

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

function makeFlow({ cliCommand = null, externalCliHint = null, cliInstall = null, installed = null, latest = null, dshError = null, npmDir = null }) {
  const calls = [];
  const logs = [];
  const flow = createInstallCliFlow({
    scanCliInstallHint: async () => cliCommand,
    scanExternalCliHint: async () => externalCliHint,
    findCliInstall: async () => cliInstall,
    buildFilteredEnv: () => ({ PATH: "safe" }),
    getInstalledRecord: () => installed,
    fetchNpmLatest: async (target) => {
      calls.push(["fetchNpmLatest", target]);
      return latest;
    },
    runDsh: async (...args) => {
      calls.push(["runDsh", ...args]);
      if (dshError) throw dshError;
    },
    installNpmTargetToTemp: async (target) => {
      calls.push(["installNpmTargetToTemp", target]);
      return npmDir;
    },
    isNpmCliTarget: (target) => !target.includes("/"),
    saveInstalled: async (...args) => calls.push(["saveInstalled", ...args]),
    queueFeedbackSafe: async (...args) => calls.push(["queueFeedbackSafe", ...args]),
    buildEnvProfile: async () => ({ platform: "test" }),
    buildFeedbackLogSnapshot: (log) => log.join("|"),
    cleanupCache: async (dir) => calls.push(["cleanupCache", dir]),
    translate: (_lang, key, params) => params?.cmd ? `${key}:${params.cmd}` : params?.target ? `${key}:${params.target}` : key,
    now: (() => { let value = 10; return () => value++; })()
  });
  return { flow, calls, logs };
}

{
  const { flow, calls, logs } = makeFlow({
    externalCliHint: { cli: "od", command: "od agent setup deepseek-harness" }
  });
  const result = await flow({
    repo: "owner/demo",
    cacheDir: "/cache/demo",
    installProfile: "web",
    log: [],
    logLine: (line) => logs.push(line),
    lang: "en"
  });
  check("无官方 CLI 返回 continue", result, {
    status: "continue",
    cacheDir: "/cache/demo",
    npmTargetUsed: null,
    cliCommand: null
  });
  check("第三方 CLI 提示日志", logs, ["externalCliHint:od agent setup deepseek-harness"]);
  check("无 CLI 不执行副作用", calls, []);
}

{
  const { flow, calls, logs } = makeFlow({
    cliCommand: "dsh plugin add demo-package",
    cliInstall: { command: "dsh plugin add demo-package", verb: "add", target: "demo-package" },
    installed: { type: "cli" },
    latest: "2.0.0"
  });
  const log = ["step"];
  const result = await flow({
    repo: "owner/demo",
    cacheDir: "/cache/demo",
    installProfile: "desktop",
    log,
    logLine: (line) => { logs.push(line); log.push(line); },
    lang: "en"
  });
  check("CLI 成功返回 done", result.status, "done");
  check("CLI 成功返回安装信息", result, {
    status: "done",
    repo: "owner/demo",
    installed: true,
    type: "cli",
    name: "demo-package",
    cliCommand: "dsh plugin add demo-package",
    latestVersion: null,
    log
  });
  check("CLI 更新目标使用 latest", calls[0], ["fetchNpmLatest", "demo-package"]);
  check("CLI 参数含 profile 和升级版本", calls[1], ["runDsh", ["plugin", "--profile", "desktop", "add", "demo-package@2.0.0"], { cwd: "/cache/demo", env: { PATH: "safe" }, timeout: 180000 }]);
  check("CLI 成功副作用顺序", calls.map(([name]) => name), ["fetchNpmLatest", "runDsh", "saveInstalled", "queueFeedbackSafe", "cleanupCache"]);
  check("CLI 成功日志", logs, ["cliHint:dsh plugin add demo-package", "cliExec:dsh plugin add demo-package", "cliUpdateTo:demo-package@2.0.0", "cliDone", "feedbackQueued"]);
}

{
  const { flow, calls, logs } = makeFlow({
    cliCommand: "dsh plugin install demo-package",
    cliInstall: { command: "dsh plugin install demo-package", verb: "install", target: "demo-package" },
    dshError: new Error("cli failed"),
    npmDir: "/tmp/npm-demo"
  });
  const result = await flow({
    repo: "owner/demo",
    cacheDir: "/cache/demo",
    installProfile: "web",
    log: [],
    logLine: (line) => logs.push(line),
    lang: "en"
  });
  check("CLI 失败 npm 回退返回 continue", result, {
    status: "continue",
    cacheDir: "/tmp/npm-demo",
    npmTargetUsed: "demo-package",
    cliCommand: "dsh plugin install demo-package"
  });
  check("CLI 失败 npm 回退调用顺序", calls.map(([name]) => name), ["runDsh", "installNpmTargetToTemp"]);
  check("CLI 失败 npm 回退日志", logs, ["cliHint:dsh plugin install demo-package", "cliExec:dsh plugin install demo-package", "cliFailFallback", "cliNpmFallback:demo-package"]);
}

{
  const { flow, calls, logs } = makeFlow({
    cliCommand: "dsh plugin install owner/demo",
    cliInstall: { command: "dsh plugin install owner/demo", verb: "install", target: "owner/demo" },
    dshError: new Error("cli failed")
  });
  const result = await flow({
    repo: "owner/demo",
    cacheDir: "/cache/demo",
    installProfile: "web",
    log: [],
    logLine: (line) => logs.push(line),
    lang: "en"
  });
  check("仓库 CLI 失败回到原缓存", result, {
    status: "continue",
    cacheDir: "/cache/demo",
    npmTargetUsed: null,
    cliCommand: "dsh plugin install owner/demo"
  });
  check("仓库目标不做 npm 回退", calls.map(([name]) => name), ["runDsh"]);
  check("CLI 失败保留回退日志", logs, ["cliHint:dsh plugin install owner/demo", "cliExec:dsh plugin install owner/demo", "cliFailFallback"]);
}

{
  const { flow, calls, logs } = makeFlow({
    cliCommand: "dsh plugin install demo-package",
    cliInstall: { command: "dsh plugin install demo-package", verb: "install", target: "demo-package" },
    dshError: new Error("cli failed")
  });
  const result = await flow({
    repo: "owner/demo",
    cacheDir: "/cache/demo",
    installProfile: "web",
    log: [],
    logLine: (line) => logs.push(line),
    lang: "en"
  });
  check("npm 回退失败保留原缓存", result, {
    status: "continue",
    cacheDir: "/cache/demo",
    npmTargetUsed: null,
    cliCommand: "dsh plugin install demo-package"
  });
  check("npm 回退失败仍完成尝试", calls.map(([name]) => name), ["runDsh", "installNpmTargetToTemp"]);
  check("npm 回退失败不记录成功日志", logs, ["cliHint:dsh plugin install demo-package", "cliExec:dsh plugin install demo-package", "cliFailFallback"]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
