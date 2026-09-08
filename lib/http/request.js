// HTTP 请求/响应工具（分层重构：http 层，纯 IO 工具，零业务知识）。
// json 响应序列化 / 请求体读取（413 上限）/ 响应大小守卫与限流读取。

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

async function readJsonBody(req) {
  // n4：收集 Buffer 后一次性解码——逐 chunk 字符串拼接会按分片独立解码，
  // 多字节 UTF-8 跨 TCP 分片时产生替换字符，导致合法 JSON 解析失败。
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    chunks.push(chunk);
    size += Buffer.byteLength(chunk);
    if (size > MAX_BODY_BYTES) {
      const error = new Error("request body too large");
      error.status = 413;
      throw error;
    }
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(raw); } catch {
    // 非法 JSON：非法 JSON 静默吞成空对象会让上层报错指向 badRepo（误导排障）→ 明确抛 400
    const error = new Error("invalid JSON body");
    error.status = 400;
    throw error;
  }
}

function responseTooLarge(res) {
  const len = Number(res?.headers?.get?.("content-length") ?? 0);
  return len > MAX_RESPONSE_BYTES;
}

/** 限流读取响应体（完整性）：content-length 快速路径由调用方 responseTooLarge 先行拦截；
 *  本函数兜底 chunked（无 content-length）——json()/arrayBuffer()/text() 会把整个 body
 *  读入内存，32MB 上限形同虚设。流式逐 chunk 计数，累计超 MAX_RESPONSE_BYTES 即
 *  cancel 后抛错（调用方 catch → 换下一源）。返回原始字节 Buffer（调用方按需解码）。
 *  mock/旧响应无 body.reader 时回退 arrayBuffer（测试兼容）。 */
async function readBodyLimited(res) {
  const reader = res?.body?.getReader?.();
  if (!reader) return Buffer.from(await res.arrayBuffer());
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value?.byteLength ?? 0;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error(`响应过大（流式累计 ${bytes} 字节）`);
      chunks.push(value);
    }
  } catch (err) {
    try { await reader.cancel(); } catch { /* 取消失败可忽略 */ }
    throw err;
  }
  return Buffer.concat(chunks);
}

export { json, readJsonBody, responseTooLarge, readBodyLimited, MAX_BODY_BYTES, MAX_RESPONSE_BYTES };
