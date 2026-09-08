import { createBackupUseCase } from "../../../lib/app/backup.js";

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

const records = new Map([
  ["Owner/Late", {
    type: "skill", name: "late", names: null, version: "2.0.0", installedAt: 200
  }],
  ["OWNER/early", {
    type: "cordis-plugin", name: "early", names: ["early", "extra"], version: "1.0.0", installedAt: 100
  }],
  ["ignored/empty", {
    type: "script", name: null, names: [], version: null, installedAt: null
  }]
]);

function makeBackup(overrides = {}) {
  const calls = [];
  const requests = [];
  let response = { status: 200, ok: true, body: { repos: [] } };
  const options = {
    getInstalledEntries: () => records.entries(),
    readOwnVersion: () => "1.5.5",
    installedKey: (repo) => String(repo).toLowerCase(),
    hasInstalledRecord: (repo) => records.has(String(repo).toLowerCase()) || repo === "owner/early",
    fetchImpl: async (url, init) => {
      calls.push("fetch");
      requests.push({ url, init });
      const result = typeof response === "function" ? response(url, init) : response;
      return { status: result.status, ok: result.ok, body: result.body, headers: result.headers, tooLarge: result.tooLarge };
    },
    readBodyLimited: async (res) => Buffer.from(JSON.stringify(res.body)),
    responseTooLarge: (res) => Boolean(res.tooLarge),
    timeoutSignal: () => "signal",
    isSafeWebdavUrl: (url) => /^https?:\/\//i.test(String(url ?? "").trim()),
    translate: (_lang, key, params) => params?.err !== undefined ? `${key}:${params.err}` : params?.n !== undefined && params?.m !== undefined ? `${key}:${params.n}:${params.m}` : params?.n !== undefined ? `${key}:${params.n}` : params?.m !== undefined ? `${key}:${params.m}` : key,
    now: () => 300
  };
  const flow = createBackupUseCase({ ...options, ...overrides });
  return {
    flow,
    calls,
    requests,
    setResponse: (value) => { response = value; }
  };
}

{
  const { flow } = makeBackup();
  check("buildBackup 元数据", flow.buildBackup().app, "dsh-plugin-marketplace");
  check("buildBackup 版本", flow.buildBackup().appVersion, "1.5.5");
  check("buildBackup 按 installedAt 升序并归一 repo", flow.buildBackup().repos.map((r) => [r.repo, r.installedAt]), [
    ["ignored/empty", null], ["owner/early", 100], ["owner/late", 200]
  ]);
  check("buildBackup 保留多包 names", flow.buildBackup().repos.find((r) => r.repo === "owner/early").names, ["early", "extra"]);
  check("buildBackup 只输出约定字段", Object.keys(flow.buildBackup().repos.find((r) => r.repo === "owner/early")).sort(), ["installedAt", "name", "names", "repo", "type", "version"]);
}

{
  const { flow } = makeBackup({ getInstalledEntries: () => [].entries() });
  check("空记录仍返回合法空备份", flow.buildBackup().repos, []);
  check("合法备份校验", flow.isValidBackup({ repos: [{ repo: "owner/demo" }] }), true);
  check("缺 repos 的备份拒绝", flow.isValidBackup({}), false);
  check("非字符串 repo 的备份拒绝", flow.isValidBackup({ repos: [{ repo: 1 }] }), false);
  check("非对象备份拒绝", flow.isValidBackup(null), false);
}

{
  const { flow } = makeBackup();
  const result = flow.diffBackup({ repos: [{ repo: "owner/early" }, { repo: "new/repo" }] });
  check("diff 分离 already/missing", result, { missing: ["new/repo"], already: ["owner/early"], log: ["restoreDiff:1:1"] });
}

