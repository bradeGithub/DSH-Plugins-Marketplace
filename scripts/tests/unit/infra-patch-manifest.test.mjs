import assert from "node:assert/strict";
import { createQueue } from "../../../lib/infra/queue.js";
import { hasPatchEntry } from "../../../lib/domain/validation.js";
import { createPatchManifestAdapter } from "../../../lib/infra/patch-manifest.js";

function createFakeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const writes = [];
  const renames = [];
  let failRename = false;

  return {
    files,
    writes,
    renames,
    setFailRename(value) {
      failRename = value;
    },
    async readFile(path) {
      if (!files.has(path)) {
        const error = new Error(`missing: ${path}`);
        error.code = "ENOENT";
        throw error;
      }
      return files.get(path);
    },
    async writeFile(path, text) {
      writes.push({ path, text });
      files.set(path, text);
    },
    async rename(from, to) {
      renames.push({ from, to });
      if (failRename) {
        failRename = false;
        throw new Error("rename failed");
      }
      if (!files.has(from)) throw new Error(`missing temporary file: ${from}`);
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
}

function createHarness(initial = {}, defaultPath = "profile-a/cordis.patch.yml") {
  const fs = createFakeFs(initial);
  let activePath = defaultPath;
  let defaultPathCalls = 0;
  const adapter = createPatchManifestAdapter({
    fs,
    hasPatchEntry,
    queue: createQueue(),
    defaultPatchPath: () => {
      defaultPathCalls++;
      return activePath;
    },
  });
  return {
    fs,
    adapter,
    setActivePath(path) {
      activePath = path;
    },
    getDefaultPathCalls() {
      return defaultPathCalls;
    },
  };
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

await test("缺失 patch 文件首次追加并使用临时文件原子替换", async () => {
  const { fs, adapter } = createHarness();
  const result = await adapter.appendPatchEntry("demo-entry", "demo/pkg");
  const text = fs.files.get("profile-a/cordis.patch.yml");

  assert.equal(result, true);
  assert.match(text, /^# dsh-plugin-marketplace 自动注册的插件条目\n- insert:\n/m);
  assert.match(text, /    - id: demo-entry\n      name: demo\/pkg\n/);
  assert.deepEqual(fs.renames, [{
    from: "profile-a/cordis.patch.yml.tmp",
    to: "profile-a/cordis.patch.yml",
  }]);
});

await test("重复追加返回 false 且不改变文件字节", async () => {
  const { fs, adapter } = createHarness();
  await adapter.appendPatchEntry("demo-entry", "demo/pkg");
  const before = fs.files.get("profile-a/cordis.patch.yml");
  const writesBefore = fs.writes.length;
  const renamesBefore = fs.renames.length;

  const result = await adapter.appendPatchEntry("different-id", "demo/pkg");

  assert.equal(result, false);
  assert.equal(fs.files.get("profile-a/cordis.patch.yml"), before);
  assert.equal(fs.writes.length, writesBefore);
  assert.equal(fs.renames.length, renamesBefore);
});

await test("追加会清理裸 [] 并为 scoped 保留字符名称加引号", async () => {
  const patchPath = "profile-a/cordis.patch.yml";
  const { fs, adapter } = createHarness({
    [patchPath]: "# existing\n[]\n",
  });

  const result = await adapter.appendPatchEntry("scoped-entry", "@scope/pkg");
  const text = fs.files.get(patchPath);

  assert.equal(result, true);
  assert.doesNotMatch(text, /^\[\]\s*$/m);
  assert.match(text, /- insert:\n    - id: scoped-entry\n      name: "@scope\/pkg"\n/);
});

await test("删除只移除目标块并保留其他插件、skin、注释和手写块", async () => {
  const patchPath = "profile-a/cordis.patch.yml";
  const initial = [
    "# keep this comment",
    "- insert:",
    "    - id: target",
    "      name: target/pkg",
    "",
    "- insert:",
    "    - id: other",
    "      name: other/pkg",
    "",
    "- insert:",
    "    - id: manual",
    "      name: target/pkg # keep manual entry",
    "",
    "- skin:",
    "    name: keep-skin",
    "",
  ].join("\n");
  const { fs, adapter } = createHarness({ [patchPath]: initial });

  const result = await adapter.removePatchEntry("target/pkg");
  const text = fs.files.get(patchPath);

  assert.equal(result, true);
  assert.doesNotMatch(text, /id: target\n\s+name: target\/pkg\n/);
  assert.match(text, /id: other\n\s+name: other\/pkg/);
  assert.match(text, /name: target\/pkg # keep manual entry/);
  assert.match(text, /name: keep-skin/);
  assert.match(text, /# keep this comment/);
});

await test("删除最后一个本插件块后回落为合法空数组", async () => {
  const patchPath = "profile-a/cordis.patch.yml";
  const initial = [
    "# generated",
    "- insert:",
    "    - id: only",
    "      name: only/pkg",
    "",
  ].join("\n");
  const { fs, adapter } = createHarness({ [patchPath]: initial });

  const result = await adapter.removePatchEntry("only/pkg");

  assert.equal(result, true);
  assert.equal(fs.files.get(patchPath), "[]\n");
});

await test("删除不存在的条目不写盘", async () => {
  const patchPath = "profile-a/cordis.patch.yml";
  const initial = "# keep\n- insert:\n    - id: other\n      name: other/pkg\n";
  const { fs, adapter } = createHarness({ [patchPath]: initial });

  const result = await adapter.removePatchEntry("missing/pkg");

  assert.equal(result, false);
  assert.equal(fs.files.get(patchPath), initial);
  assert.equal(fs.writes.length, 0);
  assert.equal(fs.renames.length, 0);
});

await test("默认 profile 路径在每次调用时取得，显式旧 profile 路径不被替换", async () => {
  const oldPath = "profile-old/cordis.patch.yml";
  const { fs, adapter, setActivePath, getDefaultPathCalls } = createHarness();

  await adapter.appendPatchEntry("old-entry", "old/pkg", oldPath);
  assert.equal(fs.files.has(oldPath), true);
  assert.equal(getDefaultPathCalls(), 0);

  setActivePath("profile-new/cordis.patch.yml");
  await adapter.appendPatchEntry("new-entry", "new/pkg");
  assert.equal(fs.files.has("profile-new/cordis.patch.yml"), true);
  assert.equal(getDefaultPathCalls(), 1);
});

await test("共享队列串行追加不会丢条目", async () => {
  const patchPath = "profile-a/cordis.patch.yml";
  const { fs, adapter } = createHarness({ [patchPath]: "[]\n" });

  const results = await Promise.all([
    adapter.appendPatchEntry("one", "one/pkg", patchPath),
    adapter.appendPatchEntry("two", "two/pkg", patchPath),
  ]);
  const text = fs.files.get(patchPath);

  assert.deepEqual(results, [true, true]);
  assert.match(text, /name: one\/pkg/);
  assert.match(text, /name: two\/pkg/);
  assert.equal(fs.renames.length, 2);
});

await test("前序写入失败后队列仍可继续并传播错误", async () => {
  const patchPath = "profile-a/cordis.patch.yml";
  const { fs, adapter } = createHarness({ [patchPath]: "[]\n" });
  fs.setFailRename(true);

  await assert.rejects(
    adapter.appendPatchEntry("failed", "failed/pkg", patchPath),
    /rename failed/
  );
  const result = await adapter.appendPatchEntry("after", "after/pkg", patchPath);

  assert.equal(result, true);
  assert.match(fs.files.get(patchPath), /name: after\/pkg/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
