import { createUninstallUseCase } from "../../../lib/app/uninstall.js";

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

const NM = "/profiles/web/node_modules";
const PATCH = "/profiles/web/cordis.patch.yml";
const PKG = "/profiles/web/package.json";
const SKILLS = "/.dsh/skills";
const PRESETS = "/.dsh/.agent-presets";
const CACHE = "/cache";

function makeUninstall(overrides = {}) {
  const calls = [];
  const logs = [];
  const options = {
    getInstalledRecord: () => null,
    removeInstalled: async (repo) => calls.push(["removeInstalled", repo]),
    resolveRecordNodeModules: (record) => {
      const loc = String(record?.location ?? "");
      const idx = loc.indexOf("/node_modules/");
      return idx >= 0 ? loc.slice(0, idx + "/node_modules".length) : NM;
    },
    profileNodeModules: () => NM,
    profileDir: () => "/profiles/web",
    profilePatchFile: () => PATCH,
    profilePackageFile: () => PKG,
    joinPath: (...parts) => parts.join("/"),
    // 模拟 node:path resolve 的绝对 POSIX 归一化（.. 段折叠），与真实实现一致
    resolvePath: (p) => {
      const parts = [];
      for (const seg of p.split("/")) {
        if (seg === "..") parts.pop();
        else if (seg !== "" && seg !== ".") parts.push(seg);
      }
      return "/" + parts.join("/");
    },
    dirnamePath: (p) => p.split("/").slice(0, -1).join("/"),
    pathSep: "/",
    rm: async (path) => calls.push(["rm", path]),
    runPnpm: async (args, opts) => calls.push(["pnpm", args, opts]),
    buildFilteredEnv: () => ({ FILTERED: "1" }),
    readProfileManifest: async () => null,
    writeProfileManifest: async (manifest, path) => calls.push(["writeManifest", path]),
    removePatchEntry: async (name, patchPath) => calls.push(["patch", name, patchPath]),
    managedDirs: { skillsDir: SKILLS, presetsDir: PRESETS, cacheDir: CACHE },
    removePendingFeedback: (repo) => {
      calls.push(["feedback", repo]);
      return false;
    },
    saveFeedback: async () => calls.push(["saveFeedback"]),
    translate: (_lang, key, params) => {
      if (params?.name !== undefined) return `${key}:${params.name}`;
      if (params?.repo !== undefined) return `${key}:${params.repo}`;
      if (params?.err !== undefined) return `${key}:${params.err}`;
      return key;
    },
    ...overrides
  };
  return {
    flow: createUninstallUseCase(options),
    calls,
    logs,
    run: (input = {}) => createUninstallUseCase(options)({
      repo: "owner/demo",
      log: [],
      logLine: (line) => logs.push(line),
      lang: "en",
      ...input
    })
  };
}

{
  const { run, calls, logs } = makeUninstall();
  const result = await run();
  check("未安装返回 done 且 removed 0", result, { status: "done", repo: "owner/demo", removed: 0, log: [] });
  check("未安装日志", logs, ["uninstallNone"]);
  check("未安装不触碰记录与反馈", calls, []);
}

{
  const { run, calls, logs } = makeUninstall({
    getInstalledRecord: () => ({ type: "skill", location: `${SKILLS}/demo` })
  });
  const result = await run();
  check("skill 删除目录", calls.filter((c) => c[0] === "rm"), [["rm", `${SKILLS}/demo`]]);
  check("skill removed 计数", result.removed, 1);
  check("skill 移除记录与反馈", calls.filter((c) => c[0] !== "rm"), [["removeInstalled", "owner/demo"], ["feedback", "owner/demo"]]);
  check("skill 完成日志", logs.at(-1), "uninstalled");
}

{
  const { run, calls } = makeUninstall({
    getInstalledRecord: () => ({ type: "skill", location: "/etc/passwd" })
  });
  const result = await run();
  check("skill 越界 location 不删", calls.filter((c) => c[0] === "rm"), []);
  check("skill 越界 removed 0", result.removed, 0);
}

{
  const { run, calls } = makeUninstall({
    getInstalledRecord: () => ({ type: "agent-preset", names: ["a", "b"], location: PRESETS })
  });
  const result = await run();
  check("agent-preset 多 names 逐个删", calls.filter((c) => c[0] === "rm"), [["rm", `${PRESETS}/a`], ["rm", `${PRESETS}/b`]]);
  check("agent-preset removed 计数", result.removed, 2);
}

