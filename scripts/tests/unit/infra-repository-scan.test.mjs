import assert from "node:assert/strict";
import { createRepositoryScanAdapter } from "../../../lib/infra/repository-scan.js";

const file = (name) => ({
  name,
  isFile: () => true,
  isDirectory: () => false,
  isSymbolicLink: () => false,
});
const dir = (name) => ({
  name,
  isFile: () => false,
  isDirectory: () => true,
  isSymbolicLink: () => false,
});
const symlink = (name) => ({
  name,
  isFile: () => false,
  isDirectory: () => false,
  isSymbolicLink: () => true,
});

function createFakeFs(tree, files = {}) {
  const calls = [];
  return {
    calls,
    async readdir(path, options) {
      calls.push(["readdir", path, options]);
      if (!Object.hasOwn(tree, path)) throw new Error(`missing directory: ${path}`);
      const entries = tree[path];
      return options?.withFileTypes ? entries : entries.map((entry) => entry.name);
    },
    async readFile(path, encoding) {
      calls.push(["readFile", path, encoding]);
      if (!Object.hasOwn(files, path)) throw new Error(`missing file: ${path}`);
      if (files[path] instanceof Error) throw files[path];
      return files[path];
    },
  };
}

function createAdapter(tree, files, overrides = {}) {
  const fs = createFakeFs(tree, files);
  const adapter = createRepositoryScanAdapter({
    fs,
    path: { joinPath: (base, child) => `${base}/${child}` },
    looksLikeDshPlugin: (pkg) =>
      pkg?.dsh === true || (pkg?.dsh === "truthy-but-not-true" && "truthy"),
    ...overrides,
  });
  return { adapter, calls: fs.calls };
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

await test("skill 根命中后停止向下并按大小写识别清单", async () => {
  const { adapter } = createAdapter({
    repo: [file("sKiLl.Md"), dir("nested")],
    "repo/nested": [file("SKILL.md")],
  });
  assert.deepEqual(await adapter.findSkillRoots("repo"), ["repo"]);
});

await test("skill 扫描跳过隐藏、依赖、vendored 和符号链接目录", async () => {
  const { adapter } = createAdapter({
    repo: [dir("good"), dir(".hidden"), dir("node_modules"), dir("upstream"), dir("vendor"), symlink("outside")],
    "repo/good": [file("SKILL.md")],
    "repo/.hidden": [file("SKILL.md")],
    "repo/node_modules": [file("SKILL.md")],
    "repo/upstream": [file("SKILL.md")],
    "repo/vendor": [file("SKILL.md")],
  });
  assert.deepEqual(await adapter.findSkillRoots("repo"), ["repo/good"]);
});

await test("skill 深度和数量上限生效", async () => {
  const { adapter } = createAdapter({
    repo: [dir("a"), dir("b")],
    "repo/a": [dir("deep")],
    "repo/b": [file("SKILL.md")],
    "repo/a/deep": [file("SKILL.md")],
  });
  assert.deepEqual(await adapter.findSkillRoots("repo", 1), ["repo/b"]);
  assert.deepEqual(await adapter.findSkillRoots("repo", 2, 1), ["repo/a/deep"]);
});

await test("skill 目录读取失败时跳过该分支", async () => {
  const { adapter } = createAdapter({
    repo: [dir("missing"), dir("good")],
    "repo/good": [file("SKILL.md")],
  });
  assert.deepEqual(await adapter.findSkillRoots("repo"), ["repo/good"]);
});

await test("plugin 只收录严格通过领域判定的清单并停止向下", async () => {
  const { adapter } = createAdapter(
    {
      repo: [dir("packages"), dir("plain"), dir(".hidden"), dir("node_modules")],
      "repo/packages": [dir("one"), dir("two")],
      "repo/packages/one": [file("package.json"), dir("nested")],
      "repo/packages/one/nested": [file("package.json")],
      "repo/packages/two": [file("package.json")],
      "repo/plain": [file("package.json"), dir("child")],
      "repo/plain/child": [file("package.json")],
      "repo/.hidden": [file("package.json")],
      "repo/node_modules": [file("package.json")],
    },
    {
      "repo/packages/one/package.json": JSON.stringify({ dsh: true }),
      "repo/packages/one/nested/package.json": JSON.stringify({ dsh: true }),
      "repo/packages/two/package.json": JSON.stringify({ dsh: true }),
      "repo/plain/package.json": JSON.stringify({ dsh: "truthy-but-not-true" }),
      "repo/plain/child/package.json": JSON.stringify({ dsh: true }),
      "repo/.hidden/package.json": JSON.stringify({ dsh: true }),
      "repo/node_modules/package.json": JSON.stringify({ dsh: true }),
    },
  );
  assert.deepEqual(await adapter.findPluginRoots("repo"), ["repo/packages/one", "repo/packages/two", "repo/plain/child"]);
});

await test("plugin 坏 JSON 忽略后继续扫描，深度和数量上限生效", async () => {
  const { adapter } = createAdapter(
    {
      repo: [dir("broken"), dir("a"), dir("b")],
      "repo/broken": [file("package.json"), dir("child")],
      "repo/broken/child": [file("package.json")],
      "repo/a": [file("package.json")],
      "repo/b": [file("package.json")],
    },
    {
      "repo/broken/package.json": "{bad",
      "repo/broken/child/package.json": JSON.stringify({ dsh: true }),
      "repo/a/package.json": JSON.stringify({ dsh: true }),
      "repo/b/package.json": JSON.stringify({ dsh: true }),
    },
  );
  assert.deepEqual(await adapter.findPluginRoots("repo", 1, 1), ["repo/a"]);
  assert.deepEqual(await adapter.findPluginRoots("repo"), ["repo/broken/child", "repo/a", "repo/b"]);
});

await test("preset 必须同时含两个精确文件且命中后停止向下", async () => {
  const { adapter } = createAdapter({
    repo: [dir("complete"), dir("partial"), dir(".hidden"), dir("node_modules")],
    "repo/complete": [file("preset.yml"), file("agent.cordis.yml"), dir("nested")],
    "repo/complete/nested": [file("preset.yml"), file("agent.cordis.yml")],
    "repo/partial": [file("preset.yml"), dir("child")],
    "repo/partial/child": [file("preset.yml"), file("agent.cordis.yml")],
    "repo/.hidden": [file("preset.yml"), file("agent.cordis.yml")],
    "repo/node_modules": [file("preset.yml"), file("agent.cordis.yml")],
  });
  assert.deepEqual(await adapter.findPresetRoots("repo"), ["repo/complete", "repo/partial/child"]);
});

await test("manifest 使用实际大小写文件名并在枚举失败时回退", async () => {
  const first = createAdapter({ repo: [file("sKiLl.Md")] }, { "repo/sKiLl.Md": "first" });
  assert.equal(await first.adapter.readSkillManifest("repo"), "first");
  assert.deepEqual(first.calls.at(-1), ["readFile", "repo/sKiLl.Md", "utf8"]);

  const second = createAdapter({}, { "repo/SKILL.md": "fallback" });
  assert.equal(await second.adapter.readSkillManifest("repo"), "fallback");
});

await test("manifest 文件读取失败继续传播原错误", async () => {
  const error = new Error("read failed");
  const { adapter } = createAdapter({}, { "repo/SKILL.md": error });
  await assert.rejects(() => adapter.readSkillManifest("repo"), error);
});

await test("lifecycle 只返回允许脚本且保持固定顺序", async () => {
  const { adapter } = createAdapter({}, {
    "repo/package.json": JSON.stringify({
      scripts: {
        prepare: "prepare",
        postinstall: "postinstall",
        install: "install",
        preinstall: "preinstall",
        test: "test",
        empty: "",
        object: {},
      },
    }),
  });
  assert.deepEqual(await adapter.readLifecycleScripts("repo"), ["preinstall", "install", "postinstall", "prepare"]);
});

await test("lifecycle 允许键的空字符串被过滤", async () => {
  const { adapter } = createAdapter({}, {
    "repo/package.json": JSON.stringify({
      scripts: {
        preinstall: "ok",
        prepare: "",
      },
    }),
  });
  assert.deepEqual(await adapter.readLifecycleScripts("repo"), ["preinstall"]);
});

await test("lifecycle 缺失、坏 JSON 和读取失败均返回空数组", async () => {
  const missing = createAdapter({}, {});
  assert.deepEqual(await missing.adapter.readLifecycleScripts("repo"), []);
  const malformed = createAdapter({}, { "repo/package.json": "{bad" });
  assert.deepEqual(await malformed.adapter.readLifecycleScripts("repo"), []);
  const failed = createAdapter({}, { "repo/package.json": new Error("read failed") });
  assert.deepEqual(await failed.adapter.readLifecycleScripts("repo"), []);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
