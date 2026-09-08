export function createAdaptorRules({ redirects, normalizeRepo }) {
  const entries = Array.isArray(redirects)
    ? redirects.filter((entry) => entry && typeof entry.from === "string" && typeof entry.to === "string")
    : [];
  const fromMap = new Map();
  for (const entry of entries) fromMap.set(entry.from, entry);

  function adaptorRedirectRepo(fullName) {
    const entry = fromMap.get(String(fullName ?? ""));
    return entry ? entry.to : null;
  }

  function applyAdaptorList(repos) {
    if (entries.length === 0 || !Array.isArray(repos)) return repos;
    const out = repos.filter((repo) => !fromMap.has(repo.full_name));
    for (const entry of entries) {
      if (entry.meta && typeof entry.meta.full_name === "string" && !out.some((repo) => repo.full_name === entry.meta.full_name)) {
        out.push(normalizeRepo(entry.meta));
      }
    }
    return out;
  }

  return { adaptorRedirectRepo, applyAdaptorList };
}
