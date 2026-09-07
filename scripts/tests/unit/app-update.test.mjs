import { createUpdateUseCase } from "../../../lib/app/update.js";

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

const DEST = "/plugins/marketplace";
const STAGING = "/plugins/.dsh-marketplace-staging-abcd";
const BACKUP = "/plugins/.dsh-marketplace-backup-abcd";

function makeUpdate(overrides = {}) {
  const calls = [];
  const logs = [];
  let ownVersion = "1.0.0";
  const options = {
    readOwnVersion: () => ownVersion,
    fetchLatestVersion: async () => "1.2.0",
    fetchLatestFromCache: () => null,
    shouldUpdate: (installed, latest) => latest !== null && installed !== null && latest > installed,
    compareVersions: (a, b) => (a > b ? 1 : a < b ? -1 : 0),
    runDsh: async (args, opts) => calls.push(["dsh", args, opts]),
    runGit: async (args, opts) => calls.push(["git", args, opts]),
    readFile: async () => JSON.stringify({ version: "1.2.0" }),
    exists: async () => true,
    rename: async (from, to) => calls.push(["rename", from, to]),
    rm: async (path) => calls.push(["rm", path]),
    joinPath: (...parts) => parts.join("/"),
    dirnamePath: (p) => p.split("/").slice(0, -1).join("/"),
    randomHex: () => "abcd",
    selfUpdateRepo: "owner/marketplace",
    destRoot: DEST,
    pushLog: (line) => logs.push(line),
    now: () => 1000,
    ...overrides
  };
  return {
    flow: createUpdateUseCase(options),
    calls,
    logs,
    setOwnVersion: (v) => { ownVersion = v; }
  };
}

{
  const { flow } = makeUpdate();
  check("初始状态形态", flow.getState(), {
    installedVersion: null, latestVersion: null, updateAvailable: false, checkedAt: 0, error: null
  });
}

{
  const { flow } = makeUpdate();
  await flow.check();
  check("check 直连成功状态", flow.getState(), {
    installedVersion: "1.0.0", latestVersion: "1.2.0", updateAvailable: true, checkedAt: 1000, error: null
  });
}

{
  const { flow } = makeUpdate({
    fetchLatestVersion: async () => { throw new Error("net down"); },
    fetchLatestFromCache: () => "1.1.0"
  });
  await flow.check();
  check("check 直连失败回退缓存", flow.getState(), {
    installedVersion: "1.0.0", latestVersion: "1.1.0", updateAvailable: true, checkedAt: 1000, error: null
  });
}

{
  const { flow } = makeUpdate({
    fetchLatestVersion: async () => { throw new Error("net down"); }
  });
  await flow.check();
  const state = flow.getState();
  check("check 直连失败无缓存保留旧状态", state.installedVersion, null);
  check("check 直连失败无缓存记录错误", state.error, "net down");
  check("check 直连失败无缓存更新 checkedAt", state.checkedAt, 1000);
}

{
  const { flow } = makeUpdate({
    fetchLatestVersion: async () => null,
    fetchLatestFromCache: () => "1.1.0"
  });
  await flow.check();
  check("check 非 ok 返回 null 回退缓存", flow.getState().latestVersion, "1.1.0");
}

{
  const { flow, calls } = makeUpdate({
    fetchLatestVersion: async () => "1.0.0"
  });
  const result = await flow.run();
  check("run 无更新返回 no-update", result, { status: "no-update", installedVersion: "1.0.0", latestVersion: "1.0.0" });
  check("run 无更新不执行 CLI", calls.filter((c) => c[0] === "dsh"), []);
}

{
  const { flow, calls, setOwnVersion } = makeUpdate({
    runDsh: async (args, opts) => {
      calls.push(["dsh", args, opts]);
      setOwnVersion("1.2.0");
    }
  });
  const result = await flow.run();
  check("run CLI 成功返回 done", result, { status: "done", installedVersion: "1.2.0" });
  check("run CLI 参数固定 web profile", calls.filter((c) => c[0] === "dsh")[0][1], ["plugin", "--profile", "web", "install", "owner/marketplace"]);
}

