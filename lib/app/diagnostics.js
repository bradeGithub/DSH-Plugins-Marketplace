const DEFAULT_LOG_LINE_MAX = 4096;
const DEFAULT_RECENT_LOG_MAX = 400;
const DEFAULT_RECENT_EVENT_MAX = 400;

export function createDiagnosticsRuntime({
  platform = process.platform,
  nodeVersion = process.version,
  readOwnVersion,
  readFile,
  joinPath,
  profileNodeModules,
  probe,
  now = () => new Date(),
  logLineMax = DEFAULT_LOG_LINE_MAX,
  recentLogMax = DEFAULT_RECENT_LOG_MAX,
  recentEventMax = DEFAULT_RECENT_EVENT_MAX
}) {
  let envProfileCache = null;
  let recentLogs = [];
  let recentEvents = [];

  function baseProfile() {
    return {
      platform,
      node: nodeVersion,
      market: readOwnVersion() ?? "unknown"
    };
  }

  async function buildEnvProfileAsync() {
    if (envProfileCache) return envProfileCache;
    const profile = baseProfile();
    try {
      const dshPkg = JSON.parse(await readFile(joinPath(profileNodeModules(), "@deepseek-ai", "dsh", "package.json"), "utf8"));
      if (typeof dshPkg.version === "string") profile.dsh = dshPkg.version;
    } catch {}
    profile.pnpm = await probe("pnpm", ["--version"]);
    profile.git = await probe("git", ["--version"]);
    envProfileCache = profile;
    return profile;
  }

  function buildEnvProfile() {
    return envProfileCache ?? baseProfile();
  }

  function pushLog(line) {
    recentLogs.push(`[${now().toISOString()}] ${String(line ?? "").slice(0, logLineMax)}`);
    if (recentLogs.length > recentLogMax) recentLogs.splice(0, recentLogs.length - recentLogMax);
  }

  function getRecentLogs() {
    return recentLogs.slice();
  }

  function pushEvent({ event, level = "info", error_code = null, trace_id = null, duration_ms = null, message = "" }) {
    const entry = {
      event: String(event ?? ""),
      level: String(level ?? "info"),
      error_code: error_code == null ? null : String(error_code),
      trace_id: trace_id == null ? null : String(trace_id),
      duration_ms: duration_ms == null ? null : Number(duration_ms),
      message: String(message ?? "").slice(0, logLineMax),
      at: now().toISOString()
    };
    recentEvents.push(entry);
    if (recentEvents.length > recentEventMax) recentEvents.splice(0, recentEvents.length - recentEventMax);
  }

  function getRecentEvents() {
    return recentEvents.map((entry) => ({ ...entry }));
  }

  return {
    buildEnvProfileAsync,
    buildEnvProfile,
    pushLog,
    getRecentLogs,
    pushEvent,
    getRecentEvents
  };
}
