import { createFeedbackUseCase } from "../../../lib/app/feedback.js";

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

const ENTRY = {
  repo: "owner/demo",
  name: "demo",
  type: "cordis-plugin",
  version: "1.2.3",
  installedAt: 1000,
  method: "market-direct",
  reinstall: false,
  envProfile: { platform: "test", node: "v22.0.0", market: "1.5.5" },
  logSnapshot: "安装日志（已脱敏）"
};

function makeFeedback(overrides = {}) {
  const calls = [];
  const writes = [];
  const requests = [];
  let stored = null;
  let fetchResult = { status: 200, ok: true, body: { html_url: "https://github.com/bradeGithub/DSH-Plugins-Marketplace/issues/1" } };
  const queue = {
    add: async (task) => {
      calls.push("queue.add");
      return await task();
    }
  };
  const options = {
    feedbackFile: "/market/feedback.json",
    marketRoot: "/market",
    readStateJson: async () => stored,
    mkdir: async (...args) => calls.push(["mkdir", ...args]),
    writeFile: async (file, text, encoding) => {
      calls.push("writeFile");
      writes.push({ file, data: JSON.parse(text), encoding });
    },
    queue,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      const result = typeof fetchResult === "function" ? fetchResult(url, init) : fetchResult;
      return { status: result.status, ok: result.ok, body: result.body };
    },
    readBodyLimited: async (res) => Buffer.from(JSON.stringify(res.body ?? {})),
    timeoutSignal: () => "signal",
    selfUpdateRepo: "bradeGithub/DSH-Plugins-Marketplace",
    feedbackLogTail: 40,
    translate: (_lang, key, params) => params?.err ? `${key}:${params.err}` : key,
    now: () => 2000,
    ...overrides
  };
  const flow = createFeedbackUseCase(options);
  return {
    flow,
    calls,
    writes,
    requests,
    setStored: (value) => { stored = value; },
    setFetchResult: (value) => { fetchResult = value; }
  };
}

{
  const { flow } = makeFeedback();
  check("初始 pending/token 状态", flow.getState(), { pending: [], hasToken: false });
}

{
  const { flow, setStored } = makeFeedback();
  setStored({ pending: [ENTRY], token: "ghp_saved" });
  await flow.load();
  check("load 恢复 pending", flow.getPending(), [ENTRY]);
  check("load 只暴露 hasToken", flow.getState(), { pending: [ENTRY], hasToken: true });
}

{
  const { flow, writes } = makeFeedback();
  await flow.queueFeedback({ ...ENTRY, version: "1.0.0" });
  await flow.queueFeedback({ ...ENTRY, version: "2.0.0" });
  check("同 repo 只保留最新反馈", flow.getPending(), [{ ...ENTRY, version: "2.0.0" }]);
  check("queueFeedback 持久化最新状态", writes.at(-1).data, { pending: [{ ...ENTRY, version: "2.0.0" }], token: "" });
}

{
  const { flow, calls, setStored } = makeFeedback();
  setStored({ pending: [ENTRY], token: "" });
  await flow.load();
  check("removePendingFeedback 命中", flow.removePendingFeedback(ENTRY.repo), true);
  check("removePendingFeedback 未命中", flow.removePendingFeedback(ENTRY.repo), false);
  check("removePendingFeedback 只改内存不自行落盘", calls.includes("writeFile"), false);
}

{
  const { flow, calls } = makeFeedback({
    writeFile: async () => { calls.push("writeFile"); throw new Error("disk full"); }
  });
  const logs = [];
  await flow.queueFeedbackSafe(ENTRY, (line) => logs.push(line), "zh");
  check("queueFeedbackSafe 写入失败不抛", true, true);
  check("queueFeedbackSafe 写入失败记录日志", logs, ["feedbackQueueFail:disk full"]);
}

{
  const { flow } = makeFeedback();
  const result = await flow.submitFeedback({ repo: "missing/repo", ok: true, note: "" });
  check("提交不存在反馈", result, { status: "not-found", repo: "missing/repo", issueUrl: null, error: "feedbackNotFound" });
}

