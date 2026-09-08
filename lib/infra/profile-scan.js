export function createProfileScanAdapter({
  fs: { readdir },
  paths: { profileNodeModules, skillsDir, presetsDir, cacheDir },
  readPackageSummary,
  detectCacheType,
  readPackageName,
}) {
  const pathOf = (value, arg) => typeof value === "function" ? value(arg) : value;

  async function entriesOf(path) {
    try {
      return await readdir(path, { withFileTypes: true });
    } catch {
      return [];
    }
  }

  async function scanProfilePackages(profile = "web") {
    const map = new Map();
    const add = (key, name, version, repository) => {
      if (!key) return;
      const existing = map.get(key);
      if (!existing || (existing.version == null && version != null)) {
        map.set(key, {
          name: name ?? null,
          version: version ?? null,
          repository: repository ?? null,
        });
      }
    };
    const scanDir = async (dir, readPackage, keyPrefix = "") => {
      const entries = await entriesOf(dir);
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const key = keyPrefix + entry.name.toLowerCase();
        add(key, null, null);
        if (!readPackage) continue;
        let summary = null;
        try {
          summary = await readPackageSummary(joinPath(dir, entry.name));
        } catch {
          summary = null;
        }
        if (summary) {
          add(
            String(summary.name ?? "").toLowerCase(),
            summary.name,
            summary.version,
            summary.repository,
          );
        }
        if (entry.name.startsWith("@")) {
          await scanDir(joinPath(dir, entry.name), true, key + "/");
        }
      }
    };
    await scanDir(pathOf(profileNodeModules, profile), true);
    await scanDir(pathOf(skillsDir), false);
    await scanDir(pathOf(presetsDir), false);
    return map;
  }

  async function scanManagedDirs() {
    const dirs = new Set();
    for (const root of [pathOf(skillsDir), pathOf(presetsDir)]) {
      for (const entry of await entriesOf(root)) {
        if (entry.isDirectory()) dirs.add(entry.name);
      }
    }
    return dirs;
  }

  async function scanCacheEntries() {
    const scripts = new Set();
    const packageNames = new Map();
    for (const entry of await entriesOf(pathOf(cacheDir))) {
      if (!entry.isDirectory()) continue;
      const path = joinPath(pathOf(cacheDir), entry.name);
      try {
        if (await detectCacheType(path) === "script") scripts.add(entry.name);
      } catch {
        // A broken cache entry must not hide the remaining entries.
      }
      try {
        const packageName = await readPackageName(path);
        if (packageName) packageNames.set(entry.name, packageName);
      } catch {
        // A broken package manifest has no package-name projection.
      }
    }
    return { scripts, packageNames };
  }

  return { scanProfilePackages, scanManagedDirs, scanCacheEntries };
}

function joinPath(base, child) {
  return `${String(base).replace(/[\\/]$/, "")}/${child}`;
}
