import assert from "node:assert/strict";
import { gzipSync, gunzipSync } from "node:zlib";
import { createRegistryCacheAdapter } from "../../../lib/infra/registry-cache.js";

const limits = {
  maxResponseBytes: 4096,
  registryMaxAgeMs: 100,
  pageSize: 2,
  maxPages: 3,
};

function response(body, { status = 200, contentLength = null } = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return name === "content-length" && contentLength !== null ? String(contentLength) : null;
      },
    },
    arrayBuffer: async () => bytes,
    text: async () => bytes.toString("utf8"),
    json: async () => JSON.parse(bytes.toString("utf8")),
  };
}

function createFakeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const writes = [];
  const renames = [];
  const mkdirs = [];
  let failWrite = false;
  let failRename = false;

  return {
    files,
    writes,
    renames,
    mkdirs,
    setFailWrite(value) {
      failWrite = value;
    },
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
    async mkdir(path, options) {
      mkdirs.push({ path, options });
    },
    async writeFile(path, text) {
      if (failWrite) {
        failWrite = false;
        throw new Error("write failed");
      }
      writes.push({ path, text });
      files.set(path, text);
    },
    async rename(from, to) {
      if (failRename) {
        failRename = false;
        throw new Error("rename failed");
      }
      renames.push({ from, to });
      if (!files.has(from)) throw new Error(`missing temporary file: ${from}`);
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
}

function repo(fullName, extra = {}) {
  const name = fullName.split("/")[1];
  return {
    full_name: fullName,
    name,
    description: "description",
    html_url: `https://github.com/${fullName}`,
    stargazers_count: 1,
    updated_at: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

function createHarness(options = {}) {
  const now = { value: 1000 };
  const calls = [];
  const fs = createFakeFs(options.files);
  const cacheFile = (kind) => `cache/${kind}.json`;
  const bundledFile = (kind) => `bundle/${kind}.json`;
  const registrySources = options.registrySources ?? ((kind) => [
    { url: `registry/${kind}.json` },
  ]);
  const fetchImpl = options.fetchImpl ?? (async () => {
    throw new Error("unexpected registry fetch");
  });
  const fetchJson = options.fetchJson ?? (async () => ({ items: [] }));
  const normalizeRepo = options.normalizeRepo ?? ((value) => ({ ...value }));
  const configuredLimits = { ...limits, ...(options.limits ?? {}) };
  const adapter = createRegistryCacheAdapter({
    fetchImpl,
    fetchJson,
    readBodyLimited: async (res) => {
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > configuredLimits.maxResponseBytes) throw new Error("body too large");
      return bytes;
    },
    responseTooLarge: (res) => Number(res.headers.get("content-length") ?? 0) > configuredLimits.maxResponseBytes,
    gunzip: (bytes, gunzipOptions) => {
      calls.push(["gunzip", gunzipOptions]);
      return options.gunzip ? options.gunzip(bytes, gunzipOptions) : gunzipSync(bytes, gunzipOptions);
    },
    timeoutSignal: () => "test-timeout",
    fs,
    clock: { now: () => now.value },
    limits: configuredLimits,
    paths: { cacheFile, bundledFile, cacheDir: "cache" },
    normalizeRepo,
    excludedRepoNames: new Set(["deepseek-harness"]),
    registrySources,
    searchQueries: options.searchQueries ?? { dsh: ["topic:dsh-plugin"], skills: ["topic:agent-skills"] },
    getGithubToken: options.getGithubToken ?? (() => "test-token"),
  });
  return { adapter, fs, now, calls };
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

await test("有效缓存过滤坏条目并保留完整仓库对象", async () => {
  const generatedAt = new Date(950).toISOString();
  const { adapter } = createHarness({
    files: {
      "cache/dsh.json": JSON.stringify({
        saved_at: generatedAt,
        generated_at: generatedAt,
        kind: "dsh",
        count: 4,
        repos: [repo("owner/good"), { full_name: 42 }, { full_name: "" }, null],
      }),
    },
  });

  const result = await adapter.readListCache("dsh");

  assert.deepEqual(result.map((item) => item.full_name), ["owner/good"]);
  assert.equal(result[0].description, "description");
});

await test("过期、旧格式和损坏缓存均拒绝", async () => {
  const { adapter, fs, now } = createHarness({
    files: {
      "cache/dsh.json": JSON.stringify({ generated_at: new Date(800).toISOString(), repos: [repo("old/repo")] }),
    },
  });
  assert.equal(await adapter.readListCache("dsh"), null);

  fs.files.set("cache/dsh.json", JSON.stringify({ saved_at: new Date(1000).toISOString(), repos: [repo("old/format")] }));
  assert.equal(await adapter.readListCache("dsh"), null);

  fs.files.set("cache/dsh.json", "not-json");
  now.value = 2000;
  assert.equal(await adapter.readListCache("dsh"), null);

  fs.files.set("cache/dsh.json", JSON.stringify({ generated_at: new Date(1950).toISOString(), repos: [{ full_name: 42 }] }));
  now.value = 2000;
  assert.equal(await adapter.readListCache("dsh"), null);
});

await test("写缓存保持字段形态并使用 tmp + rename", async () => {
  const { adapter, fs } = createHarness();
  await adapter.writeListCache("dsh", [repo("owner/repo")]);
  const written = JSON.parse(fs.files.get("cache/dsh.json"));

  assert.equal(written.saved_at, new Date(1000).toISOString());
  assert.equal(written.generated_at, new Date(1000).toISOString());
  assert.equal(written.kind, "dsh");
  assert.equal(written.count, 1);
  assert.deepEqual(written.repos.map((item) => item.full_name), ["owner/repo"]);
  assert.deepEqual(fs.renames, [{ from: "cache/dsh.json.tmp", to: "cache/dsh.json" }]);
  assert.equal(fs.mkdirs.length, 1);
});

await test("缓存写入和 rename 失败静默，不影响调用方", async () => {
  const { adapter, fs } = createHarness();
  fs.setFailWrite(true);
  await assert.doesNotReject(() => adapter.writeListCache("dsh", [repo("owner/write-fail")]));
  fs.setFailRename(true);
  await assert.doesNotReject(() => adapter.writeListCache("dsh", [repo("owner/rename-fail")]));
});

await test("registry gzip 成功时去重、排除本体并限制解压输出", async () => {
  const payload = JSON.stringify({ repos: [repo("owner/one"), repo("owner/one"), repo("deepseek/deepseek-harness"), repo("owner/two")] });
  const { adapter, calls } = createHarness({
    registrySources: () => [{ url: "registry/dsh.json.gz", acceptRaw: true }],
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      return response(gzipSync(payload));
    },
  });

  const result = await adapter.fetchRegistryRepos("dsh");

  assert.deepEqual(result.map((item) => item.full_name), ["owner/one", "owner/two"]);
  assert.equal(calls[0][0], "registry/dsh.json.gz");
  assert.equal(calls[0][1].headers.Authorization, "Bearer test-token");
  assert.equal(calls.find((call) => call[0] === "gunzip")[1].maxOutputLength, limits.maxResponseBytes);
});

await test("CDN 过期源和超限源均继续尝试下一个 registry 源", async () => {
  const freshPayload = JSON.stringify({ repos: [repo("owner/fresh")] });
  const { adapter, calls } = createHarness({
    registrySources: () => [
      { url: "cdn/stale.json", checkFresh: true },
      { url: "cdn/too-large.json" },
      { url: "raw/fresh.json" },
    ],
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === "cdn/stale.json") return response(JSON.stringify({ generated_at: new Date(800).toISOString(), repos: [repo("owner/stale")] }));
      if (url === "cdn/too-large.json") return response(freshPayload, { contentLength: 9999 });
      return response(freshPayload);
    },
  });

  const result = await adapter.fetchRegistryRepos("dsh");

  assert.deepEqual(result.map((item) => item.full_name), ["owner/fresh"]);
  assert.deepEqual(calls, ["cdn/stale.json", "cdn/too-large.json", "raw/fresh.json"]);
});