{
  const { flow, writes, requests } = makeFeedback();
  await flow.queueFeedback(ENTRY);
  const result = await flow.submitFeedback({ repo: ENTRY.repo, ok: true, note: "works" });
  check("无 token 返回 manualUrl", typeof result.manualUrl === "string" && result.manualUrl.includes("/issues/new"), true);
  check("无 token 不请求 GitHub", requests.length, 0);
  check("提交后先持久化移除队列", writes.at(-1).data.pending, []);
  check("manualUrl 不含诊断日志", decodeURIComponent(result.manualUrl).includes("安装日志（已脱敏）"), false);
  await flow.queueFeedback({ ...ENTRY, repo: "owner/broken" });
  const broken = await flow.submitFeedback({ repo: "owner/broken", ok: false, note: "broken" });
  check("异常 feedback 的 manualUrl 也不含诊断日志", decodeURIComponent(broken.manualUrl).includes("安装日志（已脱敏）"), false);
}

{
  const { flow, calls, requests, setFetchResult } = makeFeedback();
  await flow.queueFeedback(ENTRY);
  await flow.setToken("ghp_test");
  setFetchResult({ status: 422, ok: false, body: {} });
  const result = await flow.submitFeedback({ repo: ENTRY.repo, ok: false, note: "broken" });
  check("GitHub 422 重试后返回 manualUrl", typeof result.manualUrl === "string", true);
  check("GitHub 422 返回错误", result.error, "GitHub API 422");
  check("422 触发两次请求", requests.length, 2);
  check("首请求携带 install-failed label", requests[0].init.body.includes("install-failed"), true);
  check("GitHub 请求使用配置 token", requests[0].init.headers.Authorization, "Bearer ghp_test");
  check("重试请求移除 labels", requests[1].init.body.includes("labels"), false);
  check("反馈状态保存串行通过队列", calls.filter((name) => name === "queue.add").length, 3);
}

{
  const { flow, requests } = makeFeedback();
  await flow.queueFeedback(ENTRY);
  await flow.setToken("ghp_test");
  const result = await flow.submitFeedback({ repo: ENTRY.repo, ok: false, note: "broken" });
  check("GitHub 成功返回 issueUrl", result, { status: "done", issueUrl: "https://github.com/bradeGithub/DSH-Plugins-Marketplace/issues/1" });
  const body = JSON.parse(requests[0].init.body).body;
  check("异常反馈带 details 日志", body.includes("<details>") && body.includes("安装日志（尾部 40 行，已脱敏）") && body.includes("安装日志（已脱敏）"), true);
  check("issue body 含双语标题和画像", body.includes("安装反馈 / Install Feedback") && body.includes("test") && body.includes("v22.0.0"), true);
  check("正常反馈不带日志", (await (async () => {
    const fixture = makeFeedback();
    await fixture.flow.queueFeedback({ ...ENTRY, logSnapshot: "不应出现" });
    await fixture.flow.setToken("ghp_test");
    const normal = await fixture.flow.submitFeedback({ repo: ENTRY.repo, ok: true, note: "" });
    return JSON.parse(fixture.requests[0].init.body).body.includes("不应出现") || Boolean(normal.error);
  })()), false);
}

{
  const { flow, setFetchResult } = makeFeedback();
  await flow.queueFeedback(ENTRY);
  await flow.setToken("ghp_test");
  setFetchResult({ status: 500, ok: false, body: {} });
  const result = await flow.submitFeedback({ repo: ENTRY.repo, ok: true, note: "" });
  check("GitHub 非 ok 回退 manualUrl", typeof result.manualUrl === "string" && result.error === "GitHub API 500", true);
}

{
  const { flow, setFetchResult } = makeFeedback();
  await flow.queueFeedback(ENTRY);
  await flow.setToken("ghp_test");
  setFetchResult(() => { throw new Error("network down"); });
  const result = await flow.submitFeedback({ repo: ENTRY.repo, ok: true, note: "" });
  check("GitHub 异常回退 manualUrl", typeof result.manualUrl === "string" && result.error === "network down", true);
}

{
  const { flow, writes } = makeFeedback();
  const saved = await flow.setToken("ghp_secret");
  check("setToken 只返回 hasToken", saved, { status: "done", hasToken: true });
  check("token 不回显且已持久化", writes.at(-1).data, { pending: [], token: "ghp_secret" });
  const cleared = await flow.setToken("");
  check("清除 token", cleared, { status: "done", hasToken: false });
  check("getState 不泄露 token", flow.getState().token, undefined);
}

{
  const { flow } = makeFeedback({ now: undefined });
  await flow.queueFeedback({ ...ENTRY, repo: "owner/no-time", installedAt: undefined });
  await flow.setToken("ghp_test");
  const result = await flow.submitFeedback({ repo: "owner/no-time", ok: true, note: "" });
  check("缺失安装时间使用默认时钟", result.status, "done");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
