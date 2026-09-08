import { createQueue } from "../../../lib/infra/queue.js";
import { createInstalledState } from "../../../lib/app/installed-state.js";

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

function deferred() {
  let resolve;
  const promise = new Promise((release) => { resolve = release; });
  return { promise, resolve };
}

function makeHarness(initial = null) {
  const calls = [];
  const writes = [];
  let source = initial;
  let writeError = null;
  const state = createInstalledState({
    file: "/tmp/marketplace/installed.json",
    marketRoot: "/tmp/marketplace",
    readStateJson: async (file) => {
      calls.push(["readStateJson", file]);
      return source;
    },
    mkdir: async (...args) => calls.push(["mkdir", ...args]),
    writeFile: async (...args) => {
      calls.push(["writeFile", ...args]);
      if (writeError) throw writeError;
      writes.push(args);
      source = JSON.parse(args[1]);
    },
    queue: createQueue(),
    normalizeRepoRef: (value) => {
      if (typeof value !== "string") return null;
      const trimmed = value.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
      return trimmed.toLowerCase() || null;
    }
  });
  return {
    state,
    calls,
    writes,
    setSource(value) { source = value; },
    setWriteError(error) { writeError = error; }
  };
}

// load keeps normalized keys and does not expose the owner map.
{
  const h = makeHarness({
    "Owner/Repo": { type: "skill", unknown: "kept" },
    "other/tool": { type: "bundle" }
  });
  await h.state.load();
  check("load reads the configured state file", h.calls[0], ["readStateJson", "/tmp/marketplace/installed.json"]);
  check("load normalizes mixed-case repository keys", h.state.has("owner/repo"), true);
  check("get normalizes GitHub URL keys", h.state.get("https://github.com/OWNER/REPO.git"), { type: "skill", unknown: "kept" });
  check("load preserves record fields", h.state.get("owner/repo").unknown, "kept");
  const snapshot = h.state.snapshot();
  snapshot.delete("owner/repo");
  check("snapshot collection is detached", h.state.has("owner/repo"), true);
  const entries = [...h.state.entries()];
  entries.length = 0;
  check("entries iterator is detached", h.state.has("other/tool"), true);
}

// save persists the prospective map before making the record visible.
{
  const h = makeHarness({ "owner/old": { version: "1" } });
  await h.state.load();
  const events = [];
  h.state.onChange((event) => events.push({ ...event, visible: h.state.has(event.key) }));
  await h.state.save("OWNER/New", { version: "2", custom: null });
  check("save writes the normalized key", JSON.parse(h.writes[0][1]), {
    "owner/old": { version: "1" },
    "owner/new": { version: "2", custom: null }
  });
  check("save creates the market root", h.calls.some(([name, path]) => name === "mkdir" && path === "/tmp/marketplace"), true);
  check("save makes record visible after persistence", h.state.get("owner/new"), { version: "2", custom: null });
  check("save notifies after memory commit", events, [{ type: "save", key: "owner/new", record: { version: "2", custom: null }, visible: true }]);
}

// A failed save leaves the previous state and emits no event; the queue recovers.
{
  const h = makeHarness({ "owner/old": { version: "1" } });
  await h.state.load();
  const events = [];
  h.state.onChange((event) => events.push(event.type));
  const error = new Error("write failed");
  h.setWriteError(error);
  let caught;
  try { await h.state.save("owner/new", { version: "2" }); } catch (e) { caught = e; }
  check("failed save propagates the original error", caught === error, true);
  check("failed save does not alter memory", h.state.has("owner/new"), false);
  check("failed save does not notify", events, []);
  h.setWriteError(null);
  await h.state.save("owner/recovered", { version: "3" });
  check("queue continues after failed save", h.state.has("owner/recovered"), true);
}

// remove writes the prospective map first and then removes the record.
{
  const h = makeHarness({ "owner/old": { version: "1" }, "owner/keep": { version: "2" } });
  await h.state.load();
  const events = [];
  h.state.onChange((event) => events.push({ ...event, visible: h.state.has(event.key) }));
  await h.state.remove("https://github.com/OWNER/OLD.git");
  check("remove writes the remaining records", JSON.parse(h.writes[0][1]), { "owner/keep": { version: "2" } });
  check("remove deletes after persistence", h.state.has("owner/old"), false);
  check("remove notifies after memory commit", events, [{ type: "remove", key: "owner/old", record: { version: "1" }, visible: false }]);
}

// Failed remove keeps the record and does not notify.
{
  const h = makeHarness({ "owner/old": { version: "1" } });
  await h.state.load();
  const events = [];
  h.state.onChange((event) => events.push(event.type));
  const error = new Error("remove failed");
  h.setWriteError(error);
  let caught;
  try { await h.state.remove("owner/old"); } catch (e) { caught = e; }
  check("failed remove propagates the original error", caught === error, true);
  check("failed remove keeps memory", h.state.get("owner/old"), { version: "1" });
  check("failed remove does not notify", events, []);
}

// The queue serializes concurrent changes and preserves all committed records.
{
  const active = { count: 0, max: 0 };
  const writes = [];
  const queue = createQueue();
  const firstWriteStarted = deferred();
  const releaseFirstWrite = deferred();
  let writeCount = 0;
  const serialized = createInstalledState({
    file: "/tmp/marketplace/installed.json",
    marketRoot: "/tmp/marketplace",
    readStateJson: async () => ({}),
    mkdir: async () => {},
    writeFile: async (file, text) => {
      active.count++;
      active.max = Math.max(active.max, active.count);
      if (writeCount++ === 0) {
        firstWriteStarted.resolve();
        await releaseFirstWrite.promise;
      }
      writes.push(JSON.parse(text));
      active.count--;
    },
    queue,
    normalizeRepoRef: (value) => String(value ?? "").toLowerCase()
  });
  await serialized.load();
  const saves = [
    serialized.save("a/one", { n: 1 }),
    serialized.save("b/two", { n: 2 }),
    serialized.save("c/three", { n: 3 })
  ];
  await firstWriteStarted.promise;
  releaseFirstWrite.resolve();
  await Promise.all(saves);
  check("concurrent saves are serialized", active.max, 1);
  check("concurrent saves do not lose records", [...serialized.snapshot().keys()].sort(), ["a/one", "b/two", "c/three"]);
  check("each queued save observes the prior committed state", writes.map((data) => Object.keys(data).length), [1, 2, 3]);
}

// onChange can be unsubscribed and a no-op remove does not report a change.
{
  const h = makeHarness({});
  await h.state.load();
  const events = [];
  const unsubscribe = h.state.onChange((event) => events.push(event.type));
  unsubscribe();
  await h.state.save("owner/new", { version: "1" });
  check("unsubscribed listener receives no event", events, []);

  const active = makeHarness({});
  await active.state.load();
  const activeEvents = [];
  active.state.onChange((event) => activeEvents.push(event.type));
  await active.state.remove("owner/missing");
  check("removing a missing record emits no event", activeEvents, []);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
