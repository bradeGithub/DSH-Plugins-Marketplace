const VENDORED_DIR_NAMES = new Set([
  "upstream",
  "vendor",
  "vendored",
  "third_party",
  "third-party",
  "external",
  "deps",
]);

export function createRepositoryScanAdapter({
  fs: { readdir, readFile },
  path: { joinPath },
  looksLikeDshPlugin,
  vendoredDirNames = VENDORED_DIR_NAMES,
}) {
  async function entriesOf(dir) {
    try {
      return await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  }

  function shouldSkipDirectory(entry, skipVendored = false) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") return true;
    return skipVendored && vendoredDirNames.has(entry.name.toLowerCase());
  }

  async function findSkillRoots(cacheDir, maxDepth = 5, limit = 200) {
    const roots = [];
    const walk = async (dir, depth) => {
      if (roots.length >= limit) return;
      const entries = await entriesOf(dir);
      if (entries.some((entry) => entry.isFile() && entry.name.toLowerCase() === "skill.md")) {
        roots.push(dir);
        return;
      }
      if (depth >= maxDepth) return;
      for (const entry of entries) {
        if (shouldSkipDirectory(entry, true)) continue;
        await walk(joinPath(dir, entry.name), depth + 1);
        if (roots.length >= limit) return;
      }
    };
    await walk(cacheDir, 0);
    return roots;
  }

  async function readSkillManifest(skillRoot) {
    const entries = await readdir(skillRoot).catch(() => []);
    const manifest = entries.find((name) => name.toLowerCase() === "skill.md") ?? "SKILL.md";
    return readFile(joinPath(skillRoot, manifest), "utf8");
  }

  async function findPluginRoots(cacheDir, maxDepth = 3, limit = 50) {
    const roots = [];
    const walk = async (dir, depth) => {
      if (roots.length >= limit) return;
      const entries = await entriesOf(dir);
      if (entries.some((entry) => entry.isFile() && entry.name === "package.json")) {
        try {
          const pkg = JSON.parse(await readFile(joinPath(dir, "package.json"), "utf8"));
          if (looksLikeDshPlugin(pkg) === true) {
            roots.push(dir);
            return;
          }
        } catch {}
      }
      if (depth >= maxDepth) return;
      for (const entry of entries) {
        if (shouldSkipDirectory(entry)) continue;
        await walk(joinPath(dir, entry.name), depth + 1);
        if (roots.length >= limit) return;
      }
    };
    await walk(cacheDir, 0);
    return roots;
  }

  async function findPresetRoots(cacheDir, maxDepth = 3, limit = 50) {
    const roots = [];
    const walk = async (dir, depth) => {
      if (roots.length >= limit) return;
      const entries = await entriesOf(dir);
      if (entries.some((entry) => entry.isFile() && entry.name === "preset.yml")
          && entries.some((entry) => entry.isFile() && entry.name === "agent.cordis.yml")) {
        roots.push(dir);
        return;
      }
      if (depth >= maxDepth) return;
      for (const entry of entries) {
        if (shouldSkipDirectory(entry)) continue;
        await walk(joinPath(dir, entry.name), depth + 1);
        if (roots.length >= limit) return;
      }
    };
    await walk(cacheDir, 0);
    return roots;
  }

  async function readLifecycleScripts(cacheDir) {
    try {
      const pkg = JSON.parse(await readFile(joinPath(cacheDir, "package.json"), "utf8"));
      const scripts = pkg?.scripts ?? {};
      return ["preinstall", "install", "postinstall", "prepare"]
        .filter((name) => typeof scripts[name] === "string" && scripts[name].length > 0);
    } catch {
      return [];
    }
  }

  return {
    findSkillRoots,
    findPluginRoots,
    findPresetRoots,
    readSkillManifest,
    readLifecycleScripts,
  };
}
