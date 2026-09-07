import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createInstallPreflight } from "../../../lib/app/install.js";

const home = await mkdtemp(join(tmpdir(), "dsh-classification-"));
const previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = home.replace(/\\/g, "/");
let pass = 0;
let fail = 0;
async function test(name, run) {
  try {
    await run();
    pass++;
    console.log(`PASS ${name}`);
  } catch (error) {
    fail++;
    console.error(`FAIL ${name}: ${error.stack}`);
  }
}

async function fixture(name, files) {
  const dir = join(home, "fixtures", name);
  await mkdir(dir, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const path = join(dir, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return dir;
}

const pkg = (value) => JSON.stringify({ name: "classification-demo", version: "1.0.0", ...value });
const cases = [
  ["root-preset", { "preset.yml": "[]", "agent.cordis.yml": "[]", "package.json": pkg({ dsh: {} }), "install.sh": "exit 0" }, ["agent-preset", "presetRoot", "preset"]],
  ["bundle", { "package.json": pkg({ dsh: { bundle: { patch: "./patch.yml" } } }), "install.ps1": "exit 0" }, ["bundle", "bundleDeclared", "bundle"]],
  ["declared", { "package.json": pkg({ dsh: {} }), "install.sh": "exit 0", "SKILL.md": "# skill" }, ["cordis-plugin", "dshDeclared", "dshDeclared"]],
  ["core-dependency", { "package.json": pkg({ peerDependencies: { "@deepseek-ai/dsh-web": "*" } }), "install.sh": "exit 0" }, ["cordis-plugin", "dshDeclared", "dshDeclared"]],
  ["dev-only", { "package.json": pkg({ devDependencies: { "@deepseek-ai/dsh-web": "*" } }) }, ["cordis-plugin", "pkgOnly", "pkgOnly"]],
  ["empty-bundle", { "package.json": pkg({ dsh: { bundle: { patch: "" } } }) }, ["cordis-plugin", "dshDeclared", "dshDeclared"]],
  ["script", { "install.ps1": "exit 0", "install.sh": "exit 0" }, ["script", "ps1", "script"]],
  ["shell", { "install.sh": "exit 0" }, ["script", "sh", "script"]],
  ["nested-preset", { "package.json": pkg({}), "SKILL.md": "# root skill", "preset/preset.yml": "[]", "preset/agent.cordis.yml": "[]" }, ["agent-preset", "nestedPreset", "preset"]],
  ["tooling-skill", { "package.json": pkg({}), "sKiLl.Md": "# skill" }, ["skill", "pkgSkillRoot", "skill"]],
  ["ordinary", { "package.json": pkg({}), "skills/demo/SKILL.md": "# nested skill" }, ["cordis-plugin", "pkgOnly", "pkgOnly"]],
  ["broken", { "package.json": "{broken" }, ["cordis-plugin", "pkgOnly", "pkgOnly"]],
  ["null-json", { "package.json": "null" }, ["cordis-plugin", "pkgOnly", "pkgOnly"]],
  ["root-skill", { "skill.md": "# root skill" }, ["skill", "skillRoot", "skill"]],
  ["multi-plugin", { "plugins/demo/package.json": pkg({ dsh: {} }), "skills/demo/SKILL.md": "# nested skill" }, ["cordis-plugin", "nestedPlugin", "nestedPlugin"]],
  ["nested-skill", { "skills/demo/SKILL.md": "# nested skill" }, ["skill", "nestedSkill", "skill"]],
  ["excluded-skill", { "vendor/demo/SKILL.md": "# vendor", "node_modules/demo/SKILL.md": "# dep", ".hidden/SKILL.md": "# hidden" }, ["instructions", "none", "none"]],
  ["partial-preset", { "preset/preset.yml": "[]" }, ["instructions", "none", "none"]],
  ["plain-nested-package", { "packages/demo/package.json": pkg({}) }, ["instructions", "none", "none"]],
  ["empty", { "README.md": "# manual guide" }, ["instructions", "none", "none"]],
];

try {
  const lib = await import("../../../lib/index.js");
  const directories = new Map();
  for (const [name, files, [type, reason, hint]] of cases) {
    const dir = await fixture(name, files);
    directories.set(name, dir);
    await test(`真实文件分类 ${name}`, async () => {
      assert.deepEqual(await lib.detectTypeDetail(dir), {
        type, reasonKey: `detectReason.${reason}`, hintKey: `detectHint.${hint}`,
      });
      assert.equal(await lib.detectType(dir), type);
    });
  }

  await test("不存在目录回退说明而不是抛错", async () => {
    assert.equal(await lib.detectType(join(home, "missing")), "instructions");
  });

  await test("SKILL.md 同名目录不能冒充技能清单", async () => {
    const dir = await fixture("directory-skill", {});
    await mkdir(join(dir, "SKILL.md"));
    assert.equal(await lib.detectType(dir), "instructions");
  });

  const exists = async (path) => stat(path).then(() => true).catch(() => false);
  const readPackageJsonObject = async (dir) => {
    try { return JSON.parse(await readFile(join(dir, "package.json"), "utf8")); }
    catch { return null; }
  };
  const cleanupCalls = [];
  const preflight = createInstallPreflight({
    detectTypeDetail: lib.detectTypeDetail,
    findPluginRoots: lib.findPluginRoots,
    scanRequirements: async () => [],
    scanCacheSecrets: async () => [],
    scanCacheVulnerabilities: async () => [],
    scanScriptHazards: async () => [],
    scanLifecycleHazards: async () => [],
    readLifecycleScripts: lib.readLifecycleScripts,
    scanHostShadowDeps: async () => [],
    needsPluginBuild: async () => false,
    readPackageJsonObject,
    looksLikeDshPlugin: lib.looksLikeDshPlugin,
    exists, readFile, joinPath: join,
    cleanupCache: async (path) => { cleanupCalls.push(path); },
    redactLog: (text) => text,
    translate: (_lang, key, params) => ({ key, params }),
  });

  for (const [name, status, type, question, reason, hint] of [
    ["declared", "continue", "cordis-plugin", undefined, "dshDeclared", "dshDeclared"],
    ["bundle", "continue", "bundle", undefined, "bundleDeclared", "bundle"],
    ["ordinary", "awaiting-input", "cordis-plugin", "__confirm_non_plugin__", "pkgOnly", "pkgOnly"],
    ["script", "awaiting-input", "script", "__confirm_script__", "ps1", "script"],
    ["empty", "awaiting-input", "instructions", "__confirm_manual__", "none", "none"],
  ]) {
    await test(`真实分类接入安装前置 ${name}`, async () => {
      const log = [];
      const result = await preflight({ cacheDir: directories.get(name), repo: `fixture/${name}`, answers: {}, log, logLine: (line) => log.push(line), lang: "zh" });
      assert.deepEqual([result.status, result.type, result.questions?.[0]?.id], [status, type, question]);
      assert.deepEqual(log[1], {
        key: "typeReason", params: {
          matched: { key: `detectReason.${reason}`, params: undefined },
          hint: { key: `detectHint.${hint}`, params: undefined },
        },
      });
      assert.equal(await exists(directories.get(name)), true);
      assert.deepEqual(cleanupCalls, []);
    });
  }
} catch (error) {
  fail++;
  console.error(error);
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
}

console.log(`\nrepository-classification integration: ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
