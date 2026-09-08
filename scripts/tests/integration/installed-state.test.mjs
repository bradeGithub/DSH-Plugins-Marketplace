import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readStateJson } from "../../../lib/infra/store.js";
import { createQueue } from "../../../lib/infra/queue.js";
import { createInstalledState } from "../../../lib/app/installed-state.js";

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const normalizeRepoRef = (value) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
  return trimmed.toLowerCase() || null;
};
const makeState = (file, marketRoot, write = writeFile) => createInstalledState({
  file,
  marketRoot,
  readStateJson,
  mkdir,
  writeFile: write,
  queue: createQueue(),
  normalizeRepoRef,
});

const root = await mkdtemp(join(tmpdir(), "dsh-installed-state-"));
try {
  const file = join(root, "marketplace", "installed.json");
  const marketRoot = join(root, "marketplace");
  const state = makeState(file, marketRoot);
  await state.load();
  check("missing state loads as empty", [...state.snapshot()], []);
  check("missing state creates no corrupt backup", (await readdir(root)).length, 0);

  await state.save("Owner/One", { type: "skill", version: "1.0.0" });
  await state.save("owner/two", { type: "bundle", custom: null });
  check("save persists normalized records", JSON.parse(await readFile(file, "utf8")), {
    "owner/one": { type: "skill", version: "1.0.0" },
    "owner/two": { type: "bundle", custom: null }
  });

  const reloaded = makeState(file, marketRoot);
  await reloaded.load();
  check("reloaded state preserves both records", [...reloaded.snapshot().keys()].sort(), ["owner/one", "owner/two"]);
  await reloaded.remove("https://github.com/OWNER/ONE.git");
  check("remove persists to the real file", JSON.parse(await readFile(file, "utf8")), {
    "owner/two": { type: "bundle", custom: null }
  });

  const corruptFile = join(marketRoot, "corrupt-installed.json");
  await writeFile(corruptFile, "{ broken", "utf8");
  const corruptState = makeState(corruptFile, marketRoot);
  await corruptState.load();
  const corruptBackups = (await readdir(marketRoot)).filter((name) => name.startsWith("corrupt-installed.json.corrupt-"));
  check("corrupt state remains empty after store recovery", corruptState.has("owner/one"), false);
  check("corrupt state gets a recoverable backup", corruptBackups.length > 0, true);

  let failOnce = true;
  const failingState = makeState(file, marketRoot, async (...args) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("transient write failure");
    }
    return await writeFile(...args);
  });
  await failingState.load();
  let caught = null;
  try { await failingState.save("owner/three", { version: "3.0.0" }); } catch (error) { caught = error; }
  check("real write failure propagates", caught?.message, "transient write failure");
  check("real write failure leaves memory unchanged", failingState.has("owner/three"), false);
  await failingState.save("owner/three", { version: "3.0.0" });
  check("real queue recovers after write failure", failingState.has("owner/three"), true);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
