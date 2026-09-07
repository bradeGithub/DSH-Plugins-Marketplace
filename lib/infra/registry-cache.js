// Runtime registry sources and list-cache file adapter.

export function createRegistryCacheAdapter({
  fetchImpl,
  fetchJson,
  readBodyLimited,
  responseTooLarge,
  gunzip,
  timeoutSignal,
  fs: { readFile, mkdir, writeFile, rename },
  clock: { now },
  limits: {
    maxResponseBytes,
    registryMaxAgeMs,
    pageSize,
    maxPages,
  },
  paths: { cacheFile, cacheDir, bundledFile },
  normalizeRepo,
  excludedRepoNames,
  registrySources,
  searchQueries,
  getGithubToken,
}) {
  async function fetchRegistryRepos(kind = "dsh") {
    for (const source of registrySources(kind)) {
      try {
        const headers = { "User-Agent": "dsh-plugin-marketplace" };
        if (source.acceptRaw) headers["Accept"] = "application/vnd.github.raw";
        const token = getGithubToken();
        if (source.acceptRaw && token) headers["Authorization"] = `Bearer ${token}`;
        const res = await fetchImpl(source.url, { headers, signal: timeoutSignal() });
        if (!res.ok) continue;
        if (responseTooLarge(res)) continue;
        let text;
        if (source.url.endsWith(".gz")) {
          text = gunzip(await readBodyLimited(res), { maxOutputLength: maxResponseBytes }).toString("utf8");
        } else {
          text = (await readBodyLimited(res)).toString("utf8");
        }
        const data = JSON.parse(text);
        if (!data || !Array.isArray(data.repos)) continue;
        if (source.checkFresh) {
          const age = now() - Date.parse(data.generated_at ?? "");
          if (Number.isNaN(age) || age > registryMaxAgeMs) continue;
        }
        const seen = new Set();
        const collected = [];
        for (const item of data.repos) {
          if (!item || typeof item.full_name !== "string") continue;
          if (seen.has(item.full_name)) continue;
          seen.add(item.full_name);
          if (excludedRepoNames.has(item.name)) continue;
          collected.push(normalizeRepo(item, kind));
        }
        if (collected.length > 0) return collected;
      } catch {
        // Try the next source.
      }
    }
    return null;
  }

  async function fetchSearchRepos(kind = "dsh") {
    const token = getGithubToken();
    const collected = [];
    const seen = new Set();
    for (const query of searchQueries[kind] ?? searchQueries.dsh) {
      for (let page = 1; page <= maxPages; page++) {
        let data;
        try {
          const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=${pageSize}&page=${page}`;
          data = await fetchJson(url, token ? { Authorization: `Bearer ${token}` } : {});
        } catch (error) {
          console.warn(`[dsh-plugin-marketplace] 搜索 API 失败（${query} 第 ${page} 页）：${error?.message ?? error}，使用已收集的部分数据`);
          break;
        }
        const items = data.items ?? [];
        for (const item of items) {
          if (seen.has(item.full_name)) continue;
          seen.add(item.full_name);
          if (excludedRepoNames.has(item.name)) continue;
          collected.push(item);
        }
        if (items.length < pageSize) break;
      }
    }
    return collected.map((item) => normalizeRepo(item));
  }

  async function readListCache(kind) {
    try {
      const data = JSON.parse(await readFile(cacheFile(kind), "utf8"));
      if (data && typeof data === "object" && Array.isArray(data.repos) && data.repos.length > 0) {
        const age = now() - Date.parse(data.generated_at ?? "");
        if (Number.isNaN(age) || age > registryMaxAgeMs) return null;
        const valid = [];
        for (const item of data.repos) {
          if (item && typeof item === "object" && typeof item.full_name === "string" && item.full_name.length > 0) {
            valid.push(item);
          }
        }
        if (valid.length > 0) return valid;
      }
    } catch {
      // Missing or malformed cache falls through to the next source.
    }
    return null;
  }

  async function writeListCache(kind, repos) {
    try {
      await mkdir(cacheDir, { recursive: true });
      const generatedAt = new Date(now()).toISOString();
      const path = cacheFile(kind);
      const tmp = path + ".tmp";
      await writeFile(tmp, JSON.stringify({
        saved_at: generatedAt,
        generated_at: generatedAt,
        kind,
        count: repos.length,
        repos,
      }, null, 2), "utf8");
      await rename(tmp, path);
    } catch {
      // Cache persistence must not block list responses.
    }
  }

  async function readBundledIndex(kind) {
    try {
      const data = JSON.parse(await readFile(bundledFile(kind), "utf8"));
      if (!data || !Array.isArray(data.repos)) return null;
      const seen = new Set();
      const collected = [];
      for (const item of data.repos) {
        if (!item || typeof item.full_name !== "string") continue;
        if (seen.has(item.full_name)) continue;
        seen.add(item.full_name);
        if (excludedRepoNames.has(item.name)) continue;
        collected.push(normalizeRepo(item, kind));
      }
      return collected.length > 0 ? collected : null;
    } catch {
      // The package may be installed without its bundled index.
    }
    return null;
  }

  async function load(kind = "dsh", force = false) {
    if (force || kind !== "skills") {
      const fromRegistry = await fetchRegistryRepos(kind);
      if (fromRegistry) {
        void writeListCache(kind, fromRegistry);
        fromRegistry.sort((a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0));
        return { repos: fromRegistry, source: "registry" };
      }
    }
    const fromBundled = await readBundledIndex(kind);
    if (fromBundled) {
      void writeListCache(kind, fromBundled);
      fromBundled.sort((a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0));
      return { repos: fromBundled, source: "bundled" };
    }
    const fromDisk = await readListCache(kind);
    if (fromDisk) {
      fromDisk.sort((a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0));
      return { repos: fromDisk, source: "cache" };
    }
    const fromSearch = await fetchSearchRepos(kind);
    fromSearch.sort((a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0));
    return { repos: fromSearch, source: "search" };
  }

  return {
    fetchRegistryRepos,
    fetchSearchRepos,
    readListCache,
    writeListCache,
    readBundledIndex,
    load,
  };
}