{
  const { run, calls } = makeUninstall({
    getInstalledRecord: () => ({ type: "agent-preset", names: ["a", "../evil"], location: PRESETS })
  });
  const result = await run();
  check("agent-preset 越界 name 跳过", calls.filter((c) => c[0] === "rm"), [["rm", `${PRESETS}/a`]]);
  check("agent-preset 越界 removed 计数", result.removed, 1);
}

{
  const { run, calls } = makeUninstall({
    getInstalledRecord: () => ({ type: "cordis-plugin", name: "demo-plugin", location: `${NM}/demo-plugin` })
  });
  const result = await run();
  check("cordis 单 name 删目录", calls.filter((c) => c[0] === "rm"), [["rm", `${NM}/demo-plugin`]]);
  check("cordis 单 name 清 patch", calls.filter((c) => c[0] === "patch"), [["patch", "demo-plugin", PATCH]]);
  check("cordis removed 计数", result.removed, 1);
}

{
  const { run, calls } = makeUninstall({
    getInstalledRecord: () => ({ type: "cordis-plugin", names: ["p1", "p2"], location: `${NM}/p1` })
  });
  const result = await run();
  check("cordis names 数组逐个删", calls.filter((c) => c[0] === "rm"), [["rm", `${NM}/p1`], ["rm", `${NM}/p2`]]);
  check("cordis names 数组逐个清 patch", calls.filter((c) => c[0] === "patch"), [["patch", "p1", PATCH], ["patch", "p2", PATCH]]);
  check("cordis names removed 计数", result.removed, 2);
}

{
  const { run, calls } = makeUninstall({
    getInstalledRecord: () => ({ type: "cordis-plugin", name: "awesome-plugins", location: `${NM}/awesome-plugins` })
  });
  const result = await run();
  check("-plugins 后缀放弃 name 走 location 推断", calls.filter((c) => c[0] === "rm"), [["rm", `${NM}/awesome-plugins`]]);
  check("-plugins 推断 removed 计数", result.removed, 1);
}

{
  const { run, calls, logs } = makeUninstall({
    getInstalledRecord: () => ({ type: "cordis-plugin", name: "awesome-plugins", location: "/elsewhere" })
  });
  const result = await run();
  check("无 targets 不删目录", calls.filter((c) => c[0] === "rm"), []);
  check("无 targets 日志", logs.includes("uninstallNoTargets"), true);
  check("无 targets removed 0", result.removed, 0);
}

{
  const { run, calls } = makeUninstall({
    getInstalledRecord: () => ({ type: "cordis-plugin", name: "../evil", location: `${NM}/demo-plugin` })
  });
  const result = await run();
  check("cordis 越界包名不删", calls.filter((c) => c[0] === "rm"), []);
  check("cordis 越界包名 removed 0", result.removed, 0);
}

{
  const { run, calls, logs } = makeUninstall({
    getInstalledRecord: () => ({ type: "bundle", bundle: true, name: "b1", location: `${NM}/b1` })
  });
  const result = await run();
  check("bundle pnpm remove 参数", calls.filter((c) => c[0] === "pnpm"), [["pnpm", ["remove", "--ignore-workspace", "b1"], { cwd: "/profiles/web", env: { FILTERED: "1" }, timeout: 600000 }]]);
  check("bundle removed 计数", result.removed, 1);
  check("bundle 无降级日志", logs.some((l) => l.startsWith("uninstallBundleDegraded")), false);
}

{
  const { run, calls, logs } = makeUninstall({
    getInstalledRecord: () => ({ type: "bundle", bundle: true, name: "b1", location: `${NM}/b1` }),
    runPnpm: async () => { throw new Error("pnpm down"); },
    readProfileManifest: async () => ({
      dependencies: { b1: "1.0.0", keep: "2.0.0" },
      dsh: { profile: { bundles: ["b1", "keep"] } }
    })
  });
  const result = await run();
  check("bundle 降级写 manifest", calls.filter((c) => c[0] === "writeManifest"), [["writeManifest", PKG]]);
  check("bundle 降级删目录", calls.filter((c) => c[0] === "rm"), [["rm", `${NM}/b1`]]);
  check("bundle 降级日志", logs.some((l) => l.startsWith("uninstallBundleDegraded:b1")), true);
  check("bundle 降级 removed 0", result.removed, 0);
}

