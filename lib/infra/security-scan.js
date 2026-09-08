const ADVISORIES_URL = "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk";

export function createSecurityScanAdapter({
  fs: { readFile, readdir, stat },
  path: { joinPath, relativePath },
  findSecrets,
  fetchImpl,
  readBodyLimited,
  timeoutSignal,
  domain: {
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
  },
  limits: {
    secretMaxFiles = 200,
    secretMaxFileBytes = 512 * 1024,
    cveMaxQueries = 100,
  } = {},
}) {
  async function scanRequirements(cacheDir) {
    const names = new Set();
    const files = [];
    const walk = async (dir, depth) => {
      if (depth > 2 || files.length >= 40) return;
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = joinPath(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (entry.name.startsWith(".") || ["node_modules", "dist", "build"].includes(entry.name)) continue;
          await walk(full, depth + 1);
        } else if (/(readme|install|\.env|package\.json|\.ya?ml$|\.md$)/i.test(entry.name)) {
          files.push(full);
        }
      }
    };
    await walk(cacheDir, 0);
    for (const file of files.slice(0, 40)) {
      try {
        for (const name of extractEnvNames(await readFile(file, "utf8"))) names.add(name);
      } catch {}
    }
    return [...names].slice(0, 8);
  }

  async function scanHostShadowDeps(dir) {
    try {
      return findHostShadowDeps(JSON.parse(await readFile(joinPath(dir, "package.json"), "utf8")));
    } catch {
      return [];
    }
  }

  async function scanLifecycleHazards(cacheDir) {
    let pkg;
    try {
      pkg = JSON.parse(await readFile(joinPath(cacheDir, "package.json"), "utf8"));
    } catch {
      return [];
    }
    const localScripts = new Map();
    for (const target of lifecycleScriptTargets(pkg)) {
      try {
        localScripts.set(target, await readFile(joinPath(cacheDir, target), "utf8"));
      } catch {}
    }
    return classifyLifecycleHazards(pkg, localScripts);
  }

  async function scanScriptHazards(filePath) {
    try {
      return classifyScriptHazards(await readFile(filePath, "utf8"), filePath);
    } catch {
      return [];
    }
  }

  async function scanCacheSecrets(cacheDir) {
    const hits = [];
    let scanned = 0;
    const walk = async (dir) => {
      if (scanned >= secretMaxFiles || hits.length >= 8) return;
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (scanned >= secretMaxFiles || hits.length >= 8) return;
        const full = joinPath(dir, entry.name);
        if (entry.isDirectory()) {
          if (!isSecretScanSkipDir(entry.name)) await walk(full);
          continue;
        }
        if (!entry.isFile() || !isSecretScanFile(entry.name)) continue;
        scanned++;
        let content;
        try {
          const details = await stat(full);
          if (details.size > secretMaxFileBytes) continue;
          content = await readFile(full, "utf8");
        } catch { continue; }
        for (const hit of findSecrets(content, { maxHits: 8 - hits.length })) {
          hits.push({ ...hit, file: relativePath(cacheDir, full).replaceAll("\\", "/") });
        }
      }
    };
    await walk(cacheDir);
    return hits;
  }

  async function readLockfileVersions(cacheDir) {
    let text;
    try {
      text = await readFile(joinPath(cacheDir, "pnpm-lock.yaml"), "utf8");
    } catch {
      try { text = await readFile(joinPath(cacheDir, "package-lock.json"), "utf8"); } catch { return new Map(); }
    }
    return parseLockfileVersions(text);
  }

  async function fetchBulkAdvisories(deps) {
    if (deps.length === 0) return {};
    try {
      const body = JSON.stringify(Object.fromEntries(deps.map((dep) => [dep.name, [dep.version]])));
      const response = await fetchImpl(ADVISORIES_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "dsh-plugin-marketplace" },
        body,
        signal: timeoutSignal(),
      });
      if (!response.ok) return {};
      const data = JSON.parse((await readBodyLimited(response)).toString("utf8"));
      return data && typeof data === "object" ? data : {};
    } catch {
      return {};
    }
  }

  async function scanCacheVulnerabilities(cacheDir) {
    let pkg;
    try {
      pkg = JSON.parse(await readFile(joinPath(cacheDir, "package.json"), "utf8"));
    } catch {
      return [];
    }
    const lockVersions = await readLockfileVersions(cacheDir);
    for (const section of ["dependencies", "optionalDependencies"]) {
      const deps = pkg?.[section];
      if (!deps || typeof deps !== "object") continue;
      for (const [name, range] of Object.entries(deps)) {
        if (typeof range !== "string" || !range.startsWith("file:")) continue;
        try {
          const subPkg = JSON.parse(await readFile(joinPath(cacheDir, range.slice(5), "package.json"), "utf8"));
          if (typeof subPkg.version === "string") lockVersions.set(name, subPkg.version);
        } catch {}
      }
    }
    const deps = readVulnScanDeps(pkg, lockVersions).slice(0, cveMaxQueries);
    return filterVulnerabilityHits(deps, await fetchBulkAdvisories(deps));
  }

  return {
    scanRequirements,
    scanHostShadowDeps,
    scanLifecycleHazards,
    scanScriptHazards,
    scanCacheSecrets,
    readLockfileVersions,
    fetchBulkAdvisories,
    scanCacheVulnerabilities,
  };
}
