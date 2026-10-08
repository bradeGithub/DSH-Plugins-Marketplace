import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const PROFILE_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const listeners = new Set();

/**
 * 启动器提供的「当前 profile」。
 *
 * `DSH_PROFILE_DIR` 是绝对目录，优先于名字：桌面端（Electron）的 profile 由应用独占，
 * 可能不在共享的 `$DSH_HOME/profiles` 树内，只有目录才能定位它；`DSH_PROFILE` 只给名字时
 * 按共享树推导。两者都不存在（例如老环境手工启动）时返回 null，由调用方回退。
 * @param env 环境变量表（默认 process.env；测试可注入）。
 * @param dshHome DSH home（默认按 DSH_HOME 解析）。
 * @returns {{ name: string, dir: string } | null}
 */
function detectCurrentProfile(env = process.env, dshHome = DSH_HOME) {
  const dirEnv = String(env?.DSH_PROFILE_DIR ?? "").trim();
  if (dirEnv.length > 0) {
    const dir = resolve(dirEnv);
    const name = basename(dir);
    // basename 必须是合法 profile 名，且不能是 profiles 根本身
    if (PROFILE_NAME_RE.test(name) && name !== "profiles") return { name, dir };
  }
  const nameEnv = String(env?.DSH_PROFILE ?? "").trim();
  if (nameEnv.length > 0 && PROFILE_NAME_RE.test(nameEnv)) {
    return { name: nameEnv, dir: join(dshHome, "profiles", nameEnv) };
  }
  return null;
}

let currentProfileState = detectCurrentProfile();
// 默认目标 = 当前运行中的 profile：桌面端跑的就是 desktop，老环境回退 web。
// 之前硬编码 "web" 会在桌面端把插件装进一个不存在的 profile（桌面 profile 是 desktop）。
let targetProfile = currentProfileState === null ? "web" : currentProfileState.name;

function profileName() {
  return targetProfile;
}

/** 当前运行中的 profile（启动器提供）；无法识别时为 null。 */
function currentProfile() {
  return currentProfileState;
}

/** 给定名字是否就是当前运行中的 profile——内置插件管理器只能操作它自己的 profile。 */
function isCurrentProfile(name) {
  if (currentProfileState === null) return false;
  return String(name ?? "") === currentProfileState.name;
}

/** 重新读取启动器环境（测试 / 长生命周期进程用）。 */
function refreshCurrentProfile(env = process.env, dshHome = DSH_HOME) {
  currentProfileState = detectCurrentProfile(env, dshHome);
  return currentProfileState;
}

function profileDir(name = targetProfile) {
  const safe = PROFILE_NAME_RE.test(String(name ?? "")) ? String(name) : "web";
  if (currentProfileState !== null && currentProfileState.name === safe) return currentProfileState.dir;
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

/**
 * 解析目标 profile：显式配置（config.json，且目录真实存在）> 启动器提供的当前 profile > "web"。
 *
 * 「当前 profile」这一层是桌面端适配的关键：桌面端启动器把 profile 目录交给 DSH
 * （DSH_PROFILE_DIR=~/.dsh/profiles/desktop），没有配置时市场必须跟随它，
 * 否则会去操作一个并不存在的 web profile。
 * @returns {{ profile: string, fromConfig: boolean, source: "config" | "current" | "default" }}
 */
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
  if (name !== null) return { profile: name, fromConfig: true, source: "config" };
  if (currentProfileState !== null) {
    return { profile: currentProfileState.name, fromConfig: false, source: "current" };
  }
  return { profile: "web", fromConfig: false, source: "default" };
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
    // 允许的锚点：共享 profiles 树，以及启动器提供的当前 profile 目录本身
    // （桌面端等应用自有 profile 可以位于共享树之外，只有它自己的目录能定位）。
    const anchors = [join(DSH_HOME, "profiles") + sep];
    if (currentProfileState !== null) anchors.push(resolve(currentProfileState.dir) + sep);
    if (locResolved !== resolve(profileNodeModules())
        && anchors.some((anchor) => locResolved.startsWith(anchor))) {
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
  resolveRecordNodeModules,
  detectCurrentProfile,
  currentProfile,
  isCurrentProfile,
  refreshCurrentProfile
};
