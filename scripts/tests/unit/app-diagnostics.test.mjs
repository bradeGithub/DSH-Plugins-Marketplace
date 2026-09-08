import assert from "node:assert/strict";
import { createDiagnosticsRuntime } from "../../../lib/app/diagnostics.js";

let readCalls = 0;
let probeCalls = [];
const runtime = createDiagnosticsRuntime({
  platform: "test-platform",
  nodeVersion: "v22.0.0-test",
  readOwnVersion: () => "1.5.5",
  readFile: async (path) => {
    readCalls++;
    assert.equal(path, "/profile/node_modules/@deepseek-ai/dsh/package.json");
    return JSON.stringify({ version: "0.1.2-rc.1" });
  },
  joinPath: (...parts) => parts.join("/"),
  profileNodeModules: () => "/profile/node_modules",
  probe: async (command, args) => {
    probeCalls.push([command, args]);
    return `${command}-version`;
  },
  now: () => new Date("2026-09-05T00:00:00.000Z")
});

assert.deepEqual(runtime.buildEnvProfile(), {
  platform: "test-platform",
  node: "v22.0.0-test",
  market: "1.5.5"
});
assert.equal(readCalls, 0);
assert.deepEqual(probeCalls, []);

const profile = await runtime.buildEnvProfileAsync();
assert.deepEqual(profile, {
  platform: "test-platform",
  node: "v22.0.0-test",
  market: "1.5.5",
  dsh: "0.1.2-rc.1",
  pnpm: "pnpm-version",
  git: "git-version"
});
assert.equal(readCalls, 1);
assert.deepEqual(probeCalls, [["pnpm", ["--version"]], ["git", ["--version"]]]);
assert.equal(await runtime.buildEnvProfileAsync(), profile);
assert.equal(runtime.buildEnvProfile(), profile);
assert.equal(readCalls, 1);
assert.equal(probeCalls.length, 2);

const missingPackage = createDiagnosticsRuntime({
  platform: "test",
  nodeVersion: "v1",
  readOwnVersion: () => null,
  readFile: async () => { throw new Error("ENOENT"); },
  joinPath: (...parts) => parts.join("/"),
  profileNodeModules: () => "/missing/node_modules",
  probe: async () => "missing"
});
assert.deepEqual(await missingPackage.buildEnvProfileAsync(), {
  platform: "test",
  node: "v1",
  market: "unknown",
  pnpm: "missing",
  git: "missing"
});

const malformedPackage = createDiagnosticsRuntime({
  platform: "test",
  nodeVersion: "v1",
  readOwnVersion: () => "market",
  readFile: async () => "{bad json",
  joinPath: (...parts) => parts.join("/"),
  profileNodeModules: () => "/bad/node_modules",
  probe: async () => "ok"
});
assert.equal((await malformedPackage.buildEnvProfileAsync()).dsh, undefined);

const logs = createDiagnosticsRuntime({
  platform: "test",
  nodeVersion: "v1",
  readOwnVersion: () => "market",
  readFile: async () => "{}",
  joinPath: (...parts) => parts.join("/"),
  profileNodeModules: () => "/profile/node_modules",
  probe: async () => "missing",
  now: () => new Date("2026-09-05T01:02:03.000Z")
});
logs.pushLog(null);
logs.pushLog("x".repeat(5000));
let snapshot = logs.getRecentLogs();
assert.equal(snapshot.length, 2);
assert.equal(snapshot[0], "[2026-09-05T01:02:03.000Z] ");
assert.equal(snapshot[1].includes("x".repeat(4096)), true);
assert.equal(snapshot[1].includes("x".repeat(4097)), false);
snapshot[0] = "changed";
snapshot.push("outside");
assert.equal(logs.getRecentLogs()[0], "[2026-09-05T01:02:03.000Z] ");
assert.equal(logs.getRecentLogs().length, 2);

const capacity = createDiagnosticsRuntime({
  platform: "test",
  nodeVersion: "v1",
  readOwnVersion: () => "market",
  readFile: async () => "{}",
  joinPath: (...parts) => parts.join("/"),
  profileNodeModules: () => "/profile/node_modules",
  probe: async () => "missing",
  now: () => new Date("2026-09-05T01:02:03.000Z")
});
for (let i = 0; i < 400; i++) capacity.pushLog(`capacity-${i}`);
assert.equal(capacity.getRecentLogs().length, 400);
assert.equal(capacity.getRecentLogs()[0].endsWith("capacity-0"), true);
capacity.pushLog("capacity-400");
assert.equal(capacity.getRecentLogs()[0].endsWith("capacity-1"), true);

