// 网络 IO 抽象（分层重构：infra 层，封装 fetch 边界）。
// fetchJson — 带超时、大小限制和 chunked 兜底的 JSON 请求。

import { responseTooLarge, readBodyLimited } from "../http/request.js";

/** 外部网络请求超时——CDN / GitHub 挂起时快速失败。 */
const FETCH_TIMEOUT_MS = 15000;

/**
 * 带防护的 JSON fetch：超时 + 响应大小限制 + chunked 兜底。
 * - 响应过大（Content-Length 超限）→ 抛错
 * - HTTP 错误 → 抛错含状态码和响应片段
 * - chunked（无 content-length）→ readBodyLimited 流式计数兜底
 */
async function fetchJson(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": "dsh-plugin-marketplace", "Accept": "application/vnd.github+json", ...extraHeaders },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}${(await res.text().catch(() => "")).slice(0, 200)}`);
  if (responseTooLarge(res)) throw new Error(`响应过大（Content-Length ${res.headers.get("content-length")}）`);
  return JSON.parse((await readBodyLimited(res)).toString("utf8"));
}

export { fetchJson, FETCH_TIMEOUT_MS };