{
  const { flow, requests } = makeBackup();
  const result = await flow.pushWebdav({
    url: "https://dav.example/backup.json",
    backup: { app: "custom", repos: [{ repo: "owner/demo" }] },
    username: "alice",
    password: "secret",
    lang: "en"
  });
  check("WebDAV PUT 成功", result, { status: "done", count: 1, log: ["webdavPushOk"] });
  check("WebDAV PUT 参数", [requests[0].url, requests[0].init.method, JSON.parse(requests[0].init.body)], [
    "https://dav.example/backup.json", "PUT", { app: "custom", repos: [{ repo: "owner/demo" }] }
  ]);
  check("WebDAV Basic 认证", requests[0].init.headers.Authorization, `Basic ${Buffer.from("alice:secret").toString("base64")}`);
  check("WebDAV 使用注入超时信号", requests[0].init.signal, "signal");
}

{
  const { flow, calls } = makeBackup();
  const result = await flow.pushWebdav({ url: "file:///secret", lang: "zh" });
  check("WebDAV 非 http 地址拒绝", result, { status: "invalid-url" });
  check("非法 WebDAV 地址不发请求", calls, []);
}

{
  const { flow } = makeBackup();
  const result = await flow.pushWebdav({ url: "https://dav.example/backup", lang: "zh" });
  check("WebDAV 未提供备份时使用当前快照", result.count, 3);
}

{
  const { flow, setResponse } = makeBackup();
  setResponse({ status: 500, ok: false, body: {} });
  const result = await flow.pushWebdav({
    url: "https://dav.example/backup",
    lang: "en",
    backup: { repos: [] }
  });
  check("WebDAV HTTP 失败归一化", result, { status: "failed", error: "HTTP 500", log: ["webdavFail:HTTP 500"] });
}

{
  const { flow, setResponse, requests } = makeBackup();
  setResponse({ status: 200, ok: true, body: { repos: [{ repo: "new/repo" }, { repo: "owner/early" }] } });
  const result = await flow.restoreWebdav({
    url: "https://dav.example/backup.json",
    username: "alice",
    password: "secret",
    lang: "en"
  });
  check("WebDAV GET 恢复差异", result, { status: "done", missing: ["new/repo"], already: ["owner/early"], log: ["restoreDiff:1:1"] });
  check("WebDAV GET 方法与认证", [requests[0].init.method, requests[0].init.headers.Authorization], ["GET", `Basic ${Buffer.from("alice:secret").toString("base64")}`]);
}

{
  const { flow, setResponse, calls } = makeBackup();
  setResponse({ status: 200, ok: true, body: { nope: true } });
  const result = await flow.restoreWebdav({ url: "https://dav.example/backup" });
  check("WebDAV 非法备份归一化", result, { status: "invalid-backup" });
  check("WebDAV 恢复请求已执行", calls, ["fetch"]);
}

{
  const { flow, setResponse } = makeBackup();
  setResponse({ status: 500, ok: false, body: {} });
  const result = await flow.restoreWebdav({ url: "https://dav.example/backup", lang: "zh" });
  check("WebDAV GET HTTP 失败", result, { status: "failed", error: "HTTP 500", log: ["webdavFail:HTTP 500"] });
}

{
  const { flow, setResponse } = makeBackup();
  setResponse(() => { throw new Error("network down"); });
  const result = await flow.restoreWebdav({ url: "https://dav.example/backup", lang: "en" });
  check("WebDAV GET 网络异常", result, { status: "failed", error: "network down", log: ["webdavFail:network down"] });
}

{
  const { flow, setResponse } = makeBackup();
  setResponse({ status: 200, ok: true, body: { repos: [] }, tooLarge: true });
  const result = await flow.restoreWebdav({ url: "https://dav.example/backup", lang: "zh" });
  check("WebDAV GET 响应过大", result, { status: "failed", error: "备份响应过大", log: ["webdavFail:备份响应过大"] });
}

{
  const { flow } = makeBackup();
  check("恢复差异无 missing 文案", flow.buildDiffResult({ missing: [], already: [] }, "zh"), {
    missing: [], already: [], log: ["restoreDiffNone"]
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
