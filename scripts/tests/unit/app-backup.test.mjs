import { createBackupUseCase } from "../../../lib/app/backup.js";
import { isSafeWebdavUrl } from "../../../lib/domain/validation.js";

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
    // 注入真实校验（domain 层纯函数）——用例层行为断言必须连同实际网段策略一起验证，
    // 弱桩（只测 scheme）会让「链路本地/回环放行」回归无声通过。
    isSafeWebdavUrl,
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

// ---- S3：受限 WebDAV 地址 fail-closed——拦截必须发生在发请求之前 ----
{
  for (const url of [
    "http://169.254.169.254/latest/meta-data",   // 云元数据端点（链路本地）
    "https://169.254.169.254/",                  // 同段 https 也不豁免
    "http://127.0.0.1:9/x",                      // 回环
    "http://[::1]/x",                            // IPv6 回环
    "http://[::ffff:7f00:1]/x",                  // v4-mapped 回环
    "http://100.64.1.1/x",                       // CGNAT 共享段
    "http://dav.example.com/bk.json",            // 公网 http 明文（凭据禁走明文）
    "http://user:pass@192.168.1.5/x",            // 内嵌凭据
    "not-a-url"
  ]) {
    const { flow, calls } = makeBackup();
    const result = await flow.pushWebdav({ url, username: "u", password: "p", lang: "zh" });
    check(`WebDAV 受限地址拒绝 ${url}`, result, { status: "invalid-url" });
    check(`WebDAV 受限地址零请求 ${url}`, calls, []);
  }
  const { flow, calls } = makeBackup();
  const result = await flow.restoreWebdav({ url: "http://169.254.169.254/latest/meta-data" });
  check("WebDAV 恢复受限地址拒绝", result, { status: "invalid-url" });
  check("WebDAV 恢复受限地址零请求", calls, []);
}

// 局域网 http 明文放行（NAS 场景）：私网 IPv4 + 自定义端口
{
  const { flow, requests } = makeBackup();
  const result = await flow.pushWebdav({ url: "http://192.168.1.5:5005/bk.json", lang: "zh" });
  check("WebDAV 局域网 http 放行", result.status, "done");
  check("WebDAV 局域网请求已发出", [requests[0].url, requests[0].init.method], ["http://192.168.1.5:5005/bk.json", "PUT"]);
  check("WebDAV 请求声明 manual redirect", requests[0].init.redirect, "manual");
}

// ---- 重定向：手动跟随 + 逐跳校验（堵「校验 A 实际打到 B」）----
// 302 相对路径同 origin → 跟随且保留凭据
{
  const { flow, requests, setResponse } = makeBackup();
  setResponse((url) => url.endsWith("/a.json")
    ? { status: 302, ok: false, headers: new Map([["location", "/b.json"]]) }
    : { status: 200, ok: true, body: { repos: [] } });
  const result = await flow.restoreWebdav({ url: "https://dav.example/a.json", username: "alice", password: "secret" });
  check("WebDAV 302 相对路径跟随", result.status, "done");
  check("WebDAV 302 跟随目标解析", requests.map((r) => r.url), ["https://dav.example/a.json", "https://dav.example/b.json"]);
  check("WebDAV 同 origin 保留凭据", requests[1].init.headers.Authorization, `Basic ${Buffer.from("alice:secret").toString("base64")}`);
}

// 302 跨 origin → 跟随但剥掉 Authorization（fetch 规范语义）
{
  const { flow, requests, setResponse } = makeBackup();
  setResponse((url) => url.startsWith("https://dav.example/")
    ? { status: 302, ok: false, headers: new Map([["location", "https://other.example/b.json"]]) }
    : { status: 200, ok: true, body: { repos: [] } });
  const result = await flow.restoreWebdav({ url: "https://dav.example/a.json", username: "alice", password: "secret" });
  check("WebDAV 跨 origin 重定向跟随", result.status, "done");
  check("WebDAV 跨 origin 剥 Authorization", requests[1].init.headers.Authorization, undefined);
}

// 302 → 受限目标：不跟随，只发出首跳请求
{
  const { flow, requests, setResponse } = makeBackup();
  setResponse(() => ({ status: 302, ok: false, headers: new Map([["location", "http://169.254.169.254/latest/meta-data"]]) }));
  const result = await flow.restoreWebdav({ url: "https://dav.example/a.json" });
  check("WebDAV 重定向到受限地址拒绝跟随", result.status, "failed");
  check("WebDAV 重定向受限目标零跟随（仅首跳）", requests.length, 1);
}

// 重定向环：跟随次数封顶（首发 + 4 跳）
{
  const { flow, requests, setResponse } = makeBackup();
  setResponse(() => ({ status: 301, ok: false, headers: new Map([["location", "/loop"]]) }));
  const result = await flow.pushWebdav({ url: "https://dav.example/a.json", lang: "zh" });
  check("WebDAV 重定向环超限失败", result.status, "failed");
  check("WebDAV 重定向环请求数封顶", requests.length, 5);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