{
  const { run, calls } = makeUninstall({
    getInstalledRecord: () => ({ type: "bundle", bundle: true, name: "b1", location: `${NM}/b1` }),
    runPnpm: async () => { throw new Error("pnpm down"); },
    readProfileManifest: async () => ({ dependencies: { keep: "2.0.0" } })
  });
  await run();
  check("bundle 降级 manifest 无变化不写", calls.filter((c) => c[0] === "writeManifest"), []);
}

{
  const { run, calls, logs } = makeUninstall({
    getInstalledRecord: () => ({ type: "script", location: `${CACHE}/owner__demo` })
  });
  const result = await run();
  check("script 删克隆缓存", calls.filter((c) => c[0] === "rm"), [["rm", `${CACHE}/owner__demo`]]);
  check("script 日志", logs.includes("uninstallScriptNote"), true);
  check("script removed 0", result.removed, 0);
}

{
  const { run, calls } = makeUninstall({
    getInstalledRecord: () => ({ type: "script", location: "/tmp/evil" })
  });
  await run();
  check("script 越界 location 不删", calls.filter((c) => c[0] === "rm"), []);
}

{
  const { run, calls, logs } = makeUninstall({
    getInstalledRecord: () => ({ type: "cordis-plugin", name: "demo-plugin", location: `${NM}/demo-plugin` }),
    rm: async () => { throw new Error("rm denied"); }
  });
  const result = await run();
  check("rm 失败记录日志", logs.some((l) => l.startsWith("uninstallRmFail:demo-plugin")), true);
  check("rm 失败仍清 patch", calls.filter((c) => c[0] === "patch"), [["patch", "demo-plugin", PATCH]]);
  check("rm 失败 removed 0", result.removed, 0);
}

{
  const { run, logs } = makeUninstall({
    getInstalledRecord: () => ({ type: "cordis-plugin", name: "demo-plugin", location: `${NM}/demo-plugin` }),
    removePatchEntry: async () => { throw new Error("patch busy"); }
  });
  await run();
  check("patch 失败记录日志", logs.some((l) => l.startsWith("uninstallPatchFail:demo-plugin")), true);
}

{
  const { run, calls } = makeUninstall({
    getInstalledRecord: () => ({ type: "cordis-plugin", name: "old-plugin", location: "/profiles/old/node_modules/old-plugin" }),
    resolveRecordNodeModules: () => "/profiles/old/node_modules"
  });
  await run();
  check("跨 profile 卸载用旧 profile patch 文件", calls.filter((c) => c[0] === "patch"), [["patch", "old-plugin", "/profiles/old/cordis.patch.yml"]]);
}

{
  const { run, calls } = makeUninstall({
    getInstalledRecord: () => ({ type: "bundle", bundle: true, name: "b1", location: "/profiles/old/node_modules/b1" }),
    resolveRecordNodeModules: () => "/profiles/old/node_modules"
  });
  await run();
  check("跨 profile bundle pnpm cwd 用旧 profile", calls.filter((c) => c[0] === "pnpm")[0][2].cwd, "/profiles/old");
}

{
  const { run, calls } = makeUninstall({
    getInstalledRecord: () => ({ type: "skill", location: `${SKILLS}/demo` }),
    removePendingFeedback: (repo) => {
      calls.push(["feedback", repo]);
      return true;
    }
  });
  await run();
  check("feedback 有变化时保存", calls.filter((c) => c[0] === "saveFeedback"), [["saveFeedback"]]);
}

{
  const { run, calls } = makeUninstall({
    getInstalledRecord: () => ({ type: "skill", location: `${SKILLS}/demo` })
  });
  await run();
  check("feedback 无变化不保存", calls.filter((c) => c[0] === "saveFeedback"), []);
}

{
  const { run, logs } = makeUninstall({
    getInstalledRecord: () => ({ type: "skill", location: `${SKILLS}/demo` }),
    removeInstalled: async () => { throw new Error("index broken"); }
  });
  const result = await run();
  check("异常返回 failed", result.status, "failed");
  check("异常日志", logs.some((l) => l.startsWith("uninstallFail")), true);
}

{
  const { run, calls } = makeUninstall({
    getInstalledRecord: () => ({ type: "cli", name: "dshmarket", location: `${NM}/dshmarket` })
  });
  const result = await run();
  check("cli 类型同 cordis 清理", calls.filter((c) => c[0] === "rm"), [["rm", `${NM}/dshmarket`]]);
  check("cli removed 计数", result.removed, 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
