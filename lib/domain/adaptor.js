export function createAdaptorRules({ redirects, normalizeRepo }) {
  const entries = Array.isArray(redirects)
    ? redirects.filter((entry) => entry && typeof entry.from === "string" && typeof entry.to === "string")
    : [];
  // GitHub 仓库名大小写不敏感，但 registry/adaptor.json 的 from 与列表 full_name 可能漂移
  // （如 adaptor.json 写 yejiming/MuseAI，索引或用户输入给 yejiming/museai）——建图与查询
  // 统一小写归一，漂移时重定向仍命中，避免用户装到未重定向的本体。
  const keyOf = (value) => String(value ?? "").toLowerCase();
  const fromMap = new Map();
  for (const entry of entries) fromMap.set(keyOf(entry.from), entry);

  function adaptorRedirectRepo(fullName) {
    const entry = fromMap.get(keyOf(fullName));
    return entry ? entry.to : null;
  }

  function applyAdaptorList(repos) {
    if (entries.length === 0 || !Array.isArray(repos)) return repos;
    const out = repos.filter((repo) => !fromMap.has(keyOf(repo?.full_name)));
    for (const entry of entries) {
      if (entry.meta && typeof entry.meta.full_name === "string" && !out.some((repo) => keyOf(repo?.full_name) === keyOf(entry.meta.full_name))) {
        out.push(normalizeRepo(entry.meta));
      }
    }
    return out;
  }

  return { adaptorRedirectRepo, applyAdaptorList };
}