{
  const { flow } = makeUpdate({
    runDsh: async () => { /* CLI 静默失败，版本未变 */ }
  });
  let threw = null;
  try { await flow.run(); } catch (error) { threw = error.message; }
  check("run CLI 后版本未变抛 verification failed", threw, "self-update verification failed: still v1.0.0");
}

{
  const { flow, calls, logs, setOwnVersion } = makeUpdate({
    runDsh: async () => { throw new Error("cli down"); },
    rename: async (from, to) => {
      calls.push(["rename", from, to]);
      if (to === DEST) setOwnVersion("1.2.0");
    }
  });
  const result = await flow.run();
  check("run CLI 失败回退 clone 成功", result, { status: "done", installedVersion: "1.2.0" });
  check("clone 参数", calls.filter((c) => c[0] === "git")[0][1], ["clone", "--depth", "1", "https://github.com/owner/marketplace.git", STAGING]);
  check("原子替换顺序", calls.filter((c) => c[0] === "rename"), [["rename", DEST, BACKUP], ["rename", STAGING, DEST]]);
  check("回退日志", logs.some((l) => l.includes("官方 CLI 失败")), true);
}

{
  const { flow } = makeUpdate({
    runDsh: async () => { throw new Error("cli down"); },
    readFile: async () => JSON.stringify({ version: "1.0.0" })
  });
  let threw = null;
  try { await flow.run(); } catch (error) { threw = error.message; }
  check("staging 版本不高于当前抛错", threw, "staging version check failed: got v1.0.0, installed v1.0.0");
}

{
  const { flow } = makeUpdate({
    runDsh: async () => { throw new Error("cli down"); },
    exists: async (path) => !path.endsWith("lib/index.js")
  });
  let threw = null;
  try { await flow.run(); } catch (error) { threw = error.message; }
  check("staging 缺核心文件抛错", threw, "staging incomplete: missing lib/index.js");
}

{
  const { flow, calls } = makeUpdate({
    runDsh: async () => { throw new Error("cli down"); },
    rename: async (from, to) => {
      calls.push(["rename", from, to]);
      if (to === DEST) throw new Error("rename denied");
    }
  });
  let threw = null;
  try { await flow.run(); } catch (error) { threw = error.message; }
  check("rename 第二步失败回滚", calls.filter((c) => c[0] === "rename"), [["rename", DEST, BACKUP], ["rename", STAGING, DEST], ["rename", BACKUP, DEST]]);
  check("rename 失败抛原错误", threw, "rename denied");
}

{
  const { flow } = makeUpdate({
    fetchLatestVersion: async () => { throw new Error("net down"); }
  });
  let threw = null;
  try { await flow.run(); } catch (error) { threw = error.message; }
  check("run 直连失败抛 unable to reach", threw, "unable to reach GitHub to check the latest version");
}

{
  const { flow } = makeUpdate({
    fetchLatestVersion: async () => null
  });
  let threw = null;
  try { await flow.run(); } catch (error) { threw = error.message; }
  check("run 直连返回 null 抛 unable to read", threw, "unable to read the latest version from GitHub");
}

{
  const { flow } = makeUpdate();
  flow.closeState({ status: "done", installedVersion: "1.2.0" });
  check("closeState 闭合状态机", flow.getState(), {
    installedVersion: "1.2.0", latestVersion: "1.2.0", updateAvailable: false, checkedAt: 1000, error: null
  });
}

{
  const { flow } = makeUpdate();
  flow.closeState({ status: "done", installedVersion: "1.2.0", latestVersion: "1.3.0" });
  check("closeState 优先用 result.latestVersion", flow.getState().latestVersion, "1.3.0");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
