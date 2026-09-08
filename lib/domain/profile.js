import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const PROFILE_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const listeners = new Set();

let targetProfile = "web";

function profileName() {
  return targetProfile;
}

function profileDir(name = targetProfile) {
  const safe = PROFILE_NAME_RE.test(String(name ?? "")) ? String(name) : "web";
  return join(DSH_HOME, "profiles", safe);
}

function profileNodeModules(name = targetProfile) {
  return join(profileDir(name), "node_modules");
}

function profilePatchFile(name = targetProfile) {
  return join(profileDir(name), "cordis.patch.yml");
}

function profilePackageFile(name = targetProfile) {
  return join(profileDir(name), "package.json");
}

function onProfileChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function readTargetProfile() {
  let name = null;
  try {
    const cfg = JSON.parse(await readFile(join(DSH_HOME, "marketplace", "config.json"), "utf8"));
    if (typeof cfg?.targetProfile === "string" && PROFILE_NAME_RE.test(cfg.targetProfile)) {
      name = cfg.targetProfile;
    }
  } catch { /* 缺失/损坏：无有效配置 */ }
  if (name !== null) {
    try {
      const st = await stat(profileDir(name));
      if (!st.isDirectory()) name = null;
    } catch { name = null; }
  }
  return { profile: name ?? "web", fromConfig: name !== null };
}

function setTargetProfile(name) {
  const safe = PROFILE_NAME_RE.test(String(name ?? "")) ? String(name) : "web";
  if (safe !== targetProfile) targetProfile = safe;
  for (const listener of listeners) listener(safe);
  return safe;
}

function getProfileNodeModules() {
  return profileNodeModules();
}

function resolveRecordNodeModules(record) {
  const location = String(record?.location ?? "");
  if (location) {
    const locResolved = resolve(location);
    if (locResolved !== resolve(profileNodeModules())
        && locResolved.startsWith(join(DSH_HOME, "profiles") + sep)) {
      const nmRoot = location.split(`${sep}node_modules${sep}`)[0];
      if (nmRoot && PROFILE_NAME_RE.test(nmRoot.split(sep).at(-1) ?? "")) {
        return join(nmRoot, "node_modules");
      }
    }
  }
  const hinted = record && typeof record.profile === "string" ? record.profile : "";
  if (hinted && PROFILE_NAME_RE.test(hinted)) {
    return profileNodeModules(hinted);
  }
  return profileNodeModules();
}

export {
  PROFILE_NAME_RE,
  profileName,
  profileDir,
  profileNodeModules,
  profilePatchFile,
  profilePackageFile,
  onProfileChange,
  readTargetProfile,
  setTargetProfile,
  getProfileNodeModules,
  resolveRecordNodeModules
};
