import { createInstallUseCase } from "../../../lib/app/install.js";

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

{
  const calls = [];
  const saved = [];
  const feedback = [];
  let clock = 100;
  const runInstall = createInstallUseCase({
    installRepo: async (input) => {
      calls.push(["installRepo", input]);
      return { type: "cordis-plugin", name: "demo", location: "/profile/node_modules/demo", version: "1.2.3", bundle: false };
    },
    saveInstalled: async (repo, record) => {
      calls.push(["saveInstalled", repo]);
      saved.push(record);
    },
    queueFeedbackSafe: async (entry) => {
      calls.push(["queueFeedbackSafe", entry.repo]);
      feedback.push(entry);
    },
    getInstalledRecord: () => ({ type: "cordis-plugin" }),
    buildEnvProfile: async () => ({ platform: "test" }),
    buildFeedbackLogSnapshot: (log) => log.join("|"),
    readPackageVersion: async (dir) => {
      calls.push(["readPackageVersion", dir]);
      return "1.2.3";
    },
    classifyInstallFailure: () => null,
    cleanupCache: async (dir) => calls.push(["cleanupCache", dir]),
    translate: (_lang, key) => key === "feedbackQueued" ? "queued" : key === "step5" ? "installing" : "install failed",
    now: () => clock++
  });
  const log = ["step"];
  const result = await runInstall({
    type: "cordis-plugin",
    cacheDir: "/cache/demo",
    repo: "owner/demo",
    answers: { API_KEY: "x" },
    log,
    logLine: (line) => log.push(line),
    lang: "en",
    envAllowList: ["API_KEY"],
    npmTarget: null,
    profilePaths: { nodeModules: "/profile/node_modules" },
    npmTargetUsed: null
  });
  check("install 成功返回 done", result.status, "done");
  check("install 成功标记 installed", result.installed, true);
  check("install 成功保留版本", result.latestVersion, "1.2.3");
  check("install 成功保存记录", saved[0], {
    type: "cordis-plugin",
    name: "demo",
    names: null,
    location: "/profile/node_modules/demo",
    version: "1.2.3",
    bundle: false,
    installedAt: 100,
    envKeys: ["API_KEY"]
  });
  check("install 成功反馈快照", feedback[0], {
    repo: "owner/demo",
    name: "demo",
    type: "cordis-plugin",
    version: "1.2.3",
    installedAt: 101,
    method: "market-direct",
    reinstall: true,
    envProfile: { platform: "test" },
    logSnapshot: "step|installing"
  });
  check("install 成功调用顺序", calls.map(([name]) => name), ["installRepo", "saveInstalled", "queueFeedbackSafe", "readPackageVersion"]);
  check("install 成功追加反馈日志", log.at(-1), "queued");
}

{
  const calls = [];
  const runInstall = createInstallUseCase({
    installRepo: async () => ({ type: "instructions" }),
    saveInstalled: async () => calls.push("saveInstalled"),
    queueFeedbackSafe: async () => calls.push("queueFeedbackSafe"),
    getInstalledRecord: () => null,
    buildEnvProfile: async () => ({}),
    buildFeedbackLogSnapshot: () => "",
    readPackageVersion: async () => "",
    classifyInstallFailure: () => null,
    cleanupCache: async (dir) => calls.push(["cleanupCache", dir]),
    translate: () => ""
  });
  const result = await runInstall({
    type: "instructions",
    cacheDir: "/cache/manual",
    repo: "owner/manual",
    answers: {},
    log: [],
    logLine: () => {},
    lang: "en"
  });
  check("instructions 返回 manual", result, {
    status: "manual",
    repo: "owner/manual",
    type: "instructions",
    url: "https://github.com/owner/manual",
    log: []
  });
  check("instructions 清理缓存", calls, [["cleanupCache", "/cache/manual"]]);
}

{
  const log = [];
  const calls = [];
  const runInstall = createInstallUseCase({
    installRepo: async () => { throw Object.assign(new Error("network failed"), { stderr: "fatal: unable to access" }); },
    saveInstalled: async () => calls.push("saveInstalled"),
    queueFeedbackSafe: async () => calls.push("queueFeedbackSafe"),
    getInstalledRecord: () => null,
    buildEnvProfile: async () => ({}),
    buildFeedbackLogSnapshot: () => "",
    readPackageVersion: async () => "",
    classifyInstallFailure: () => "network hint",
    cleanupCache: async (dir) => calls.push(["cleanupCache", dir]),
    translate: (_lang, key) => key === "step5" ? "installing" : "failure"
  });
  const result = await runInstall({
    type: "skill",
    cacheDir: "/cache/fail",
    repo: "owner/fail",
    answers: {},
    log,
    logLine: (line) => log.push(line),
    lang: "en"
  });
  check("install 失败返回 failed", result.status, "failed");
  check("install 失败保留错误提示", result.error, "network failed\n\nnetwork hint");
  check("install 失败清理缓存", calls, [["cleanupCache", "/cache/fail"]]);
  check("install 失败写入原错误与分类", log, ["installing", "failure", "network hint"]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
