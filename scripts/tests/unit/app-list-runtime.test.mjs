import assert from "node:assert/strict";
import { createListRuntime } from "../../../lib/app/list-runtime.js";

let clock = 1000;
let calls = 0;
let release;
let rejectLoad = false;
const warnings = [];
const runtime = createListRuntime({
  now: () => clock,
  ttlMs: 100,
  warn: (message) => warnings.push(message),
  loadRegistryRepos: async (kind, force) => {
    calls++;
    if (release) await release;
    if (rejectLoad) throw new Error("load failed");
    return {
      source: kind === "skills" ? "cache" : force ? "search" : "registry",
      repos: [{ full_name: `${kind}/${calls}` }],
    };
  },
});

assert.deepEqual(runtime.getCacheState("dsh"), { at: 0, repos: null, source: "registry" });
const first = await runtime.getList("dsh");
assert.deepEqual(first, [{ full_name: "dsh/1" }]);
assert.equal(await runtime.getList(), first);
assert.equal(calls, 1);
assert.deepEqual(runtime.getCacheState("dsh"), { at: 1000, repos: [{ full_name: "dsh/1" }], source: "registry" });
assert.equal(warnings.length, 0);

clock = 1050;
assert.equal(await runtime.getList("dsh"), first);
assert.equal(calls, 1);
clock = 1100;
assert.equal(await runtime.getList("dsh"), first);
assert.equal(calls, 1);
const detached = runtime.getCacheState("dsh");
detached.repos.push({ full_name: "mutated" });
detached.repos[0].full_name = "mutated-object";
assert.equal(runtime.getCacheState("dsh").repos.length, 1);
assert.equal(runtime.getCacheState("dsh").repos[0].full_name, "dsh/1");

clock = 1101;
assert.deepEqual(await runtime.getList("dsh", true), [{ full_name: "dsh/2" }]);
assert.equal(calls, 2);
assert.equal(runtime.getCacheState("dsh").source, "search");

const skills = await runtime.getList("skills");
assert.deepEqual(skills, [{ full_name: "skills/3" }]);
assert.equal(runtime.getCacheState("skills").source, "cache");
assert.equal(warnings.length, 1);

let gateResolve;
release = new Promise((resolve) => { gateResolve = resolve; });
clock = 1200;
const one = runtime.getList("dsh", true);
const two = runtime.getList("dsh", true);
assert.equal(calls, 4);
gateResolve();
release = null;
await Promise.all([one, two]);
const three = runtime.getList("new-kind", true);
const four = runtime.getList("new-kind", true);
assert.equal(calls, 5);
await Promise.all([one, two, three, four]);
assert.equal((await runtime.getList("new-kind"))[0].full_name, "new-kind/5");

rejectLoad = true;
clock = 1400;
await assert.rejects(() => runtime.getList("dsh", true), /load failed/);
rejectLoad = false;
assert.deepEqual(await runtime.getList("dsh", true), [{ full_name: "dsh/7" }]);

const defaults = createListRuntime({
  loadRegistryRepos: async () => ({ source: "cache", repos: [] }),
});
await defaults.getList("dsh", true);

console.log("\napp/list-runtime: all assertions passed");