for (let i = 0; i < 401; i++) logs.pushLog(`line-${i}`);
snapshot = logs.getRecentLogs();
assert.equal(snapshot.length, 400);
assert.equal(snapshot[0].endsWith("line-1"), true);
assert.equal(snapshot.at(-1).endsWith("line-400"), true);

// ---- 结构化事件环 ----
const events = createDiagnosticsRuntime({
  platform: "test",
  nodeVersion: "v1",
  readOwnVersion: () => "market",
  readFile: async () => "{}",
  joinPath: (...parts) => parts.join("/"),
  profileNodeModules: () => "/profile/node_modules",
  probe: async () => "missing",
  now: () => new Date("2026-09-05T02:03:04.000Z")
});
events.pushEvent({ event: "install.done", message: "a/b done" });
events.pushEvent({ event: "install.failed", level: "error", error_code: "install_failed", message: "boom" });
events.pushEvent({ event: "self_update.done", trace_id: "trace-1", duration_ms: 12.5 });
let eventSnapshot = events.getRecentEvents();
assert.equal(eventSnapshot.length, 3);
assert.deepEqual(eventSnapshot[0], {
  event: "install.done",
  level: "info",
  error_code: null,
  trace_id: null,
  duration_ms: null,
  message: "a/b done",
  at: "2026-09-05T02:03:04.000Z"
});
assert.equal(eventSnapshot[1].level, "error");
assert.equal(eventSnapshot[1].error_code, "install_failed");
assert.equal(eventSnapshot[2].trace_id, "trace-1");
assert.equal(eventSnapshot[2].duration_ms, 12.5);
eventSnapshot[0].message = "mutated";
eventSnapshot.push({ event: "outside" });
assert.equal(events.getRecentEvents()[0].message, "a/b done");
assert.equal(events.getRecentEvents().length, 3);

const eventCapacity = createDiagnosticsRuntime({
  platform: "test",
  nodeVersion: "v1",
  readOwnVersion: () => "market",
  readFile: async () => "{}",
  joinPath: (...parts) => parts.join("/"),
  profileNodeModules: () => "/profile/node_modules",
  probe: async () => "missing",
  now: () => new Date("2026-09-05T02:03:04.000Z")
});
for (let i = 0; i < 401; i++) eventCapacity.pushEvent({ event: `e-${i}` });
assert.equal(eventCapacity.getRecentEvents().length, 400);
assert.equal(eventCapacity.getRecentEvents()[0].event, "e-1");
assert.equal(eventCapacity.getRecentEvents().at(-1).event, "e-400");

// ---- 事件字段边界归一化 ----
const edge = createDiagnosticsRuntime({
  platform: "test",
  nodeVersion: "v1",
  readOwnVersion: () => "market",
  readFile: async () => "{}",
  joinPath: (...parts) => parts.join("/"),
  profileNodeModules: () => "/profile/node_modules",
  probe: async () => "missing",
  now: () => new Date("2026-09-05T03:04:05.000Z")
});
edge.pushEvent({ event: "install.done", duration_ms: "12.5" }); // 字符串数字 → Number
edge.pushEvent({ event: "install.failed", duration_ms: "abc" }); // 非数字 → NaN
edge.pushEvent({ event: "x", level: 42, error_code: 7, trace_id: 9 }); // 非字符串 → String
edge.pushEvent({ event: "long", message: "m".repeat(5000) }); // 超长 message → 截断
const edgeEvents = edge.getRecentEvents();
assert.equal(edgeEvents[0].duration_ms, 12.5);
assert.equal(Number.isNaN(edgeEvents[1].duration_ms), true);
assert.equal(edgeEvents[2].level, "42");
assert.equal(edgeEvents[2].error_code, "7");
assert.equal(edgeEvents[2].trace_id, "9");
assert.equal(edgeEvents[3].message.length, 4096);
assert.equal(edgeEvents[3].message.includes("m".repeat(4097)), false);

console.log("\napp/diagnostics: all assertions passed");
