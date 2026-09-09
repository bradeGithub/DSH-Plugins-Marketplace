// lib/http/request.js 直接单测：json 序列化 / readJsonBody（1MB 上限 + 非法 JSON 400）/
// responseTooLarge（32MB 边界）/ readBodyLimited（chunked 流式累计超限 cancel + 无 reader 回退）。
// 这些是安全敏感路径（body/响应大小上限），此前仅被 security-guards 静态断言与 e2e 间接覆盖。

import { json, readJsonBody, responseTooLarge, readBodyLimited, MAX_BODY_BYTES, MAX_RESPONSE_BYTES } from "../../../lib/http/request.js";

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

/** 构造 async iterable 请求体（readJsonBody 用 for await 消费）。 */
function asyncIterable(chunks) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) yield c;
    }
  };
}

// ---- 常量边界 ----
check("MAX_BODY_BYTES = 1MB", MAX_BODY_BYTES, 1024 * 1024);
check("MAX_RESPONSE_BYTES = 32MB", MAX_RESPONSE_BYTES, 32 * 1024 * 1024);

// ---- json: 序列化 + 响应头 + end ----
{
  const calls = [];
  const res = {
    writeHead: (status, headers) => { calls.push(["writeHead", status, headers]); },
    end: (body) => { calls.push(["end", body]); }
  };
  json(res, 200, { ok: true, n: 1 });
  const [wh, end] = calls;
  check("json 状态码 200", wh[1], 200);
  check("json Content-Type", wh[2]["Content-Type"], "application/json; charset=utf-8");
  check("json Content-Length 字节数", wh[2]["Content-Length"], Buffer.byteLength('{"ok":true,"n":1}'));
  check("json Cache-Control no-store", wh[2]["Cache-Control"], "no-store");
  check("json end 序列化 body", end[1], '{"ok":true,"n":1}');
}

// ---- readJsonBody: 空体 / 合法 / 非法 / 超限 / UTF-8 跨分片 ----
{
  const r = await readJsonBody(asyncIterable([]));
  check("空体返回 {}", r, {});
}
{
  const r = await readJsonBody(asyncIterable([Buffer.from('{"a":1}')]));
  check("合法 JSON 解析", r, { a: 1 });
}
{
  let err = null;
  try { await readJsonBody(asyncIterable([Buffer.from("not json")])); } catch (e) { err = e; }
  check("非法 JSON 抛错", err !== null, true);
  check("非法 JSON status 400", err?.status, 400);
}
{
  // 超过 1MB：构造 1MB+1 字节
  const big = Buffer.alloc(MAX_BODY_BYTES + 1, 0x61);
  let err = null;
  try { await readJsonBody(asyncIterable([big])); } catch (e) { err = e; }
  check("超 1MB 抛错", err !== null, true);
  check("超 1MB status 413", err?.status, 413);
}
{
  // 恰好 1MB 不超限（边界）：1MB 全 'a' 不是合法 JSON，但不应抛 413
  const exact = Buffer.alloc(MAX_BODY_BYTES, 0x61);
  let err = null;
  try { await readJsonBody(asyncIterable([exact])); } catch (e) { err = e; }
  check("恰好 1MB 不抛 413", err?.status !== 413, true);
}
{
  // 多字节 UTF-8 跨 TCP 分片——"你" 的 3 字节拆到两个 chunk，
  // 逐 chunk 字符串拼接会按分片独立解码产生替换字符；收集 Buffer 后一次性解码应正确。
  const name = "你";
  const bytes = Buffer.from(`{"name":"${name}"}`, "utf8");
  const splitAt = bytes.indexOf(Buffer.from(name, "utf8")) + 2; // 拆在 "你" 前两字节后
  const chunk1 = bytes.subarray(0, splitAt);
  const chunk2 = bytes.subarray(splitAt);
  const r = await readJsonBody(asyncIterable([chunk1, chunk2]));
  check("UTF-8 跨分片正确解码", r, { name });
}

// ---- responseTooLarge: 32MB 边界 ----
{
  const res = (len) => ({ headers: { get: (k) => (k === "content-length" ? String(len) : null) } });
  check("content-length > 32MB → true", responseTooLarge(res(MAX_RESPONSE_BYTES + 1)), true);
  check("content-length = 32MB → false", responseTooLarge(res(MAX_RESPONSE_BYTES)), false);
  check("content-length 小 → false", responseTooLarge(res(1024)), false);
  check("无 content-length → false", responseTooLarge({ headers: { get: () => null } }), false);
  check("无 headers → false", responseTooLarge({}), false);
}

// ---- readBodyLimited: 无 reader 回退 arrayBuffer ----
{
  const res = { arrayBuffer: async () => Buffer.from("fallback") };
  const buf = await readBodyLimited(res);
  check("无 reader 回退 arrayBuffer", buf.toString(), "fallback");
}
{
  // 无 body 字段也回退
  const res = { arrayBuffer: async () => Buffer.from("no-body") };
  const buf = await readBodyLimited(res);
  check("无 body 字段回退", buf.toString(), "no-body");
}

// ---- readBodyLimited: 正常流式 ----
{
  const reader = {
    reads: [Buffer.from("hello "), Buffer.from("world")],
    i: 0,
    read: async function () {
      if (this.i >= this.reads.length) return { done: true };
      return { done: false, value: this.reads[this.i++] };
    },
    cancel: async () => { this.cancelled = true; }
  };
  const res = { body: { getReader: () => reader } };
  const buf = await readBodyLimited(res);
  check("流式拼接", buf.toString(), "hello world");
  check("正常流不 cancel", reader.cancelled, undefined);
}

// ---- readBodyLimited: 累计超 32MB → cancel + 抛错 ----
{
  let cancelled = false;
  const big = Buffer.alloc(MAX_RESPONSE_BYTES + 1, 0x62);
  const reader = {
    read: async () => ({ done: false, value: big }),
    cancel: async () => { cancelled = true; }
  };
  const res = { body: { getReader: () => reader } };
  let err = null;
  try { await readBodyLimited(res); } catch (e) { err = e; }
  check("超 32MB 抛错", err !== null, true);
  check("超 32MB 触发 cancel", cancelled, true);
  check("超 32MB 错误含字节数", /响应过大/.test(err?.message ?? ""), true);
}

// ---- readBodyLimited: 读取中途抛错也 cancel ----
{
  let cancelled = false;
  const reader = {
    read: async () => { throw new Error("stream broken"); },
    cancel: async () => { cancelled = true; }
  };
  const res = { body: { getReader: () => reader } };
  let err = null;
  try { await readBodyLimited(res); } catch (e) { err = e; }
  check("读取抛错传播", err?.message, "stream broken");
  check("读取抛错也 cancel", cancelled, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
