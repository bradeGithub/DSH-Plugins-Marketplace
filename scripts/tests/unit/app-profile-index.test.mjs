import assert from "node:assert/strict";
import { createProfileIndexRuntime } from "../../../lib/app/profile-index.js";

const calls = [];
let profile = "web";
let profileListener = null;
let installedListener = null;
let scanRelease;
let scanStarted;
let scanMap = new Map();
let installed = new Map();
let indexBuilds = 0;
let failBuild = false;

const adapter = {
  async scanProfilePackages(name) {
    calls.push(["scan", name]);
    if (scanStarted) scanStarted();
    if (scanRelease) await scanRelease;
    return scanMap;
  },
  async scanManagedDirs() { calls.push(["managed"]); return new Set(["skill-dir"]); },
  async scanCacheEntries() { calls.push(["cache"]); return { scripts: new Set(["owner__script"]), packageNames: new Map([["owner__pkg", "pkg-name"]]) }; },
};

const runtime = createProfileIndexRuntime({
  profileName: () => profile,
  profileScanAdapter: adapter,
  installedSnapshot: () => new Map(installed),
  hasInstalledRecord: (repo) => installed.has(String(repo).toLowerCase()),
  installedKey: (value) => String(value ?? "").toLowerCase(),
  loadOfficialPackages: async () => new Set(["official"]),
  loadOwnRepo: async () => "owner/self",
  detectType: async () => "script",
  readPackageName: async () => null,
  pathExists: async (path) => path.endsWith("/skill-dir") || path.endsWith("/owner__script"),
  joinPath: (a, b) => `${a}/${b}`,
  slugify: (value) => String(value).replace(/[.]/g, "-").toLowerCase(),
  skillsDir: "/skills",
  presetsDir: "/presets",
  cacheDir: "/cache",
  managedRoots: ["/skills", "/presets"],
  onProfileChange: (listener) => { profileListener = listener; return () => {}; },
  onInstalledChange: (listener) => { installedListener = listener; return () => {}; },
});

function indexOf(overrides = {}) {
  return {
    profile: new Map([["pkg", { name: "pkg", version: "1.0.0", repository: "owner/pkg" }]]),
    repoIndex: new Map([["owner/reverse", { name: "reverse", version: "2.0.0", repository: "owner/reverse" }]]),
    dirs: new Set(["skill-dir"]),
    dirOwners: new Map(),
    cacheScripts: new Set(),
    cachePkgNames: new Map(),
    ownRepo: null,
    official: new Set(),
    ...overrides,
  };
}

scanMap = new Map([["pkg", { name: "pkg", version: "1.0.0", repository: "owner/pkg" }]]);
const first = await runtime.scanProfilePackages();
assert.equal(first, scanMap);
assert.equal(await runtime.scanProfilePackages(), first);

const hit = await runtime.matchProfileEntry(scanMap, { full_name: "owner/pkg" }, ["pkg"]);
assert.equal(hit.name, "pkg");
assert.equal(await runtime.matchProfileEntry(scanMap, { full_name: "other/pkg" }, ["pkg"]), null);
assert.equal(await runtime.matchProfileEntry(new Map([["official", { name: "official", repository: "owner/official" }]]), { full_name: "owner/official" }, ["official"]), null);
assert.equal((await runtime.matchProfileEntry(new Map([["x", { name: "x", repository: "owner/reverse" }]]), { full_name: "owner/reverse" }, ["none"])).repository, "owner/reverse");
assert.equal(await runtime.matchProfileEntry(new Map([["x", { name: "x", repository: "owner/reverse" }]]), { full_name: "other/reverse" }, ["none"]), null);

const built = await runtime.ensureInstalledIndex();
assert.equal(built.dirs.has("skill-dir"), true);
assert.equal(calls.filter(([name]) => name === "scan").length, 1);

installed.set("owner/recorded", { type: "skill" });
assert.equal(await runtime.annotateInstalled({ full_name: "owner/recorded", name: "recorded" }), true);
assert.equal(await runtime.annotateInstalled({ full_name: "owner/skill-dir", name: "skill-dir" }), true);
assert.equal(await runtime.annotateInstalled({ full_name: "owner/self", name: "self" }), true);
assert.equal(await runtime.annotateInstalled({ full_name: "owner/pkg", name: "pkg" }), true);
assert.equal(await runtime.annotateInstalled({ full_name: "owner/script", name: "script" }), true);
assert.equal(await runtime.annotateSkillInstalled({ full_name: "owner/skill-dir", name: "skill-dir" }), true);

assert.equal(await runtime.detectInstalled({ full_name: "owner/skill-dir", name: "skill-dir" }), true);
assert.equal(await runtime.detectInstalled({ full_name: "owner/script", name: "script" }), true);
assert.equal(await runtime.detectSkillInstalled({ full_name: "owner/skill-dir", name: "skill-dir" }), true);
assert.equal(await runtime.detectSkillInstalled({ full_name: "owner/none", name: "none" }), false);

profileListener();
assert.equal(await runtime.scanProfilePackages(), scanMap);
installedListener();
assert.deepEqual(await runtime.ensureInstalledIndex(), built);

let gateResolve;
const scanStartedPromise = new Promise((resolve) => { scanStarted = resolve; });
scanRelease = new Promise((resolve) => { gateResolve = resolve; });
runtime.invalidate();
const scanning = runtime.scanProfilePackages();
await scanStartedPromise;
profile = "desktop";
profileListener();
gateResolve();
assert.equal((await scanning), scanMap);
profile = "web";
scanRelease = null;

let stableCalls = 0;
const stable = await runtime.withStableProfileState(async () => {
  stableCalls++;
  if (stableCalls === 1) profileListener();
  return stableCalls;
});
assert.equal(stable, 2);

let repeated = 0;
await assert.rejects(() => runtime.withStableProfileState(async () => {
  repeated++;
  profileListener();
  return repeated;
}), /profile state changed repeatedly/);

runtime.invalidate();
scanMap = new Map();
scanRelease = null;
assert.equal(await runtime.annotateInstalled({ full_name: "owner/none", name: "none" }), false);

// A generation change during index construction returns no stale index; the
// skills path must then use its direct detector instead of reporting false.
runtime.invalidate();
let managedRelease;
let managedStarted;
const managedStartedPromise = new Promise((resolve) => { managedStarted = resolve; });
const managedGate = new Promise((resolve) => { managedRelease = resolve; });
const originalManagedForRace = adapter.scanManagedDirs;
adapter.scanManagedDirs = async () => {
  managedStarted();
  await managedGate;
  return new Set();
};
const skillRace = runtime.annotateSkillInstalled({ full_name: "owner/skill-dir", name: "skill-dir" });
await managedStartedPromise;
installedListener();
managedRelease();
assert.equal(await skillRace, true);
adapter.scanManagedDirs = originalManagedForRace;

// Verify a failed index build falls back to the legacy detector and the owner remains usable.
runtime.invalidate();
const originalManaged = adapter.scanManagedDirs;
adapter.scanManagedDirs = async () => { indexBuilds++; if (failBuild) throw new Error("index failed"); return new Set(); };
failBuild = true;
assert.equal(await runtime.annotateInstalled({ full_name: "owner/skill-dir", name: "skill-dir" }), true);
failBuild = false;
adapter.scanManagedDirs = originalManaged;
assert.equal(indexBuilds, 1);

assert.equal(typeof runtime.profileHit(indexOf(), { full_name: "owner/reverse" }, ["none"]), "object");
console.log("\napp/profile-index: all assertions passed");
