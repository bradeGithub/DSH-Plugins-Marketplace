import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, rm, cp, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { createInstallExecutor } from "../../../lib/app/install-exec.js";

const root = mkdtempSync(join(tmpdir(), "dsh-install-exec-"));
const cache = join(root, "cache");
const skillsDir = join(root, "skills");
const presetsDir = join(root, "presets");
const profileDir = join(root, "profiles", "old-profile");
const nodeModules = join(profileDir, "node_modules");
const patchFile = join(profileDir, "cordis.patch.yml");
const packageFile = join(profileDir, "package.json");
const logs = [];
const calls = [];
let skillRoots = [];
let pluginRoots = [];
let presetRoots = [];

const exists = async (path) => stat(path).then(() => true).catch(() => false);
const readPackage = async (dir) => {
  try { return JSON.parse(await readFile(join(dir, "package.json"), "utf8")); } catch { return null; }
};
const slugify = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
const copyFilter = (source, excludeNodeModules) => {
  const git = join(source, ".git");
  const dependencies = join(source, "node_modules");
  return (path) => !(
    path === git || path.startsWith(git + sep)
    || (excludeNodeModules && (path === dependencies || path.startsWith(dependencies + sep)))
  );
};

const executor = createInstallExecutor({
  fs: { mkdir, rm, cp, readFile, writeFile, readdir, exists },
  path: { joinPath: join, resolvePath: resolve, pathSep: sep },
  proc: {
    runScript: async (...args) => calls.push(["runScript", ...args]),
  },
  scan: {
    findSkillRoots: async () => skillRoots,
    findPluginRoots: async () => pluginRoots,
    findPresetRoots: async () => presetRoots,
    readSkillManifest: async (dir) => readFile(join(dir, "SKILL.md"), "utf8"),
    needsPluginBuild: async () => false,
  },
  package: {
    sanitizeManifest: () => [],
    isBundlePackage: (pkg) => Boolean(pkg?.dsh?.bundle),
    packageNamePattern: /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/,
    copyFilter,
    readPackageVersion: async (dir) => (await readPackage(dir))?.version ?? null,
  },
  adapters: {
    registerBundlePackage: async () => join(nodeModules, "bundle"),
    appendPatchEntry: async (...args) => {
      calls.push(["appendPatchEntry", ...args]);
      return true;
    },
  },
  env: {
    buildMinimalEnv: () => ({ PATH: "minimal" }),
    buildFilteredEnv: () => ({ PATH: "filtered" }),
  },
  managedDirs: { skillsDir, presetsDir },
  selfUpdateRepo: "owner/self",
  platform: process.platform,
  slugify,
  buildPluginPackage: async () => {},
  npmInstallWithFallback: async () => {},
  translate: (_lang, key) => key,
});

const run = (input) => executor({
  cacheDir: cache,
  repo: "owner/demo",
  log: [],
  answers: {},
  logLine: (line) => logs.push(line),
  lang: "en",
  envAllowList: [],
  npmTarget: null,
  profilePaths: { profileDir, nodeModules, patchFile, packageFile },
  ...input,
});

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
    pass++;
    console.log(`PASS ${name}`);
  } catch (error) {
    fail++;
    console.log(`FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

try {
  const skillRoot = join(cache, "skill");
  mkdirSync(join(skillRoot, "node_modules"), { recursive: true });
  mkdirSync(join(skillRoot, ".git"), { recursive: true });
  writeFileSync(join(skillRoot, "SKILL.md"), "---\nname: real-skill\n---\n# real\n");
  writeFileSync(join(skillRoot, "node_modules", "ignored.js"), "ignored");
  writeFileSync(join(skillRoot, ".git", "config"), "git");
  skillRoots = [skillRoot];
  const skill = await run({ type: "skill", repo: "owner/source" });
  check("真实目录 skill 结果", skill, {
    type: "skill",
    name: "real-skill",
    names: ["real-skill"],
    count: 1,
    location: join(skillsDir, "real-skill")
  });
  check("真实目录 skill 复制和过滤", [
    existsSync(join(skillsDir, "real-skill", "SKILL.md")),
    existsSync(join(skillsDir, "real-skill", "node_modules", "ignored.js")),
    existsSync(join(skillsDir, "real-skill", ".git", "config"))
  ], [true, false, false]);

  const presetRoot = join(cache, "preset");
  mkdirSync(presetRoot, { recursive: true });
  writeFileSync(join(presetRoot, "preset.yml"), "preset");
  writeFileSync(join(presetRoot, "agent.cordis.yml"), "agent");
  presetRoots = [presetRoot];
  const preset = await run({ type: "agent-preset", repo: "owner/real-preset" });
  check("真实目录 preset 结果", preset, {
    type: "agent-preset",
    name: "real-preset",
    names: ["real-preset"],
    count: 1,
    location: join(presetsDir, "real-preset")
  });
  check("真实目录 preset 文件存在", existsSync(join(presetsDir, "real-preset", "preset.yml")), true);

  const pluginRoot = join(cache, "plugin");
  mkdirSync(pluginRoot, { recursive: true });
  writeFileSync(join(pluginRoot, "package.json"), JSON.stringify({ name: "real-plugin", version: "4.5.6", main: "index.js" }));
  writeFileSync(join(pluginRoot, "index.js"), "module.exports = {};");
  pluginRoots = [pluginRoot];
  const plugin = await run({ type: "cordis-plugin" });
  check("真实目录 plugin 结果", plugin, {
    type: "cordis-plugin",
    name: "real-plugin",
    names: ["real-plugin"],
    count: 1,
    location: join(nodeModules, "real-plugin"),
    version: "4.5.6",
    bundle: false
  });
  check("真实目录 plugin 入口和版本存在", [
    existsSync(join(nodeModules, "real-plugin", "index.js")),
    JSON.parse(readFileSync(join(nodeModules, "real-plugin", "package.json"), "utf8")).version
  ], [true, "4.5.6"]);
  check("真实目录 plugin 使用显式 patch 快照", calls.find((call) => call[0] === "appendPatchEntry")?.slice(1), ["real-plugin", "real-plugin", patchFile]);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
