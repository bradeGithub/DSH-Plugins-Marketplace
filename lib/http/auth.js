// HTTP 鉴权层（分层重构：http 层，无业务知识）。
// 防 CSRF / DNS rebinding / LAN 写访问控制与会话 token 注入。

const CSRF_HEADER = "x-dsh-marketplace";
const WRITE_TOKEN_HEADER = "x-dsh-marketplace-token";

export function createAuth({
  isTrustedHost,
  readConfig,
  randomHex,
  timingSafeEqual
}) {
  const writeToken = randomHex();

  /**
   * 防 CSRF / DNS rebinding：
   * - 要求自定义头 X-DSH-Marketplace: 1（跨站简单请求无法携带，会强制 preflight 被 CORS 拦下）；
   * - Host 必须在可信白名单内（本机回环 / 局域网 / 显式配置），攻击者域名（含 DNS rebinding
   *   解析到 127.0.0.1 的域名）一律拒绝——不再依赖「Origin===Host」这种可被 rebinding 绕过的校验；
   * - 若带 Origin 头，其 host 必须与请求自身的 Host 完全一致（含端口）。
   */
  function isTrustedRequest(req) {
    if (req.headers[CSRF_HEADER] !== "1") return false;
    if (!isTrustedHost(req.headers["host"])) return false;
    const origin = req.headers["origin"];
    if (!origin) return true; // 无 Origin 的非浏览器调用方（本地脚本/curl）放行
    try {
      return new URL(origin).host === String(req.headers["host"] ?? "");
    } catch {
      return false;
    }
  }

  /** LAN 写模式配置：config.json 的 lanWrite === true 才开启；文件缺失/损坏视为未开启（默认安全）。 */
  async function isLanWriteEnabled() {
    try {
      const cfg = await readConfig();
      return Boolean(cfg && cfg.lanWrite === true);
    } catch {
      return false;
    }
  }

  /** 写操作放行判定：isTrustedRequest（CSRF 头 + Host 白名单 + Origin）之上叠加—— */
  async function isWriteAllowed(req) {
    if (!isTrustedRequest(req)) return false;
    // 回环判定基于 socket 远端地址（连接层，不可伪造）——LAN 客户端自报 Host: 127.0.0.1
    // 可同时绕过 Host 白名单与 token；IPv4-mapped IPv6（::ffff:x.x.x.x）归一。
    const remote = String(req.socket?.remoteAddress ?? "").replace(/^::ffff:/i, "").toLowerCase();
    if (remote === "127.0.0.1" || remote === "localhost" || remote === "::1") return true;
    // LAN：需显式开启 lanWrite + 会话 token（timing-safe，长度不同直接拒绝防泄露）
    if (!(await isLanWriteEnabled())) return false;
    const got = String(req.headers[WRITE_TOKEN_HEADER] ?? "");
    if (got.length !== writeToken.length) return false;
    return timingSafeEqual(Buffer.from(got), Buffer.from(writeToken));
  }

  return {
    getToken: () => writeToken,
    tokenHeader: WRITE_TOKEN_HEADER,
    isTrustedRequest,
    isWriteAllowed,
    isLanWriteEnabled
  };
}