await test("registry HTTP、JSON 和 gzip 失败均继续换源", async () => {
  const payload = JSON.stringify({ repos: [repo("owner/fallback")] });
  const { adapter, calls } = createHarness({
    registrySources: () => [
      { url: "bad-http.json" },
      { url: "bad-json.json" },
      { url: "bad-gzip.json.gz" },
      { url: "raw/fallback.json" },
    ],
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === "bad-http.json") return response("ignored", { status: 503 });
      if (url === "bad-json.json") return response("not-json");
      if (url === "bad-gzip.json.gz") return response(gzipSync(payload));
      return response(payload);
    },
    gunzip: () => {
      throw new Error("gzip failed");
    },
  });

  const result = await adapter.fetchRegistryRepos("dsh");

  assert.deepEqual(result.map((item) => item.full_name), ["owner/fallback"]);
  assert.deepEqual(calls.filter((call) => typeof call === "string"), ["bad-http.json", "bad-json.json", "bad-gzip.json.gz", "raw/fallback.json"]);
});

await test("registry 和 cache 在 TTL 恰好到期时仍可用", async () => {
  const generatedAt = new Date(900).toISOString();
  const registry = createHarness({
    registrySources: () => [{ url: "cdn/exact-age.json", checkFresh: true }],
    fetchImpl: async () => response(JSON.stringify({ generated_at: generatedAt, repos: [repo("owner/exact-registry")] })),
  });
  assert.deepEqual((await registry.adapter.fetchRegistryRepos("dsh")).map((item) => item.full_name), ["owner/exact-registry"]);

  const cache = createHarness({
    registrySources: () => [],
    files: {
      "cache/dsh.json": JSON.stringify({ generated_at: generatedAt, repos: [repo("owner/exact-cache")] }),
    },
  });
  assert.deepEqual((await cache.adapter.readListCache("dsh")).map((item) => item.full_name), ["owner/exact-cache"]);
});

