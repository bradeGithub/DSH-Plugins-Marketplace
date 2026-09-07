// Profile/index runtime contract: lifecycle state belongs to app/profile-index,
// while the entry only assembles it and preserves the historical exports.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const indexLib = readFileSync(join(ROOT, "lib", "index.js"), "utf8");
const runtimeLib = readFileSync(join(ROOT, "lib", "app", "profile-index.js"), "utf8");
const client = readFileSync(join(ROOT, "lib", "client.js"), "utf8");

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

check("profile/index runtime factory exists", /export function createProfileIndexRuntime\(\{/.test(runtimeLib), true);
check("profile scan cache belongs to runtime", /let profileScanCache = null;/.test(runtimeLib), true);
check("profile scan generation belongs to runtime", /let profileScanGeneration = 0;/.test(runtimeLib), true);
check("installed index cache belongs to runtime", /let installedIndex = null;/.test(runtimeLib), true);
check("installed index single-flight belongs to runtime", /let installedIndexBuild = null;/.test(runtimeLib), true);
check("installed index generation belongs to runtime", /let installedIndexGen = 0;/.test(runtimeLib), true);
check("runtime reuses profile scan adapter", /profileScanAdapter\.scanProfilePackages\(scanProfile\)/.test(runtimeLib), true);
check("runtime reuses profile scan managed dirs", /profileScanAdapter\.scanManagedDirs\(\)/.test(runtimeLib), true);
check("runtime reuses InstalledIndex domain", /buildInstalledIndexDomain\(/.test(runtimeLib), true);
check("runtime receives detached installed snapshot", /installedEntries: installedSnapshot\(\)/.test(runtimeLib), true);
check("runtime subscribes to profile changes", /onProfileChange\?\.\(invalidate\)/.test(runtimeLib), true);
check("runtime subscribes to installed changes", /onInstalledChange\?\.\(invalidate\)/.test(runtimeLib), true);
check("runtime owns stable-window retry", /async function withStableProfileState\(build\)/.test(runtimeLib), true);
check("stable-window retry checks both generations", /scanGeneration === profileScanGeneration[\s\S]*indexGeneration === installedIndexGen/.test(runtimeLib), true);
check("runtime owns index single-flight", /if \(!installedIndexBuild\) \{/.test(runtimeLib), true);
check("index build rejects stale generation", /if \(installedIndexGen !== buildGen\) return null;/.test(runtimeLib), true);
check("index build resets failed cache and propagates", /installedIndex = null;[\s\S]*throw error;/.test(runtimeLib), true);
check("index build always releases single-flight", /finally\(\(\) => \{[\s\S]*installedIndexBuild = null;/.test(runtimeLib), true);
check("runtime preserves five-way installed fallback", /cacheType === "script"/.test(runtimeLib) && /await matchProfileEntry\(profile, repo, keys\)/.test(runtimeLib), true);
check("runtime preserves skills installed fallback", /joinPath\(skillsDir, slugify\(repo\.name\)\)/.test(runtimeLib), true);
check("entry does not own profile/index lifecycle state", !/\b(?:profileScanCache|profileScanGeneration|installedIndexBuild|installedIndexGen)\b/.test(indexLib), true);
check("entry injects installed snapshot", /installedSnapshot: \(\) => installedState\.snapshot\(\)/.test(indexLib), true);
check("entry injects installed change notification", /onInstalledChange: \(listener\) => installedState\.onChange\(listener\)/.test(indexLib), true);
check("entry exposes compatibility scan wrapper", /const scanProfilePackages = \(\.\.\.args\) => profileIndexRuntime\.scanProfilePackages/.test(indexLib), true);
check("entry exposes compatibility index wrapper", /const ensureInstalledIndex = \(\.\.\.args\) => profileIndexRuntime\.ensureInstalledIndex/.test(indexLib), true);
check("backup keeps detached installed entries", /getInstalledEntries: \(\) => installedState\.entries\(\)/.test(indexLib), true);

// Existing response/client contracts remain protected by this focused oracle.
check("listFingerprint implementation remains", /function listFingerprint\(repos\) \{[\s\S]*?\n\}/.test(indexLib), true);
check("client fingerprint prefers server fp", /if \(typeof data\.fp === "string"\) return data\.fp;/.test(client), true);
check("skills client keeps local refreshing state", /function SkillsTab\(props\) \{[\s\S]{0,1200}var state9 = useState\(false\); var refreshing = state9\[0\]; var setRefreshing = state9\[1\];/.test(client), true);
check("skills refresh resets state", /fetchPage\(1, query, true\)\.finally\(function \(\) \{ setRefreshing\(false\); \}\)/.test(client), true);
check("fp includes list length", /function listFingerprint\(repos\) \{[\s\S]{0,400}repos\.length/.test(indexLib), true);
check("fp includes installed bit", /function listFingerprint\(repos\) \{[\s\S]{0,400}installed === true/.test(indexLib), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
