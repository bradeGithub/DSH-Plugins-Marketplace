// infra/fetch.js 直接导入测试（分层重构契约：fetchJson）。
import { fetchJson } from "../../../lib/infra/fetch.js";

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ---- fetchJson ----

// 行为：正常 JSON 响应返回解析结果
const orig = globalThis.fetch;
globalThis.fetch = async () => ({
  ok: true, status: 200,
  headers: { get: () => "100" },
  json: async () => ({ login: "test" }),
  text: async () => '{"login":"test"}',
  arrayBuffer: async () => Buffer.from('{"login":"test"}'),
});
check("fetchJson 正常解析", await fetchJson("https://api.github.com/user"), { login: "test" });

// 行为：HTTP 错误抛出含状态码的错误
globalThis.fetch = async () => ({
  ok: false, status: 403,
  text: async () => "rate limited",
});
let err403 = null;
try { await fetchJson("https://api.github.com/user"); } catch (e) { err403 = String(e); }
check("fetchJson 403 抛错含状态码", /403/.test(err403), true);

// 行为：HTTP 错误响应体读取失败仍返回带状态码的错误
globalThis.fetch = async () => ({
  ok: false, status: 502,
  text: async () => { throw new Error("body unavailable"); },
});
let errBodyRead = null;
try { await fetchJson("https://api.github.com/user"); } catch (e) { errBodyRead = String(e); }
check("fetchJson 错误体读取失败仍含状态码", /502/.test(errBodyRead), true);

// 行为：响应过大（content-length 超限）抛错
globalThis.fetch = async () => ({
  ok: true, status: 200,
  headers: { get: (h) => h === "content-length" ? String(100 * 1024 * 1024) : null },
});
let errTooBig = null;
try { await fetchJson("https://api.github.com/user"); } catch (e) { errTooBig = String(e); }
check("fetchJson 响应过大抛错", /过大|large/.test(errTooBig), true);

// 行为：extraHeaders 透传
let capturedHeaders = null;
globalThis.fetch = async (url, opts) => {
  capturedHeaders = opts.headers;
  return { ok: true, status: 200, headers: { get: () => "10" }, json: async () => ({}), text: async () => "{}", arrayBuffer: async () => Buffer.from("{}") };
};
await fetchJson("https://example.com", { "X-Custom": "test" });
check("fetchJson extraHeaders 透传", capturedHeaders["X-Custom"], "test");
check("fetchJson 默认 User-Agent", capturedHeaders["User-Agent"], "dsh-plugin-marketplace");

// 行为：chunked 响应（无 content-length）走 readBodyLimited 路径
globalThis.fetch = async () => ({
  ok: true, status: 200,
  headers: { get: () => null },
  body: {
    getReader: () => {
      const chunks = [Buffer.from('{"ok":'), Buffer.from('true}')];
      let i = 0;
      return {
        read: async () => i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined },
        cancel: async () => {},
      };
    },
  },
});
check("fetchJson chunked 解析", await fetchJson("https://example.com/data"), { ok: true });

globalThis.fetch = orig;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