await test("search 分页跨 query 去重并保留部分结果", async () => {
  const calls = [];
  const { adapter } = createHarness({
    searchQueries: { dsh: ["q1", "q2"] },
    fetchJson: async (url, headers) => {
      calls.push([url, headers]);
      if (url.includes("q1") && url.includes("page=1")) return { items: [repo("owner/a"), repo("owner/b")] };
      if (url.includes("q1") && url.includes("page=2")) throw new Error("page failed");
      if (url.includes("q2") && url.includes("page=1")) return { items: [repo("owner/b"), repo("owner/c")] };
      return { items: [] };
    },
    limits: { pageSize: 2, maxPages: 3 },
  });

  const result = await adapter.fetchSearchRepos("dsh");

  assert.deepEqual(result.map((item) => item.full_name), ["owner/a", "owner/b", "owner/c"]);
  assert.equal(calls.length, 4);
  assert.equal(calls[0][1].Authorization, "Bearer test-token");
});

await test("bundled index 去重、排除本体并按 kind 读取独立文件", async () => {
  const { adapter } = createHarness({
    files: {
      "bundle/skills.json": JSON.stringify({ repos: [repo("owner/skill"), repo("owner/skill"), repo("deepseek/deepseek-harness")] }),
      "bundle/dsh.json": JSON.stringify({ repos: [repo("owner/plugin")] }),
    },
  });

  const skills = await adapter.readBundledIndex("skills");
  const dsh = await adapter.readBundledIndex("dsh");

  assert.deepEqual(skills.map((item) => item.full_name), ["owner/skill"]);
  assert.deepEqual(dsh.map((item) => item.full_name), ["owner/plugin"]);
});

