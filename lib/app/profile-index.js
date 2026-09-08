import { buildInstalledIndex as buildInstalledIndexDomain, profileHit as profileHitDomain } from "../domain/installed-index.js";

// Runtime owner for profile scanning and the derived InstalledIndex.
// The owner contains lifecycle state only; filesystem scanning and index rules
// remain in the injected adapter/domain functions.
export function createProfileIndexRuntime({
  profileName,
  profileScanAdapter,
  installedSnapshot,
  hasInstalledRecord,
  installedKey,
  loadOfficialPackages,
  loadOwnRepo,
  detectType,
  readPackageName,
  pathExists,
  joinPath,
  slugify,
  skillsDir,
  presetsDir,
  cacheDir,
  managedRoots,
  onProfileChange,
  onInstalledChange,
  maxStableAttempts = 4,
}) {
  let profileScanCache = null;
  let profileScanGeneration = 0;
  let installedIndex = null;
  let installedIndexBuild = null;
  let installedIndexGen = 0;

  async function matchProfileEntry(profile, repo, keys) {
    const target = installedKey(repo?.full_name);
    const official = await loadOfficialPackages();
    for (const key of keys ?? []) {
      const hit = profile.get(String(key).toLowerCase());
      if (!hit) continue;
      if (hit.name && official.has(String(hit.name).toLowerCase())) continue;
      if (hit.repository && target && hit.repository !== target) continue;
      if (!hit.repository) {
        const owner = installedIndex?.dirOwners?.get(String(key).toLowerCase());
        if (owner && owner !== installedKey(repo?.full_name)) continue;
      }
      return hit;
    }
    if (target) {
      for (const hit of profile.values()) {
        if (!hit.repository || hit.repository !== target) continue;
        if (hit.name && official.has(String(hit.name).toLowerCase())) continue;
        return hit;
      }
    }
    return null;
  }

  async function scanProfilePackages() {
    if (profileScanCache) return profileScanCache;
    const scanGeneration = profileScanGeneration;
    const scanProfile = profileName();
    const map = await profileScanAdapter.scanProfilePackages(scanProfile);
    if (scanGeneration !== profileScanGeneration || scanProfile !== profileName()) return scanProfilePackages();
    profileScanCache = map;
    return map;
  }

  function invalidate() {
    profileScanGeneration++;
    profileScanCache = null;
    installedIndex = null;
    installedIndexGen++;
  }

  onProfileChange?.(invalidate);
  onInstalledChange?.(invalidate);

  async function withStableProfileState(build) {
    for (let attempt = 0; attempt < maxStableAttempts; attempt++) {
      const activeProfile = profileName();
      const scanGeneration = profileScanGeneration;
      const indexGeneration = installedIndexGen;
      const result = await build();
      if (
        activeProfile === profileName()
        && scanGeneration === profileScanGeneration
        && indexGeneration === installedIndexGen
      ) return result;
    }
    throw new Error("profile state changed repeatedly during list");
  }

  async function buildInstalledIndex() {
    const profile = await scanProfilePackages();
    const official = await loadOfficialPackages();
    const managedDirs = await profileScanAdapter.scanManagedDirs();
    const cacheEntries = await profileScanAdapter.scanCacheEntries();
    return buildInstalledIndexDomain({
      profile,
      installedEntries: installedSnapshot(),
      managedDirs,
      managedRoots,
      cacheEntries,
      official,
      ownRepo: await loadOwnRepo(),
    });
  }

  async function ensureInstalledIndex() {
    if (installedIndex) return installedIndex;
    if (!installedIndexBuild) {
      const buildGen = installedIndexGen;
      installedIndexBuild = buildInstalledIndex()
        .then((idx) => {
          if (installedIndexGen !== buildGen) return null;
          installedIndex = idx;
          return idx;
        })
        .catch((error) => {
          installedIndex = null;
          throw error;
        })
        .finally(() => {
          installedIndexBuild = null;
        });
    }
    return await installedIndexBuild;
  }

  function profileHit(index, repo, keys) {
    return profileHitDomain(index, repo, keys);
  }

  async function annotateInstalled(repo) {
    try {
      await ensureInstalledIndex();
    } catch {
      return detectInstalled(repo);
    }
    try {
      const idx = installedIndex;
      if (!idx) return detectInstalled(repo);
      const slug = slugify(repo.name);
      if (hasInstalledRecord(repo.full_name)) return true;
      if (idx.dirs.has(slug)) {
        const owner = idx.dirOwners.get(slug);
        if (!owner || owner === installedKey(repo.full_name)) return true;
      }
      if (idx.ownRepo && String(repo.full_name).toLowerCase() === idx.ownRepo) return true;
      const keys = [slug, repo.name];
      if (repo.pkg_name) keys.push(repo.pkg_name);
      if (profileHit(idx, repo, keys)) return true;
      const cacheKey = `${slugify(String(repo.full_name).split("/")[0] ?? "")}__${slug}`;
      if (idx.cacheScripts.has(cacheKey)) return true;
      const pkgName = idx.cachePkgNames.get(cacheKey);
      if (pkgName && profileHit(idx, repo, [pkgName])) return true;
      return false;
    } catch {
      return detectInstalled(repo);
    }
  }

  async function annotateSkillInstalled(repo) {
    try {
      await ensureInstalledIndex();
    } catch {
      return detectSkillInstalled(repo);
    }
    try {
      if (!installedIndex) return detectSkillInstalled(repo);
      return hasInstalledRecord(repo.full_name) || Boolean(installedIndex?.dirs.has(slugify(repo.name)));
    } catch {
      return detectSkillInstalled(repo);
    }
  }

  async function detectInstalled(repo) {
    if (hasInstalledRecord(repo.full_name)) return true;
    const slug = slugify(repo.name);
    const owner = slugify(String(repo.full_name).split("/")[0] ?? "");
    const cachePath = joinPath(cacheDir, `${owner}__${slug}`);
    const idx = installedIndex;
    let candidates = [joinPath(skillsDir, slug), joinPath(presetsDir, slug)];
    if (idx?.dirOwners?.get(slug) && idx.dirOwners.get(slug) !== installedKey(repo.full_name)) candidates = [];
    for (const candidate of candidates) {
      if (await pathExists(candidate)) return true;
    }
    const self = await loadOwnRepo();
    if (self && String(repo.full_name).toLowerCase() === self) return true;
    const profile = await scanProfilePackages();
    const keys = [slug, repo.name];
    if (repo.pkg_name) keys.push(repo.pkg_name);
    if (await matchProfileEntry(profile, repo, keys)) return true;
    if (await pathExists(cachePath)) {
      const cacheType = await detectType(cachePath);
      if (cacheType === "script") return true;
    }
    const pkgName = await readPackageName(cachePath);
    if (pkgName && await matchProfileEntry(profile, repo, [pkgName])) return true;
    return false;
  }

  async function detectSkillInstalled(repo) {
    if (hasInstalledRecord(repo.full_name)) return true;
    return await pathExists(joinPath(skillsDir, slugify(repo.name)));
  }

  return {
    scanProfilePackages,
    matchProfileEntry,
    invalidate,
    withStableProfileState,
    ensureInstalledIndex,
    buildInstalledIndex,
    profileHit,
    annotateInstalled,
    annotateSkillInstalled,
    detectInstalled,
    detectSkillInstalled,
  };
}
