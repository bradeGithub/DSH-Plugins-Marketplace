import { createInstallPreflight } from "../../../lib/app/install.js";

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

function makePreflight(overrides = {}) {
  const calls = [];
  const logs = [];
  const options = {
    detectTypeDetail: async () => ({ type: "cordis-plugin", reasonKey: "reason.plugin", hintKey: "hint.plugin" }),
    findPluginRoots: async () => [],
    scanRequirements: async () => [],
    scanCacheSecrets: async () => [],
    scanCacheVulnerabilities: async () => [],
    scanScriptHazards: async () => [],
    scanLifecycleHazards: async () => [],
    readLifecycleScripts: async () => [],
    scanHostShadowDeps: async () => [],
    needsPluginBuild: async () => false,
    readPackageJsonObject: async () => ({ dsh: {} }),
    looksLikeDshPlugin: () => true,
    exists: async () => false,
    readFile: async () => "# README",
    joinPath: (...parts) => parts.join("/"),
    cleanupCache: async (dir) => calls.push(["cleanupCache", dir]),
    redactLog: (text) => `redacted:${text}`,
    translate: (_lang, key, params) => {
      if (key.startsWith("type.")) return key.slice(5);
      if (params?.type !== undefined) return `${key}:${params.type}`;
      if (params?.secrets !== undefined) return `${key}:${params.secrets}`;
      if (params?.vulns !== undefined) return `${key}:${params.vulns}`;
      if (params?.list !== undefined) return `${key}:${params.list}`;
      if (params?.repo !== undefined) return `${key}:${params.repo}`;
      if (params?.n !== undefined) return `${key}:${params.n}`;
      if (params?.scripts !== undefined) return `${key}:${params.scripts}`;
      if (params?.names !== undefined) return `${key}:${params.names}`;
      if (params?.hazards !== undefined) return `${key}:${params.hazards}`;
      if (params?.readme !== undefined) return `${key}:${params.readme}`;
      return key;
    },
    ...overrides
  };
  return {
    flow: createInstallPreflight(options),
    calls,
    logs,
    run: (input = {}) => options
      ? createInstallPreflight(options)({
          cacheDir: "/cache/demo",
          repo: "owner/demo",
          answers: {},
          log: [],
          logLine: (line) => logs.push(line),
          lang: "en",
          ...input
        })
      : null
  };
}

{
  const { run, logs } = makePreflight();
  const result = await run({ answers: { API_KEY: "secret" } });
  check("前置继续返回类型", result, {
    status: "continue",
    repo: "owner/demo",
    type: "cordis-plugin",
    scannedVars: [],
    cliCommand: null
  });
  check("类型判定日志顺序", logs, ["step2:cordis-plugin", "typeReason", "step3:none"]);
}

{
  const { run } = makePreflight({
    scanRequirements: async () => ["API_KEY", "TOKEN"]
  });
  const result = await run({ answers: { API_KEY: "secret", TOKEN: "t" } });
  check("继续时透传完整扫描白名单", result.scannedVars, ["API_KEY", "TOKEN"]);
}

{
  const { run, logs } = makePreflight({
    scanRequirements: async () => ["API_KEY", "TOKEN"]
  });
  const result = await run();
  check("环境缺失返回 awaiting-input", result.status, "awaiting-input");
  check("环境问题键完整", result.questions.map((q) => q.id), ["API_KEY", "TOKEN"]);
  check("环境缺失不进入后续扫描", logs, ["step2:cordis-plugin", "typeReason", "step3:API_KEY, TOKEN", "awaiting"]);
}

{
  const { run, calls, logs } = makePreflight({
    scanCacheSecrets: async () => [{ file: "config.js", line: 3, kind: "token", text: "sk-secret" }]
  });
  const result = await run();
  check("secrets 命中返回确认", result.status, "awaiting-input");
  check("secrets 问题 id", result.questions[0].id, "__confirm_secrets__");
  check("secrets 文案脱敏", result.questions[0].question.includes("redacted:sk-secret"), true);
  const cancelled = await run({ answers: { __confirm_secrets__: "cancel" } });
  check("secrets 取消返回 aborted", cancelled.status, "aborted");
  check("secrets 取消清理缓存", calls, [["cleanupCache", "/cache/demo"]]);
  check("secrets 取消日志", logs.at(-1), "secretsCancelled");
}

{
  const { run } = makePreflight({
    scanCacheVulnerabilities: async () => [{ name: "bad", version: "1.0.0", severity: "high", title: "bad vuln", url: "https://example.test/advisory" }]
  });
  const result = await run();
  check("CVE 命中返回确认", result.status, "awaiting-input");
  check("CVE 问题 id", result.questions[0].id, "__confirm_vulns__");
  check("CVE 文案含包名", result.questions[0].question.includes("bad@1.0.0"), true);
}

{
  const { run, calls } = makePreflight({
    detectTypeDetail: async () => ({ type: "script", reasonKey: "reason.script", hintKey: "hint.script" }),
    exists: async (path) => path.endsWith("install.sh"),
    scanScriptHazards: async () => [{ category: "downloadExec", line: 1, text: "curl ... | sh" }]
  });
  const result = await run();
  check("脚本命中返回确认", result.status, "awaiting-input");
  check("脚本问题 id", result.questions[0].id, "__confirm_script__");
  const cancelled = await run({ answers: { __confirm_script__: "cancel" } });
  check("脚本拒绝返回 aborted", cancelled.status, "aborted");
  check("脚本拒绝不清理缓存（保留确认重试上下文）", calls, []);
}

{
  const { run } = makePreflight({
    scanRequirements: async () => [],
    readLifecycleScripts: async () => ["postinstall"],
    scanLifecycleHazards: async () => [{ script: "postinstall", category: "dynamicExec", text: "eval(x)" }]
  });
  const result = await run();
  check("npm 生命周期返回确认", result.status, "awaiting-input");
  check("npm 生命周期问题 id", result.questions[0].id, "__confirm_npm_scripts__");
}

{
  const { run } = makePreflight({
    scanHostShadowDeps: async () => ["@deepseek-ai/dsh-tools"]
  });
  const result = await run();
  check("宿主依赖遮蔽返回确认", result.status, "awaiting-input");
  check("宿主依赖问题 id", result.questions[0].id, "__confirm_host_deps__");
}

{
  const { run } = makePreflight({
    readPackageJsonObject: async () => ({ name: "ordinary" }),
    looksLikeDshPlugin: () => false
  });
  const result = await run();
  check("非插件返回确认", result.status, "awaiting-input");
  check("非插件问题 id", result.questions[0].id, "__confirm_non_plugin__");
}

{
  const { run } = makePreflight({
    needsPluginBuild: async () => true
  });
  const result = await run();
  check("构建需求返回确认", result.status, "awaiting-input");
  check("构建问题 id", result.questions[0].id, "__confirm_build__");
}

{
  const { run } = makePreflight({
    detectTypeDetail: async () => ({ type: "instructions", reasonKey: "reason.none", hintKey: "hint.none" }),
    readFile: async () => "manual README"
  });
  const result = await run();
  check("手动类型返回确认", result.status, "awaiting-input");
  check("手动问题 id", result.questions[0].id, "__confirm_manual__");
  const cancelled = await run({ answers: { __confirm_manual__: "cancel" } });
  check("手动取消返回 aborted", cancelled.status, "aborted");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
