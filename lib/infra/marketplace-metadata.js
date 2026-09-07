export function createMarketplaceMetadataAdapter({
  fs: { readFile, readdir },
  path: { dirnamePath, joinPath },
  resolveCorePackage,
  ownPackagePath,
  officialFallback,
}) {
  let officialPackagesCache = null;
  let ownRepo = null;

  async function loadOfficialPackages() {
    if (officialPackagesCache) return officialPackagesCache;
    const set = new Set([...officialFallback].map((name) => name.toLowerCase()));
    try {
      const cordisPath = resolveCorePackage("@deepseek-ai/cordis");
      const scopeDir = joinPath(dirnamePath(cordisPath), "..");
      const entries = await readdir(scopeDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) set.add(`@deepseek-ai/${entry.name}`.toLowerCase());
      }
    } catch {}
    officialPackagesCache = set;
    return set;
  }

  async function isOfficialPackage(pkgName) {
    return (await loadOfficialPackages()).has(String(pkgName ?? "").toLowerCase());
  }

  async function loadOwnRepo() {
    if (ownRepo !== null) return ownRepo;
    try {
      const pkg = JSON.parse(await readFile(ownPackagePath, "utf8"));
      const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
      ownRepo = typeof url === "string"
        ? url.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").toLowerCase() || null
        : null;
    } catch {
      ownRepo = null;
    }
    return ownRepo;
  }

  return { loadOfficialPackages, isOfficialPackage, loadOwnRepo };
}
