// 进程内插件管理器适配层：把 DSH 自带的 `pluginManager` 服务（@deepseek-ai/dsh-plugin-manager，
// cordis ctx key 就是 "pluginManager"）包成市场安装/卸载管线可以直接调用的窄接口。
//
// 为什么优先走它（而不是市场自带的那套 clone + pnpm + 复制）：
//   - 它与 `dsh plugin` 命令共用同一份包管理实现：profile 写锁、注册表回退顺序、
//     DSH peer 版本兼容检查、依赖构建脚本批准、GitHub 连通性预检、失败回滚。
//   - 它用启动器提供的 profile 与 packageManager（桌面端自带 pnpm/node，见 desktop-runtime.json），
//     所以不需要市场自己去猜 pnpm 在不在 PATH、profile 目录在哪。
//   - 桌面端（Electron）的 profile 由应用独占：CLI 明确拒绝
//     （error: profile "desktop" is managed exclusively by the Electron application），
//     只有进程内服务这一条路能完成安装/卸载。
//
// 服务不存在（老版本 DSH、未挂载该组合包）或调用失败时，调用方回退到市场自带路径；
// 本适配层只负责「调用 + 结果归一化」，不做任何策略判断（是否允许走内置路径由调用方决定）。
//
// 返回契约（来自 0.2.0 的 change() 包装）：结果对象携带
//   { changed: boolean, application: "applied" | "restart-required" | "cancelled" | "failed", error? }
// 注意：失败是「resolve 出一个 application: "failed" 的结果」，不是 reject——必须按字段判定，
// 否则会把失败当成功上报。

/** application 取值中代表「没成功」的两个。 */
const FAILED_APPLICATIONS = new Set(["failed", "cancelled"]);

function shortError(value, max = 400) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.slice(0, max);
  const message = typeof value.message === "string" && value.message.length > 0
    ? value.message
    : JSON.stringify(value);
  return String(message).slice(0, max);
}

/**
 * 归一化一次管理操作的结果。
 * @param result 服务返回的结果对象（或 undefined）。
 * @returns { ok, application, changed, code, error, needsRestart }
 */
function normalizeResult(result) {
  const application = typeof result?.application === "string" ? result.application : null;
  const error = result?.error;
  const code = error && typeof error === "object" && typeof error.code === "string"
    ? error.code
    : (typeof result?.code === "string" ? result.code : null);
  return {
    ok: application === null || !FAILED_APPLICATIONS.has(application),
    application,
    changed: result?.changed === true,
    code,
    error: shortError(error),
    needsRestart: application === "restart-required",
  };
}

export function createPluginManagerAdapter() {
  let service = null;
  let managedProfileDir = null;

  /**
   * 绑定宿主上下文并解析服务。
   * @returns {boolean} 是否拿到可用的内置安装器（拿不到时调用方回退自带路径）。
   */
  function attach(ctx) {
    try {
      const dir = ctx?.profileContext?.dir;
      managedProfileDir = typeof dir === "string" && dir.length > 0 ? dir : null;
    } catch {
      managedProfileDir = null;
    }
    return resolve(ctx) !== null;
  }

  /** 惰性解析服务：未就绪时返回 null，不抛错（老版本 DSH 根本没有这个服务）。 */
  function resolve(ctx) {
    if (service !== null) return service;
    try {
      const candidate = ctx?.get?.("pluginManager");
      if (candidate && typeof candidate.installBundle === "function") service = candidate;
    } catch {
      service = null;
    }
    return service;
  }

  /** 内置安装器是否可用（及是否具备安装能力）。 */
  function available() {
    return service !== null && typeof service.installBundle === "function";
  }

  /** 内置安装器管理的 profile 目录（宿主启动器提供；拿不到则为 null）。 */
  function profileDir() {
    return managedProfileDir;
  }

  /**
   * 安装一个 package spec（npm 包名 / github:owner/repo / tarball / 本地绝对路径）。
   * @param spec 包 spec。
   * @param options.activate 是否在安装后立即启用（默认 true，交给服务决定能否热重载）。
   * @returns { ok, unavailable, application, changed, code, error, needsRestart }
   */
  async function installBundle(spec, options = {}) {
    const target = String(spec ?? "").trim();
    if (target.length === 0) return { ok: false, unavailable: false, error: "empty spec" };
    if (!available()) return { ok: false, unavailable: true, error: "pluginManager service unavailable" };
    try {
      const raw = await service.installBundle(target, { activate: options.activate !== false });
      return { unavailable: false, raw, ...normalizeResult(raw) };
    } catch (error) {
      return {
        ok: false,
        unavailable: false,
        application: "failed",
        code: typeof error?.code === "string" ? error.code : null,
        error: shortError(error),
        needsRestart: false,
        changed: false,
      };
    }
  }

  /**
   * 卸载一个已安装的 bundle 依赖（服务会先卸载运行时贡献，再执行 pnpm remove）。
   * @param name 已安装依赖名（package.json 依赖键名）。
   */
  async function removeBundle(name) {
    const target = String(name ?? "").trim();
    if (target.length === 0) return { ok: false, unavailable: false, error: "empty name" };
    if (service === null || typeof service.removeBundle !== "function") {
      return { ok: false, unavailable: true, error: "pluginManager service unavailable" };
    }
    try {
      const raw = await service.removeBundle(target);
      return { unavailable: false, raw, ...normalizeResult(raw) };
    } catch (error) {
      return {
        ok: false,
        unavailable: false,
        application: "failed",
        code: typeof error?.code === "string" ? error.code : null,
        error: shortError(error),
        needsRestart: false,
        changed: false,
      };
    }
  }

  /**
   * 安装前的 spec 探测（注册表包/本地路径可答复名字、版本、是否 bundle；git 只答复形式与 host）。
   * 仅供提示与诊断，失败一律返回 { ok: false }——不阻断安装。
   */
  async function inspect(spec) {
    const target = String(spec ?? "").trim();
    if (target.length === 0) return { ok: false, error: "empty spec" };
    if (service === null || typeof service.inspect !== "function") {
      return { ok: false, unavailable: true, error: "pluginManager service unavailable" };
    }
    try {
      return { ok: true, info: await service.inspect(target) };
    } catch (error) {
      return { ok: false, unavailable: false, error: shortError(error) };
    }
  }

  return {
    attach,
    resolve,
    available,
    profileDir,
    installBundle,
    removeBundle,
    inspect,
    /** 供测试注入伪服务（不经过 cordis 上下文）。 */
    _setService(candidate) { service = candidate ?? null; },
    _setProfileDir(dir) { managedProfileDir = typeof dir === "string" ? dir : null; },
  };
}
