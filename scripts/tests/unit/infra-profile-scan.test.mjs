import assert from "node:assert/strict";
import { createProfileScanAdapter } from "../../../lib/infra/profile-scan.js";

function dir(name) {
  return { name, isDirectory: () => true };
}

function createFakeFs(tree) {
  const calls = [];
  return {
    calls,
    async readdir(path) {
      calls.push(path);
      if (!Object.hasOwn(tree, path)) {
        const error = new Error(`missing: ${path}`);
        error.code = "ENOENT";
        throw error;
      }
      return tree[path];
    },
  };
}

function createHarness() {
  const tree = {
    "profiles/web/node_modules": [
      dir("alpha"),
      dir("@scope"),
      dir(".backup"),
      dir("no-name"),
      dir("broken"),
      dir("dupe"),
    ],
    "profiles/web/node_modules/@scope": [dir("beta")],
    skills: [dir("skill-one"), dir(".hidden")],
    presets: [dir("preset-one")],
    "profiles/desktop/node_modules": [dir("desktop-only")],
    cache: [dir("owner__script"), dir("owner__pkg"), dir(".tmp")],
  };
  const summaries = new Map([
    ["profiles/web/node_modules/alpha", { name: "alpha", version: "1.2.3", repository: "owner/alpha" }],
    ["profiles/web/node_modules/@scope/beta", { name: "@scope/beta", version: "2.0.0", repository: "owner/beta" }],
    ["profiles/web/node_modules/no-name", { version: "1.0.0", repository: "owner/no-name" }],
    ["profiles/web/node_modules/broken", null],
    ["profiles/web/node_modules/dupe", { name: "DUPE", version: "3.0.0", repository: null }],
  ]);
  const fs = createFakeFs(tree);
  const summaryCalls = [];
  const adapter = createProfileScanAdapter({
    fs,
    paths: {
      profileNodeModules: (profile) => `profiles/${profile}/node_modules`,
      skillsDir: "skills",
      presetsDir: "presets",
      cacheDir: "cache",
    },
    readPackageSummary: async (path) => {
      summaryCalls.push(path);
      return summaries.get(path) ?? null;
    },
    detectCacheType: async (path) => path.endsWith("owner__script") ? "script" : "cordis-plugin",
    readPackageName: async (path) => path.endsWith("owner__pkg") ? "published/pkg" : null,
  });
  return { tree, fs, adapter, summaryCalls };
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

await test("扫描当前 profile、scoped 包和共享目录并跳过隐藏目录", async () => {
  const { adapter } = createHarness();
  const map = await adapter.scanProfilePackages("web");

  assert.deepEqual([...map.keys()], [
    "alpha", "@scope", "@scope/beta", "no-name", "broken", "dupe", "skill-one", "preset-one",
  ]);
  assert.deepEqual(map.get("alpha"), {
    name: "alpha", version: "1.2.3", repository: "owner/alpha",
  });
  assert.deepEqual(map.get("@scope/beta"), {
    name: "@scope/beta", version: "2.0.0", repository: "owner/beta",
  });
  assert.deepEqual(map.get("no-name"), {
    name: null, version: null, repository: null,
  });
  assert.deepEqual(map.get("dupe"), {
    name: "DUPE", version: "3.0.0", repository: null,
  });
  assert.equal(map.has(""), false);
  assert.equal(map.has(".backup"), false);
  assert.equal(map.has(".hidden"), false);
});

await test("profile node_modules 隔离且扫描 adapter 不缓存结果", async () => {
  const { tree, adapter } = createHarness();
  const desktop = await adapter.scanProfilePackages("desktop");
  assert.deepEqual([...desktop.keys()], ["desktop-only", "skill-one", "preset-one"]);

  const first = await adapter.scanProfilePackages("web");
  tree["profiles/web/node_modules"].push(dir("added-after-first-scan"));
  const second = await adapter.scanProfilePackages("web");
  assert.equal(first.has("added-after-first-scan"), false);
  assert.equal(second.has("added-after-first-scan"), true);
});

await test("managed dirs 保留 skills 与 preset 的目录集合", async () => {
  const { adapter } = createHarness();
  assert.deepEqual(await adapter.scanManagedDirs(), new Set(["skill-one", ".hidden", "preset-one"]));
});

await test("cache 扫描只把 script 和 package name 投影为派生输入", async () => {
  const { adapter } = createHarness();
  const result = await adapter.scanCacheEntries();
  assert.deepEqual(result.scripts, new Set(["owner__script"]));
  assert.deepEqual(result.packageNames, new Map([["owner__pkg", "published/pkg"]]));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
