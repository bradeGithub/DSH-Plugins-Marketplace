import assert from "node:assert/strict";
import { posix as pathPosix } from "node:path";
import { createInstallExecutor } from "../../../lib/app/install-exec.js";

const joinPath = (...parts) => pathPosix.join(...parts);
const resolvePath = (path) => pathPosix.resolve(path);
const pathSep = "/";

function makeHarness({ files: initialFiles = {}, dirs: initialDirs = [], overrides = {} } = {}) {
  const files = new Map(Object.entries(initialFiles));
  const dirs = new Set(initialDirs);
  const calls = [];
  const logs = [];
  const removeTree = (target) => {
    for (const path of [...files.keys()]) {
      if (path === target || path.startsWith(`${target}/`)) files.delete(path);
    }
    for (const path of [...dirs]) {
      if (path === target || path.startsWith(`${target}/`)) dirs.delete(path);
    }
  };
  const hasPath = (path) => files.has(path) || dirs.has(path);
  const fs = {
    mkdir: async (path, options) => {
      calls.push(["mkdir", path, options]);
      dirs.add(path);
    },
    rm: async (path, options) => {
      calls.push(["rm", path, options]);
      removeTree(path);
    },
    cp: async (source, target, options) => {
      calls.push(["cp", source, target, options]);
      dirs.add(target);
      const filter = options?.filter;
      for (const [path, content] of files) {
        if (path !== source && !path.startsWith(`${source}/`)) continue;
        if (filter && !filter(path)) continue;
        const relative = path.slice(source.length).replace(/^\//, "");
        const destination = relative ? joinPath(target, relative) : target;
        files.set(destination, content);
      }
      for (const path of dirs) {
        if (path !== source && !path.startsWith(`${source}/`)) continue;
        if (filter && !filter(path)) continue;
        const relative = path.slice(source.length).replace(/^\//, "");
        dirs.add(relative ? joinPath(target, relative) : target);
      }
    },
    readFile: async (path) => {
      calls.push(["readFile", path]);
      if (!files.has(path)) throw new Error(`ENOENT:${path}`);
      return files.get(path);
    },
    writeFile: async (path, content, encoding) => {
      calls.push(["writeFile", path, content, encoding]);
      files.set(path, String(content));
    },
    readdir: async (path) => {
      calls.push(["readdir", path]);
      const names = new Set();
      for (const child of [...files.keys(), ...dirs]) {
        if (!child.startsWith(`${path}/`)) continue;
        const rest = child.slice(path.length + 1);
        if (rest && !rest.includes("/")) names.add(rest);
      }
      return [...names];
    },
    exists: async (path) => hasPath(path),
  };
  const readPackageJsonObject = async (dir) => {
    try {
      return JSON.parse(await fs.readFile(joinPath(dir, "package.json"), "utf8"));
    } catch {
      return null;
    }
  };
  const readPackageVersion = async (dir) => {
    const pkg = await readPackageJsonObject(dir);
    return typeof pkg?.version === "string" ? pkg.version : null;
  };
  const copyFilter = (root, excludeNodeModules) => {
    const nm = joinPath(root, "node_modules");
    return (path) => {
      if (path === joinPath(root, ".git") || path.startsWith(`${joinPath(root, ".git")}/`)) return false;
      if (excludeNodeModules && (path === nm || path.startsWith(`${nm}/`))) return false;
      return true;
    };
  };
  const proc = {
    runScript: async (...args) => calls.push(["runScript", ...args]),
    runPnpm: async (...args) => calls.push(["runPnpm", ...args]),
    runNpm: async (...args) => calls.push(["runNpm", ...args]),
  };
  const scan = {
    findSkillRoots: async () => [],
    findPluginRoots: async () => [],
    findPresetRoots: async () => [],
    readSkillManifest: async (root) => fs.readFile(joinPath(root, "SKILL.md"), "utf8"),
    needsPluginBuild: async () => false,
  };
  const packageFns = {
    readPackageJsonObject,
    readPackageVersion,
    sanitizeManifest: () => [],
    isBundlePackage: (pkg) => Boolean(pkg?.dsh?.bundle),
    packageNamePattern: /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/,
    copyFilter,
  };
  const adapters = {
    registerBundlePackage: async (...args) => {
      calls.push(["registerBundlePackage", ...args]);
      return "/profile/node_modules/@scope/bundle";
    },
    appendPatchEntry: async (...args) => {
      calls.push(["appendPatchEntry", ...args]);
      return true;
    },
  };
  const env = {
    buildMinimalEnv: () => ({ PATH: "minimal", HOME: "/safe" }),
    buildFilteredEnv: () => ({ PATH: "filtered", HOME: "/safe", SECRET: "filtered-out-by-real-builder" }),
  };
  const {
    fs: fsOverrides = {},
    path: pathOverrides = {},
    proc: procOverrides = {},
    scan: scanOverrides = {},
    package: packageOverrides = {},
    adapters: adapterOverrides = {},
    env: envOverrides = {},
    managedDirs: managedDirsOverrides = {},
    ...flatOverrides
  } = overrides;
  const options = {
    fs: { ...fs, ...fsOverrides },
    path: { joinPath, resolvePath, pathSep, ...pathOverrides },
    proc: { ...proc, ...procOverrides },
    scan: { ...scan, ...scanOverrides },
    package: { ...packageFns, ...packageOverrides },
    adapters: { ...adapters, ...adapterOverrides },
    env: { ...env, ...envOverrides },
    managedDirs: { skillsDir: "/managed/skills", presetsDir: "/managed/presets", ...managedDirsOverrides },
    selfUpdateRepo: "owner/self",
    platform: "linux",
    slugify: (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, ""),
    translate: (_lang, key, params) => {
      const value = params && Object.values(params).find((item) => typeof item === "string");
      return value === undefined ? key : `${key}:${value}`;
    },
    ...flatOverrides,
  };
  const executor = createInstallExecutor(options);
  const run = (input = {}) => executor({
    type: "instructions",
    cacheDir: "/cache/repo",
    repo: "owner/repo",
    answers: {},
    log: [],
    logLine: (line) => logs.push(line),
    lang: "en",
    envAllowList: [],
    npmTarget: null,
    profilePaths: {
      profileDir: "/profile",
      nodeModules: "/profile/node_modules",
      patchFile: "/profile/cordis.patch.yml",
      packageFile: "/profile/package.json",
    },
    ...input,
  });
  return { run, calls, logs, files, dirs, fs, options };
}

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

{
  const { run, calls, logs, files, dirs } = makeHarness({
    files: {
      "/cache/repo/SKILL.md": "---\nname: hello-skill\n---\n# hello\n",
      "/cache/repo/node_modules/ignored.js": "ignored",
      "/cache/repo/.git/config": "git",
    },
    dirs: ["/cache/repo", "/cache/repo/node_modules", "/cache/repo/.git"],
    overrides: {
      scan: {
        findSkillRoots: async () => ["/cache/repo"],
        findPluginRoots: async () => [],
        findPresetRoots: async () => [],
        readSkillManifest: async () => "---\nname: hello-skill\n---\n# hello\n",
        needsPluginBuild: async () => false,
      }
    }
  });
  const result = await run({ type: "skill", repo: "owner/source" });
  check("skill 返回实际安装结果", result, {
    type: "skill",
    name: "hello-skill",
    names: ["hello-skill"],
    count: 1,
    location: "/managed/skills/hello-skill"
  });
  check("skill 复制到 managed dir 且过滤依赖", [
    calls.find((call) => call[0] === "cp")?.slice(0, 3),
    files.has("/managed/skills/hello-skill/SKILL.md"),
    files.has("/managed/skills/hello-skill/node_modules/ignored.js"),
    files.has("/managed/skills/hello-skill/.git/config")
  ], [["cp", "/cache/repo", "/managed/skills/hello-skill"], true, false, false]);
  check("skill 日志包含安装目标", logs.some((line) => String(line).includes("skillInstalled") && String(line).includes("hello-skill")), true);
  check("skill 创建 managed dir", dirs.has("/managed/skills"), true);
}

{
  const { run, calls } = makeHarness();
  await assert.rejects(() => run({ type: "skill" }), /No SKILL\.md was found/);
  check("空 skill root 不复制目录", calls.some((call) => call[0] === "cp"), false);
}

{
  const { run, calls, files } = makeHarness({
    files: {
      "/cache/repo/preset/preset.yml": "preset",
      "/cache/repo/preset/agent.cordis.yml": "agent",
      "/cache/repo/preset/tool.mjs": "tool",
      "/cache/repo/whoami/preset.yml": "preset2",
      "/cache/repo/whoami/agent.cordis.yml": "agent2",
    },
    dirs: ["/cache/repo", "/cache/repo/preset", "/cache/repo/whoami"],
    overrides: {
      scan: {
        findSkillRoots: async () => [],
        findPluginRoots: async () => [],
        findPresetRoots: async () => ["/cache/repo/preset", "/cache/repo/whoami"],
        readSkillManifest: async () => "",
        needsPluginBuild: async () => false,
      }
    }
  });
  const result = await run({ type: "agent-preset", repo: "owner/demo-preset" });
  check("preset 返回多根实际结果", result, {
    type: "agent-preset",
    name: "2-presets",
    names: ["demo-preset", "whoami"],
    count: 2,
    location: "/managed/presets"
  });
  check("preset 复制到仓库名和子目录名", calls.filter((call) => call[0] === "cp").map((call) => call[2]), [
    "/managed/presets/demo-preset",
    "/managed/presets/whoami"
  ]);
  check("preset 文件实际存在", [
    files.has("/managed/presets/demo-preset/preset.yml"),
    files.has("/managed/presets/whoami/preset.yml")
  ], [true, true]);
}

{
  const { run, calls, logs } = makeHarness({
    files: {
      "/cache/repo/package.json": JSON.stringify({ name: "@scope/bundle", version: "1.2.3", dsh: { bundle: true } })
    },
    overrides: {
      adapters: {
        registerBundlePackage: async (...args) => {
          calls.push(["registerBundlePackage", ...args]);
          return "/profile/node_modules/@scope/bundle";
        },
        appendPatchEntry: async (...args) => {
          calls.push(["appendPatchEntry", ...args]);
          return true;
        }
      }
    }
  });
  const result = await run({ type: "bundle", repo: "owner/bundle", npmTarget: "@scope/bundle" });
  check("bundle 返回注册器实际 location", result, {
    type: "bundle",
    name: "@scope/bundle",
    location: "/profile/node_modules/@scope/bundle",
    version: "1.2.3",
    bundle: true
  });
  const registerCall = calls.find((call) => call[0] === "registerBundlePackage");
  check("bundle npm 传精确版本和 profile 快照", [
    registerCall?.[1], registerCall?.[2], registerCall?.[3], typeof registerCall?.[4], registerCall?.[5], registerCall?.[6]
  ], [
    "@scope/bundle", "1.2.3", { PATH: "filtered", HOME: "/safe", SECRET: "filtered-out-by-real-builder" }, "function", "en",
    {
      profileDir: "/profile",
      nodeModules: "/profile/node_modules",
      patchFile: "/profile/cordis.patch.yml",
      packageFile: "/profile/package.json"
    }
  ]);
  check("bundle 不复制或写 patch", calls.some((call) => ["cp", "appendPatchEntry"].includes(call[0])), false);
}

{
  const { run, calls } = makeHarness({
    files: { "/cache/repo/package.json": JSON.stringify({ name: "bundle", version: "1.0.0", dsh: { bundle: true } }) },
    overrides: { selfUpdateRepo: "owner/repo" }
  });
  await assert.rejects(() => run({ type: "bundle", repo: "owner/repo" }), /selfPatchSkipped/);
  check("self bundle 不调用注册器", calls.some((call) => call[0] === "registerBundlePackage"), false);
}

{
  const { run, calls } = makeHarness({
    overrides: {
      platform: "win32",
      env: {
        buildMinimalEnv: () => ({ PATH: "minimal", HOME: "/safe" }),
        buildFilteredEnv: () => ({ PATH: "filtered", HOME: "/safe" }),
      },
      fs: {
        exists: async (path) => path === "/cache/repo/install.ps1" || path === "/cache/repo/install.sh",
      },
      proc: {
        runScript: async (...args) => calls.push(["runScript", ...args]),
        runPnpm: async (...args) => calls.push(["runPnpm", ...args]),
        runNpm: async (...args) => calls.push(["runNpm", ...args]),
      }
    }
  });
  const result = await run({
    type: "script",
    answers: { ALLOWED: "yes", NOT_SCANNED: "no", __confirm_script__: "continue" },
    envAllowList: ["ALLOWED"]
  });
  check("Windows script 返回安装目录", result, { type: "script", location: "/cache/repo" });
  check("Windows 优先 ps1 且透传安全 env", calls.find((call) => call[0] === "runScript")?.slice(1), [
    "/cache/repo/install.ps1",
    { cwd: "/cache/repo", env: { PATH: "minimal", HOME: "/safe", ALLOWED: "yes" }, timeout: 600000 }
  ]);
}

{
  const { run, calls } = makeHarness({
    overrides: {
      platform: "linux",
      fs: {
        exists: async (path) => path === "/cache/repo/install.sh",
      },
      proc: {
        runScript: async (...args) => calls.push(["runScript", ...args]),
        runPnpm: async (...args) => calls.push(["runPnpm", ...args]),
        runNpm: async (...args) => calls.push(["runNpm", ...args]),
      }
    }
  });
  await run({ type: "script" });
  check("Unix script 回退 sh", calls.find((call) => call[0] === "runScript")?.[1], "/cache/repo/install.sh");
}

{
  const { run } = makeHarness();
  await assert.rejects(() => run({ type: "script" }), /noScript/);
  check("缺少脚本拒绝执行", true, true);
}

{
  const { run, calls, files, logs } = makeHarness({
    files: {
      "/cache/repo/package.json": JSON.stringify({
        name: "demo-plugin",
        version: "2.0.0",
        main: "index.js",
        dependencies: { "local-dep": "link:../local-dep", "real-dep": "1.0.0" },
        peerDependencies: { "peer-dep": "2.0.0" }
      }),
      "/cache/repo/index.js": "module.exports = {}",
    },
    dirs: ["/cache/repo"],
    overrides: {
      scan: {
        findSkillRoots: async () => [],
        findPluginRoots: async () => ["/cache/repo"],
        findPresetRoots: async () => [],
        readSkillManifest: async () => "",
        needsPluginBuild: async () => false,
      },
      package: {
        sanitizeManifest: (pkg) => {
          delete pkg.dependencies["local-dep"];
          return ["dependencies:local-dep"];
        },
      },
      npmInstallWithFallback: async (...args) => calls.push(["npmInstallWithFallback", ...args]),
      buildPluginPackage: async (...args) => calls.push(["buildPluginPackage", ...args]),
    }
  });
  const result = await run({ type: "cordis-plugin", answers: { __confirm_npm_scripts__: "deny" } });
  check("cordis 返回单插件实际结果", result, {
    type: "cordis-plugin",
    name: "demo-plugin",
    names: ["demo-plugin"],
    count: 1,
    location: "/profile/node_modules/demo-plugin",
    version: "2.0.0",
    bundle: false
  });
  check("cordis 清洗本地协议并保留真实依赖", JSON.parse(files.get("/cache/repo/package.json")).dependencies, { "real-dep": "1.0.0" });
  check("cordis 依赖安装和 patch 使用显式路径", [
    calls.find((call) => call[0] === "npmInstallWithFallback")?.[1],
    calls.find((call) => call[0] === "appendPatchEntry")?.slice(1),
    files.has("/profile/node_modules/demo-plugin/index.js"),
    logs.some((line) => String(line).includes("patchDone"))
  ], ["/cache/repo", ["demo-plugin", "demo-plugin", "/profile/cordis.patch.yml"], true, true]);
}

{
  const { run, calls, files } = makeHarness({
    files: {
      "/cache/repo/package.json": JSON.stringify({ name: "source-plugin", version: "3.0.0", main: "dist/index.js", scripts: { build: "node build.js" } }),
    },
    dirs: ["/cache/repo"],
    overrides: {
      scan: {
        findSkillRoots: async () => [],
        findPluginRoots: async () => ["/cache/repo"],
        findPresetRoots: async () => [],
        readSkillManifest: async () => "",
        needsPluginBuild: async () => true,
      },
      buildPluginPackage: async (root) => {
        calls.push(["buildPluginPackage", root]);
        files.set("/cache/repo/dist/index.js", "built");
      },
      npmInstallWithFallback: async (...args) => calls.push(["npmInstallWithFallback", ...args]),
    }
  });
  const result = await run({ type: "cordis-plugin", answers: { __confirm_build__: "allow" } });
  check("build 路径复制构建产物", [result.version, files.has("/profile/node_modules/source-plugin/dist/index.js")], ["3.0.0", true]);
  check("build 成功跳过普通 npm 安装", calls
    .filter((call) => ["buildPluginPackage", "npmInstallWithFallback", "mkdir", "rm", "cp", "appendPatchEntry"].includes(call[0]))
    .map((call) => call[0]), ["buildPluginPackage", "mkdir", "rm", "cp", "appendPatchEntry"]);
}

{
  const { run, calls } = makeHarness({
    files: {
      "/cache/repo/a/package.json": JSON.stringify({ name: "plugin-a", version: "1.0.0" }),
      "/cache/repo/a/index.js": "a",
      "/cache/repo/b/package.json": JSON.stringify({ name: "plugin-b", version: "1.1.0", main: "missing.js" }),
    },
    dirs: ["/cache/repo", "/cache/repo/a", "/cache/repo/b"],
    overrides: {
      scan: {
        findSkillRoots: async () => [],
        findPluginRoots: async () => ["/cache/repo/a", "/cache/repo/b"],
        findPresetRoots: async () => [],
        readSkillManifest: async () => "",
        needsPluginBuild: async () => false,
      },
      npmInstallWithFallback: async (...args) => calls.push(["npmInstallWithFallback", ...args]),
    }
  });
  const result = await run({ type: "cordis-plugin", answers: {} });
  check("多插件聚合真实 names/count/location", result, {
    type: "cordis-plugin",
    name: "2-plugins",
    names: ["plugin-a", "plugin-b"],
    count: 2,
    location: "/profile/node_modules",
    version: null,
    bundle: false,
    warnings: ["plugin-b"]
  });
  check("多插件每根都复制并写 patch", calls.filter((call) => call[0] === "cp").map((call) => call[2]), [
    "/profile/node_modules/plugin-a",
    "/profile/node_modules/plugin-b"
  ]);
}

{
  const { run, calls } = makeHarness({
    files: {
      "/cache/repo/package.json": JSON.stringify({ name: "../escape", version: "1.0.0" }),
    },
    dirs: ["/cache/repo"],
    overrides: {
      scan: {
        findSkillRoots: async () => [],
        findPluginRoots: async () => ["/cache/repo"],
        findPresetRoots: async () => [],
        readSkillManifest: async () => "",
        needsPluginBuild: async () => false,
      }
    }
  });
  await assert.rejects(() => run({ type: "cordis-plugin" }), /非法包名/);
  check("非法插件名在复制和 patch 前拒绝", calls.some((call) => ["cp", "appendPatchEntry"].includes(call[0])), false);
}

{
  const { run, calls, logs } = makeHarness({
    files: { "/cache/repo/README.md": "x".repeat(4000) },
    dirs: ["/cache/repo"],
  });
  const result = await run({ type: "instructions", repo: "owner/manual" });
  check("manual 返回 instructions 且只读取截断 README", result, { type: "instructions", instructions: true });
  check("manual README 日志限制 3000 字符", logs.find((line) => String(line).startsWith("x"))?.length, 3000);
  check("manual 无安装副作用", calls.some((call) => ["cp", "runScript", "runNpm", "runPnpm", "appendPatchEntry"].includes(call[0])), false);
}

{
  const original = new Error("npm failed");
  const { run, calls } = makeHarness({
    files: {
      "/cache/repo/package.json": JSON.stringify({ name: "broken", version: "1.0.0", dependencies: { dep: "1.0.0" } }),
    },
    dirs: ["/cache/repo"],
    overrides: {
      scan: {
        findSkillRoots: async () => [],
        findPluginRoots: async () => ["/cache/repo"],
        findPresetRoots: async () => [],
        readSkillManifest: async () => "",
        needsPluginBuild: async () => false,
      },
      npmInstallWithFallback: async () => { throw original; },
    }
  });
  await assert.rejects(() => run({ type: "cordis-plugin" }), (error) => error === original);
  check("进程失败保留原错误且不写后续副作用", calls.some((call) => ["cp", "appendPatchEntry"].includes(call[0])), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
