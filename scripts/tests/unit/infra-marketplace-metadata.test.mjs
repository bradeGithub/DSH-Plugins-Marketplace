import assert from "node:assert/strict";
import { createMarketplaceMetadataAdapter } from "../../../lib/infra/marketplace-metadata.js";

const fallback = new Set(["@deepseek-ai/cordis", "@deepseek-ai/Fallback"]);

function makeAdapter(overrides = {}) {
  const calls = [];
  const files = new Map();
  const options = {
    fs: {
      async readFile(path, encoding) {
        calls.push(["readFile", path, encoding]);
        if (!files.has(path)) throw new Error("missing package");
        return files.get(path);
      },
      async readdir(path, options) {
        calls.push(["readdir", path, options]);
        return [
          { name: "Cordis", isDirectory: () => true },
          { name: "dsh-web", isDirectory: () => true },
          { name: "not-a-package", isDirectory: () => false },
        ];
      },
    },
    path: {
      dirnamePath: (value) => value.slice(0, value.lastIndexOf("/")),
      joinPath: (base, child) => `${base}/${child}`,
    },
    resolveCorePackage: () => "/node_modules/@deepseek-ai/cordis/index.js",
    ownPackagePath: "/marketplace/package.json",
    officialFallback: fallback,
    ...overrides,
  };
  const adapter = createMarketplaceMetadataAdapter(options);
  return { adapter, calls, files };
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

await test("官方包集合合并 fallback 与 scope 枚举并统一小写", async () => {
  const { adapter, calls } = makeAdapter();
  const result = await adapter.loadOfficialPackages();
  assert.equal(result.has("@deepseek-ai/cordis"), true);
  assert.equal(result.has("@deepseek-ai/fallback"), true);
  assert.equal(result.has("@deepseek-ai/dsh-web"), true);
  assert.equal(result.has("@deepseek-ai/not-a-package"), false);
  assert.equal(calls.filter(([name]) => name === "readdir").length, 1);
});

await test("官方包缓存命中时不重复解析或枚举", async () => {
  const { adapter, calls } = makeAdapter();
  const first = await adapter.loadOfficialPackages();
  const second = await adapter.loadOfficialPackages();
  assert.equal(first, second);
  assert.equal(calls.filter(([name]) => name === "readdir").length, 1);
});

await test("官方包解析失败时回退 fallback 且仍缓存结果", async () => {
  let resolves = 0;
  const { adapter, calls } = makeAdapter({
    resolveCorePackage: () => {
      resolves++;
      throw new Error("core package unavailable");
    },
  });
  const first = await adapter.loadOfficialPackages();
  const second = await adapter.loadOfficialPackages();
  assert.equal(first.has("@deepseek-ai/fallback"), true);
  assert.equal(first.has("@deepseek-ai/dsh-web"), false);
  assert.equal(first, second);
  assert.equal(resolves, 1);
  assert.equal(calls.filter(([name]) => name === "readdir").length, 0);
});

await test("isOfficialPackage 使用小写匹配并拒绝空值", async () => {
  const { adapter } = makeAdapter();
  assert.equal(await adapter.isOfficialPackage("@DEEPSEEK-AI/CORDIS"), true);
  assert.equal(await adapter.isOfficialPackage("community/plugin"), false);
  assert.equal(await adapter.isOfficialPackage(null), false);
});

await test("own repository 支持字符串 URL 并成功结果缓存", async () => {
  const { adapter, calls, files } = makeAdapter();
  files.set("/marketplace/package.json", JSON.stringify({ repository: "https://github.com/Owner/Repo.git" }));
  const first = await adapter.loadOwnRepo();
  const second = await adapter.loadOwnRepo();
  assert.equal(first, "owner/repo");
  assert.equal(second, first);
  assert.equal(calls.filter(([name]) => name === "readFile").length, 1);
});

await test("own repository 支持 object URL 与无效输入", async () => {
  const object = makeAdapter();
  object.files.set("/marketplace/package.json", JSON.stringify({ repository: { url: "https://github.com/Owner/Object.git" } }));
  assert.equal(await object.adapter.loadOwnRepo(), "owner/object");

  const invalid = makeAdapter();
  invalid.files.set("/marketplace/package.json", JSON.stringify({ repository: 42 }));
  assert.equal(await invalid.adapter.loadOwnRepo(), null);
  assert.equal(invalid.calls.filter(([name]) => name === "readFile").length, 1);
});

await test("own repository 读取失败返回 null，下一次调用保持既有重试语义", async () => {
  let reads = 0;
  const { adapter } = makeAdapter({
    fs: {
      async readFile() {
        reads++;
        throw new Error("package read failed");
      },
      async readdir() { return []; },
    },
  });
  assert.equal(await adapter.loadOwnRepo(), null);
  assert.equal(await adapter.loadOwnRepo(), null);
  assert.equal(reads, 2);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
