import assert from "node:assert/strict";
import { posix as pathPosix } from "node:path";
import { createBundleRegisterAdapter } from "../../../lib/infra/bundle-register.js";

const joinPath = (...parts) => pathPosix.join(...parts);
const resolvePath = (path) => pathPosix.resolve(path);

const PROFILE_DIR = "/dsh/profiles/web";
const NODE_MODULES = `${PROFILE_DIR}/node_modules`;
const PACKAGE_FILE = `${PROFILE_DIR}/package.json`;
const PKG_NAME_PATTERN = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createFakeFs({
  manifest = {
    name: "dsh-profile",
    dependencies: { existing: "1.0.0" },
    dsh: { profile: { bundles: ["existing-bundle"] } },
    marker: "keep",
  },
  bundle = {
    name: "fake-bundle",
    version: "1.2.3",
    main: "lib/index.js",
    dependencies: { "fake-dep": "^1.0.0" },
  },
  packageFile = PACKAGE_FILE,
  resolvedPkg = `${NODE_MODULES}/fake-bundle`,
  includePackage = true,
  includeMain = true,
  failWriteAt = null,
  failRenameAt = null,
  realPath = null,
} = {}) {
  const files = new Map([[packageFile, JSON.stringify(manifest)]])
  const writes = [];
  const renames = [];
  const removals = [];
  let writeCount = 0;
  let renameCount = 0;

  if (includePackage) {
    files.set(`${resolvedPkg}/package.json`, JSON.stringify(bundle));
    if (includeMain && typeof bundle.main === "string") {
      files.set(joinPath(resolvedPkg, bundle.main), "export default {};");
    }
  }

  const removeTree = (path) => {
    for (const key of files.keys()) {
      if (key === path || key.startsWith(path + "/")) files.delete(key);
    }
  };

  return {
    files,
    writes,
    renames,
    removals,
    async readFile(path) {
      if (!files.has(path)) {
        const error = new Error(`missing: ${path}`);
        error.code = "ENOENT";
        throw error;
      }
      return files.get(path);
    },
    async writeFile(path, text) {
      writeCount++;
      writes.push({ path, text });
      if (failWriteAt === writeCount) throw new Error("manifest write failed");
      files.set(path, text);
    },
    async rename(from, to) {
      renameCount++;
      renames.push({ from, to });
      if (failRenameAt === renameCount) throw new Error("manifest rename failed");
      if (!files.has(from)) throw new Error(`missing temporary file: ${from}`);
      files.set(to, files.get(from));
      files.delete(from);
    },
    async rm(path) {
      removals.push(path);
      removeTree(path);
    },
    async realpath(path) {
      return realPath ?? path;
    },
    async exists(path) {
      return files.has(path);
    },
  };
}

function createHarness(options = {}) {
  const fs = createFakeFs(options);
  const pnpmCalls = [];
  const resolverCalls = [];
  const logs = [];
  let pnpmError = null;
  const resolverResults = new Map([["fake-dep/package.json", true], ["fake-dep", true]]);
  const defaultPaths = {
    profileDir: PROFILE_DIR,
    nodeModules: NODE_MODULES,
    packageFile: PACKAGE_FILE,
  };
  const adapter = createBundleRegisterAdapter({
    fs,
    profilePaths: {
      profileDir: () => defaultPaths.profileDir,
      nodeModules: () => defaultPaths.nodeModules,
      packageFile: () => defaultPaths.packageFile,
    },
    runPnpm: async (args, opts) => {
      pnpmCalls.push({ args, opts });
      if (pnpmError) throw pnpmError;
    },
    resolvePackage: async (anchor, spec) => {
      resolverCalls.push({ anchor, spec });
      return resolverResults.get(spec) ?? false;
    },
    joinPath,
    resolvePath,
    pathSep: "/",
    packageNamePattern: PKG_NAME_PATTERN,
    translate: (lang, key, params = {}) => `${lang}:${key}:${JSON.stringify(params)}`,
  });
  return {
    fs,
    adapter,
    pnpmCalls,
    resolverCalls,
    logs,
    setPnpmError(error) {
      pnpmError = error;
    },
    setResolverResult(spec, value) {
      resolverResults.set(spec, value);
    },
    logLine(line) {
      logs.push(line);
    },
    paths: { ...defaultPaths },
    env: { PATH: "/usr/bin", BUNDLE_TOKEN: "allowed" },
  };
}

