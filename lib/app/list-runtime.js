// Runtime owner for in-memory marketplace list caching.
// Registry/cache IO is injected; HTTP filtering and response shaping stay outside.
export function createListRuntime({
  loadRegistryRepos,
  now = () => Date.now(),
  ttlMs = 10 * 60 * 1000,
  warn = () => {},
}) {
  const listSources = { dsh: "registry", skills: "registry" };
  const listCaches = {
    dsh: { at: 0, repos: null },
    skills: { at: 0, repos: null },
  };
  const listFetchings = { dsh: null, skills: null };

  function cacheFor(kind) {
    return listCaches[kind] ?? (listCaches[kind] = { at: 0, repos: null });
  }

  async function fetchAllRepos(kind = "dsh", force = false) {
    const result = await loadRegistryRepos(kind, force);
    const repos = Array.isArray(result?.repos) ? result.repos : [];
    listSources[kind] = result?.source ?? "registry";
    if (listSources[kind] === "cache") {
      warn(`[dsh-plugin-marketplace] 索引网络源与内置索引均不可用，使用本地磁盘缓存（${kind}，${repos.length} 条）`);
    }
    return repos;
  }

  async function getList(kind = "dsh", force = false) {
    const cache = cacheFor(kind);
    if (!force && cache.repos !== null && now() - cache.at <= ttlMs) return cache.repos;
    if (listFetchings[kind] == null) {
      listFetchings[kind] = fetchAllRepos(kind, force)
        .then((repos) => {
          listCaches[kind] = { at: now(), repos, source: listSources[kind] ?? "registry" };
          return repos;
        })
        .finally(() => {
          listFetchings[kind] = null;
        });
    }
    return await listFetchings[kind];
  }

  function getCacheState(kind = "dsh") {
    const cache = cacheFor(kind);
    return {
      at: cache.at,
      repos: Array.isArray(cache.repos)
        ? cache.repos.map((repo) => {
            const copy = { ...repo };
            if (Array.isArray(repo?.topics)) copy.topics = [...repo.topics];
            return copy;
          })
        : cache.repos,
      source: cache.source ?? listSources[kind] ?? "registry",
    };
  }

  return { fetchAllRepos, getList, getCacheState };
}
