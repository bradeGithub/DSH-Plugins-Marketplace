import { normalizeRepoRef } from "./normalize.js";

function installedKey(fullName) {
  return normalizeRepoRef(fullName) ?? String(fullName ?? "");
}

function firstSegmentUnder(location, root) {
  if (!root || !location.startsWith(root)) return null;
  const boundary = location[root.length];
  if (boundary !== "/" && boundary !== "\\") return null;
  return location.slice(root.length + 1).split(/[\\/]/)[0] || null;
}

function buildDirectoryOwners(installedEntries, managedRoots) {
  const owners = new Map();
  for (const [fullName, record] of installedEntries ?? []) {
    const location = String(record?.location ?? "");
    for (const rootValue of managedRoots ?? []) {
      const name = firstSegmentUnder(location, String(rootValue ?? ""));
      if (name) owners.set(name, installedKey(fullName));
    }
  }
  return owners;
}

export function buildInstalledIndex({
  profile,
  installedEntries,
  managedDirs,
  managedRoots,
  cacheEntries,
  official,
  ownRepo,
}) {
  const profileMap = profile instanceof Map ? profile : new Map(profile ?? []);
  const officialSet = official instanceof Set ? official : new Set(official ?? []);
  const repoIndex = new Map();
  for (const hit of profileMap.values()) {
    const repository = normalizeRepoRef(hit?.repository);
    if (!repository) continue;
    if (hit?.name && officialSet.has(String(hit.name).toLowerCase())) continue;
    repoIndex.set(repository, hit);
  }
  return {
    profile: profileMap,
    repoIndex,
    dirs: new Set(managedDirs ?? []),
    dirOwners: buildDirectoryOwners(installedEntries, managedRoots),
    cacheScripts: new Set(cacheEntries?.scripts ?? []),
    cachePkgNames: new Map(cacheEntries?.packageNames ?? []),
    ownRepo: ownRepo ?? null,
    official: officialSet,
  };
}

export function profileHit(index, repo, keys) {
  const target = normalizeRepoRef(repo?.full_name);
  for (const key of keys ?? []) {
    const hit = index.profile.get(String(key).toLowerCase());
    if (!hit) continue;
    if (hit.name && index.official.has(String(hit.name).toLowerCase())) continue;
    const repository = normalizeRepoRef(hit.repository);
    if (repository && target && repository !== target) continue;
    if (!repository) {
      const owner = index.dirOwners?.get(String(key).toLowerCase());
      if (owner && owner !== installedKey(repo?.full_name)) continue;
    }
    return hit;
  }
  if (target) {
    const hit = index.repoIndex.get(target);
    if (hit && (!hit.name || !index.official.has(String(hit.name).toLowerCase()))) return hit;
  }
  return null;
}

export { installedKey };
