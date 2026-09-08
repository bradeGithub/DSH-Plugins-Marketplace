import assert from "node:assert/strict";
import { join } from "node:path";
import { buildInstalledIndex, profileHit } from "../../../lib/domain/installed-index.js";

const skillsRoot = join("/dsh", "skills");
const presetsRoot = join("/dsh", "presets");
const windowsSkillsRoot = "\\dsh\\skills";
const profile = new Map([
  ["pkg", { name: "pkg", version: "1.0.0", repository: "owner/pkg" }],
  ["reverse-key", { name: "published-name", version: "2.0.0", repository: "owner/reverse" }],
  ["raw-key", { name: "raw-name", version: "1.0.0", repository: "https://github.com/owner/raw.git" }],
  ["shared", { name: null, version: null, repository: null }],
  ["@deepseek-ai/dsh-web", {
    name: "@deepseek-ai/dsh-web", version: "1.0.0", repository: "owner/from-official",
  }],
]);
const installedEntries = new Map([
  ["owner/shared", { location: join(skillsRoot, "shared", "SKILL.md") }],
  ["owner/preset", { location: join(presetsRoot, "preset") }],
  ["owner/prefix", { location: join(`${skillsRoot}foreign`, "bad") }],
  ["owner/windows", { location: windowsSkillsRoot + "\\win\\SKILL.md" }],
  ["owner/outside", { location: join("/other", "outside") }],
]);
const managedDirs = new Set(["shared", "orphan"]);
const cacheEntries = {
  scripts: new Set(["owner__script"]),
  packageNames: new Map([["owner__pkg", "published/pkg"]]),
};

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

const index = buildInstalledIndex({
  profile,
  installedEntries,
  managedDirs,
  managedRoots: [skillsRoot, presetsRoot, windowsSkillsRoot],
  cacheEntries,
  official: new Set(["@deepseek-ai/dsh-web"]),
  ownRepo: "owner/marketplace",
});

test("index 构建保留显式输入并生成目录集合", () => {
  assert.equal(index.profile, profile);
  assert.notEqual(index.dirs, managedDirs);
  assert.deepEqual(index.dirs, new Set(["shared", "orphan"]));
  assert.notEqual(index.cacheScripts, cacheEntries.scripts);
  assert.notEqual(index.cachePkgNames, cacheEntries.packageNames);
  assert.deepEqual(index.cacheScripts, new Set(["owner__script"]));
  assert.deepEqual(index.cachePkgNames, new Map([["owner__pkg", "published/pkg"]]));
  assert.equal(index.ownRepo, "owner/marketplace");
  assert.equal(index.official.has("@deepseek-ai/dsh-web"), true);
});

test("repository 反向索引排除 official package", () => {
  assert.equal(index.repoIndex.get("owner/pkg")?.name, "pkg");
  assert.equal(index.repoIndex.get("owner/raw")?.name, "raw-name");
  assert.equal(index.repoIndex.has("owner/from-official"), false);
});

test("目录属主只从受管 skills/preset 路径生成", () => {
  assert.equal(index.dirOwners.get("shared"), "owner/shared");
  assert.equal(index.dirOwners.get("preset"), "owner/preset");
  assert.equal(index.dirOwners.get("win"), "owner/windows");
  assert.equal(index.dirOwners.has("bad"), false);
  assert.equal(index.dirOwners.has("oreign"), false);
  assert.equal(index.dirOwners.has("outside"), false);
});

test("profileHit 支持前向包名、repository 反向和属主消歧", () => {
  const direct = profileHit(index, { full_name: "owner/pkg" }, ["pkg"]);
  assert.equal(direct?.name, "pkg");

  const reverse = profileHit(index, { full_name: "owner/reverse" }, ["not-the-package"]);
  assert.equal(reverse?.name, "published-name");

  const rawReverse = profileHit(index, { full_name: "Owner/RAW" }, ["not-the-package"]);
  assert.equal(rawReverse?.name, "raw-name");

  const owner = profileHit(index, { full_name: "owner/shared" }, ["shared"]);
  assert.equal(owner, index.profile.get("shared"));
  assert.equal(profileHit(index, { full_name: "other/shared" }, ["shared"]), null);
});

test("profileHit 拒绝 repository 撞名和 official 命中", () => {
  assert.equal(profileHit(index, { full_name: "other/pkg" }, ["pkg"]), null);
  assert.equal(profileHit(index, { full_name: "owner/from-official" }, ["@deepseek-ai/dsh-web"]), null);
});

test("纯构建不修改输入 Map 和派生集合", () => {
  assert.deepEqual([...profile.keys()], ["pkg", "reverse-key", "raw-key", "shared", "@deepseek-ai/dsh-web"]);
  assert.deepEqual([...installedEntries.keys()], ["owner/shared", "owner/preset", "owner/prefix", "owner/windows", "owner/outside"]);
  assert.deepEqual([...cacheEntries.scripts], ["owner__script"]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