await test("load 保持 dsh/skills 的默认和 force 源优先级", async () => {
  const dsh = createHarness({
    registrySources: () => [{ url: "registry/dsh" }],
    fetchImpl: async () => response(JSON.stringify({ repos: [repo("owner/registry")] })),
  });
  const dshResult = await dsh.adapter.load("dsh", false);
  assert.equal(dshResult.source, "registry");
  assert.deepEqual(dshResult.repos.map((item) => item.full_name), ["owner/registry"]);

  const skills = createHarness({
    files: { "bundle/skills.json": JSON.stringify({ repos: [repo("owner/bundled")] }) },
  });
  const skillsResult = await skills.adapter.load("skills", false);
  assert.equal(skillsResult.source, "bundled");

  const forced = createHarness({
    registrySources: () => [{ url: "registry/skills" }],
    fetchImpl: async () => response(JSON.stringify({ repos: [repo("owner/forced")] })),
    files: { "bundle/skills.json": JSON.stringify({ repos: [repo("owner/bundled")] }) },
  });
  const forcedResult = await forced.adapter.load("skills", true);
  assert.equal(forcedResult.source, "registry");
  assert.deepEqual(forcedResult.repos.map((item) => item.full_name), ["owner/forced"]);
});

await test("load 将空 registry 和 bundled 继续回退到下一来源", async () => {
  const { adapter } = createHarness({
    registrySources: () => [{ url: "registry/empty" }],
    fetchImpl: async () => response(JSON.stringify({ repos: [] })),
    files: {
      "bundle/dsh.json": JSON.stringify({ repos: [repo("owner/bundled-after-empty")] }),
    },
  });
  const result = await adapter.load("dsh", false);
  assert.equal(result.source, "bundled");
  assert.deepEqual(result.repos.map((item) => item.full_name), ["owner/bundled-after-empty"]);

  const { adapter: cacheAdapter } = createHarness({
    registrySources: () => [],
    files: {
      "bundle/dsh.json": JSON.stringify({ repos: [] }),
      "cache/dsh.json": JSON.stringify({ generated_at: new Date(950).toISOString(), repos: [repo("owner/cache-after-empty")] }),
    },
  });
  const cacheResult = await cacheAdapter.load("dsh", false);
  assert.equal(cacheResult.source, "cache");
  assert.deepEqual(cacheResult.repos.map((item) => item.full_name), ["owner/cache-after-empty"]);
});

await test("load 依次回退磁盘缓存和 search，search 不写 raw cache", async () => {
  const cached = createHarness({
    registrySources: () => [],
    files: {
      "cache/dsh.json": JSON.stringify({
        generated_at: new Date(950).toISOString(),
        repos: [repo("owner/cached")],
      }),
    },
  });
  const cacheResult = await cached.adapter.load("dsh", false);
  assert.equal(cacheResult.source, "cache");
  assert.deepEqual(cacheResult.repos.map((item) => item.full_name), ["owner/cached"]);

  const searched = createHarness({
    registrySources: () => [],
    fetchJson: async () => ({ items: [repo("owner/search")] }),
  });
  const searchResult = await searched.adapter.load("dsh", false);
  assert.equal(searchResult.source, "search");
  assert.deepEqual(searchResult.repos.map((item) => item.full_name), ["owner/search"]);
  assert.equal(searched.fs.writes.length, 0);
});

await test("load 的 registry/bundled 成功异步写入完整 raw cache但不改返回值", async () => {
  const { adapter, fs } = createHarness({
    registrySources: () => [{ url: "registry/dsh" }],
    fetchImpl: async () => response(JSON.stringify({ repos: [repo("owner/registry")] })),
  });

  const result = await adapter.load("dsh", false);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(result.source, "registry");
  assert.deepEqual(result.repos.map((item) => item.full_name), ["owner/registry"]);
  assert.equal(JSON.parse(fs.files.get("cache/dsh.json")).repos[0].full_name, "owner/registry");

  const bundled = createHarness({
    registrySources: () => [],
    files: {
      "bundle/dsh.json": JSON.stringify({ repos: [repo("owner/bundled-cache")] }),
    },
  });
  const bundledResult = await bundled.adapter.load("dsh", false);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(bundledResult.source, "bundled");
  assert.equal(JSON.parse(bundled.fs.files.get("cache/dsh.json")).repos[0].full_name, "owner/bundled-cache");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
