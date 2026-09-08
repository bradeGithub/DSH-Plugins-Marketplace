import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDiagnosticsRuntime } from "../../../lib/app/diagnostics.js";

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

const root = await mkdtemp(join(tmpdir(), "dsh-diagnostics-"));
try {
  const profileNodeModules = join(root, "profile", "node_modules");
  const dshPackage = join(profileNodeModules, "@deepseek-ai", "dsh", "package.json");
  await mkdir(join(profileNodeModules, "@deepseek-ai", "dsh"), { recursive: true });
  await writeFile(dshPackage, JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.1.2-rc.1" }), "utf8");

  let probeCalls = 0;
  const runtime = createDiagnosticsRuntime({
    platform: "integration-platform",
    nodeVersion: "v22.0.0-integration",
    readOwnVersion: () => "1.5.5",
    readFile,
    joinPath: join,
    profileNodeModules: () => profileNodeModules,
    probe: async (command, args) => {
      probeCalls++;
      check(`${command} probe args`, args, ["--version"]);
      return command === "pnpm" ? "9.15.0" : "2.45.0";
    },
    now: () => new Date("2026-09-05T02:03:04.000Z")
  });

  const first = await runtime.buildEnvProfileAsync();
  check("真实 profile package 读取 dsh 版本", first.dsh, "0.1.2-rc.1");
  check("真实临时目录探测结果", [first.pnpm, first.git], ["9.15.0", "2.45.0"]);
  check("首次画像执行两次 probe", probeCalls, 2);

  await writeFile(dshPackage, JSON.stringify({ version: "changed" }), "utf8");
  const cached = await runtime.buildEnvProfileAsync();
  check("画像缓存不重新读取真实 package", cached.dsh, "0.1.2-rc.1");
  check("缓存对象保持同一实例", cached, first);
  check("缓存不重新探测", probeCalls, 2);

  const missing = createDiagnosticsRuntime({
    platform: "integration-platform",
    nodeVersion: "v1",
    readOwnVersion: () => null,
    readFile,
    joinPath: join,
    profileNodeModules: () => join(root, "missing", "node_modules"),
    probe: async () => "missing"
  });
  const missingProfile = await missing.buildEnvProfileAsync();
  check("缺失真实 package 不带 dsh 字段", Object.hasOwn(missingProfile, "dsh"), false);
  check("缺失 package 保留探测结果", [missingProfile.pnpm, missingProfile.git], ["missing", "missing"]);

  const malformedPath = join(root, "malformed", "node_modules", "@deepseek-ai", "dsh");
  await mkdir(malformedPath, { recursive: true });
  await writeFile(join(malformedPath, "package.json"), "{bad", "utf8");
  const malformed = createDiagnosticsRuntime({
    platform: "integration-platform",
    nodeVersion: "v1",
    readOwnVersion: () => "market",
    readFile,
    joinPath: join,
    profileNodeModules: () => join(root, "malformed", "node_modules"),
    probe: async () => "missing"
  });
  check("损坏真实 package 静默省略 dsh", Object.hasOwn(await malformed.buildEnvProfileAsync(), "dsh"), false);

  runtime.pushLog("first");
  const detached = runtime.getRecentLogs();
  detached[0] = "mutated outside";
  detached.push("extra outside");
  check("日志真实运行时快照脱离内部数组", runtime.getRecentLogs(), ["[2026-09-05T02:03:04.000Z] first"]);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