async function register(harness, pkgName = "fake-bundle", depSpec = "1.2.3", paths = harness.paths) {
  return harness.adapter.registerBundlePackage(
    pkgName,
    depSpec,
    harness.env,
    harness.logLine,
    "zh",
    paths,
  );
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

await test("成功注册 bundle 并保留 manifest 字段", async () => {
  const h = createHarness();
  const result = await register(h);
  const manifest = JSON.parse(h.fs.files.get(PACKAGE_FILE));

  assert.equal(result, `${NODE_MODULES}/fake-bundle`);
  assert.equal(manifest.dependencies.existing, "1.0.0");
  assert.equal(manifest.dependencies["fake-bundle"], "1.2.3");
  assert.deepEqual(manifest.dsh.profile.bundles, ["existing-bundle", "fake-bundle"]);
  assert.equal(manifest.marker, "keep");
  assert.deepEqual(h.pnpmCalls[0].args, ["install", "--ignore-workspace"]);
  assert.equal(h.pnpmCalls[0].opts.cwd, PROFILE_DIR);
  assert.deepEqual(h.pnpmCalls[0].opts.env, h.env);
  assert.equal(h.fs.renames[0].from, PACKAGE_FILE + ".tmp");
  assert.equal(h.fs.renames[0].to, PACKAGE_FILE);
});

await test("重复注册不重复追加 bundle", async () => {
  const h = createHarness();
  await register(h);
  await register(h);
  const manifest = JSON.parse(h.fs.files.get(PACKAGE_FILE));

  assert.deepEqual(manifest.dsh.profile.bundles, ["existing-bundle", "fake-bundle"]);
  assert.equal(manifest.dependencies["fake-bundle"], "1.2.3");
});

await test("pnpm 非零但包可解析时成功并记录警告", async () => {
  const h = createHarness();
  h.setPnpmError(new Error("pnpm warning ".padEnd(600, "x")));

  const result = await register(h);

  assert.equal(result, `${NODE_MODULES}/fake-bundle`);
  assert.equal(h.logs.some((line) => line.includes("bundlePnpmWarn")), true);
  assert.ok(h.logs.join("\n").length < 1000);
});

await test("pnpm 后包缺失时回滚 manifest 并抛错", async () => {
  const h = createHarness({ includePackage: false });
  const before = JSON.stringify(JSON.parse(h.fs.files.get(PACKAGE_FILE)));

  await assert.rejects(register(h), /bundleResolveFail/);

  assert.equal(JSON.stringify(JSON.parse(h.fs.files.get(PACKAGE_FILE))), before);
});

await test("main 越界时回滚并删除解析目录", async () => {
  const h = createHarness({
    bundle: { name: "fake-bundle", version: "1.2.3", main: "../../outside.js" },
  });

  await assert.rejects(register(h), /bundleEntryTraversal/);

  assert.equal(h.fs.removals.includes(`${NODE_MODULES}/fake-bundle`), true);
  assert.equal(JSON.parse(h.fs.files.get(PACKAGE_FILE)).dependencies["fake-bundle"], undefined);
});

await test("main 缺失时回滚并删除解析目录", async () => {
  const h = createHarness({
    bundle: { name: "fake-bundle", version: "1.2.3", main: "lib/index.js" },
    includeMain: false,
  });

  await assert.rejects(register(h), /bundleEntryMissing/);

  assert.equal(h.fs.removals.includes(`${NODE_MODULES}/fake-bundle`), true);
  assert.equal(JSON.parse(h.fs.files.get(PACKAGE_FILE)).dependencies["fake-bundle"], undefined);
});

await test("非法依赖名拒绝且不调用 resolver", async () => {
  const h = createHarness({
    bundle: {
      name: "fake-bundle",
      version: "1.2.3",
      dependencies: { "../../escape": "1.0.0" },
    },
  });

  await assert.rejects(register(h), /bundleDepInvalid/);

  assert.equal(h.resolverCalls.length, 0);
  assert.equal(JSON.parse(h.fs.files.get(PACKAGE_FILE)).dependencies["fake-bundle"], undefined);
});

await test("依赖解析失败时回滚 manifest", async () => {
  const h = createHarness();
  h.setResolverResult("fake-dep/package.json", false);
  h.setResolverResult("fake-dep", false);

  await assert.rejects(register(h), /bundleDepsResolveFail/);

  assert.equal(JSON.parse(h.fs.files.get(PACKAGE_FILE)).dependencies["fake-bundle"], undefined);
  assert.equal(h.resolverCalls.length, 2);
});

await test("回滚写入失败不覆盖原始错误并记录警告", async () => {
  const h = createHarness({ includePackage: false, failWriteAt: 2 });

  await assert.rejects(register(h), /bundleResolveFail/);

  assert.equal(h.logs.some((line) => line.includes("bundleRollbackWarn")), true);
});

await test("仓库来源保留 github 依赖规格", async () => {
  const h = createHarness();

  await register(h, "fake-bundle", "github:owner/repo");

  const manifest = JSON.parse(h.fs.files.get(PACKAGE_FILE));
  assert.equal(manifest.dependencies["fake-bundle"], "github:owner/repo");
});

await test("依赖解析使用 realpath 锚点", async () => {
  const h = createHarness({ realPath: "/real/fake-bundle" });

  await register(h);

  assert.equal(h.resolverCalls[0].anchor, "/real/fake-bundle");
});

await test("显式旧 profile 路径优先于默认路径", async () => {
  const oldProfile = "/dsh/profiles/old";
  const oldNodeModules = `${oldProfile}/node_modules`;
  const oldPackageFile = `${oldProfile}/package.json`;
  const h = createHarness({
    packageFile: oldPackageFile,
    resolvedPkg: `${oldNodeModules}/fake-bundle`,
  });
  h.paths = { profileDir: oldProfile, nodeModules: oldNodeModules, packageFile: oldPackageFile };

  const result = await register(h, "fake-bundle", "1.2.3", h.paths);

  assert.equal(result, `${oldNodeModules}/fake-bundle`);
  assert.equal(h.pnpmCalls[0].opts.cwd, oldProfile);
  assert.equal(h.fs.files.has(PACKAGE_FILE), false);
  assert.equal(JSON.parse(h.fs.files.get(oldPackageFile)).dependencies["fake-bundle"], "1.2.3");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
