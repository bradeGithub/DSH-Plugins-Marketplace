import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { registerRoutes } from "../../../lib/http/routes.js";
import { MARKETPLACE_RESPONSE_SCHEMA_VERSION } from "../../../lib/http/marketplace-contract.js";
import { inspectMarketplacePayload } from "../contracts/marketplace.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const routesSource = readFileSync(join(ROOT, "lib", "http", "routes.js"), "utf8");

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

function makeResponse() {
  return {
    status: 0,
    value: null,
    writeHead(status) { this.status = status; },
    end(body) {
      try { this.value = JSON.parse(body); } catch { this.value = body; }
    }
  };
}

function makeDeps(overrides = {}) {
  const registered = [];
  const calls = [];
  const events = [];
  const state = {
    installMutex: {
      isBusy: () => false,
      run: async (fn) => await fn()
    },
    getRecentLogs: () => [],
    MARKET_ROOT: "/dsh/market",
    DSH_HOME: "/dsh",
    CACHE_DIR: "/dsh/cache",
    SKILLS_DIR: "/dsh/skills",
    PRESETS_DIR: "/dsh/presets"
  };
  const deps = {
    webServer: { register: (route) => registered.push(route) },
    logger: { info: () => {}, warn: () => {} },
    http: {
      json: (res, status, value) => {
        res.writeHead(status);
        res.end(JSON.stringify(value));
        return value;
      },
      readJsonBody: async (req) => req.body ?? {}
    },
    i18n: {
      t: (_lang, key, params = {}) => `${key}${params.err ? `:${params.err}` : ""}`,
      langOf: () => "zh"
    },
    auth: {
      isTrustedRequest: () => true,
      isWriteAllowed: async () => true
    },
    state,
    profile: {
      PROFILE_NAME_RE: /^[a-zA-Z0-9_-]+$/,
      profileName: () => "web",
      profileDir: (name = "web") => `/dsh/profiles/${name}`,
      profileNodeModules: (name = "web") => `/dsh/profiles/${name}/node_modules`,
      profilePatchFile: (name = "web") => `/dsh/profiles/${name}/cordis.patch.yml`,
      profilePackageFile: (name = "web") => `/dsh/profiles/${name}/package.json`,
      setTargetProfile: () => {},
      resolveRecordNodeModules: () => "/dsh/profiles/web/node_modules"
    },
    installed: {
      getInstalledRecord: () => null,
      hasInstalledRecord: () => false
    },
    list: {
      getList: async () => [],
      getListCacheState: () => ({ at: 1, source: "registry", repos: [] }),
      invalidateProfileCaches: () => {},
      applyAdaptorList: (repos) => repos,
      withStableProfileState: async (fn) => await fn(),
      scanProfilePackages: async () => new Map(),
      matchProfileEntry: async () => null,
      annotateInstalled: async () => false,
      annotateSkillInstalled: async () => false,
      detectSkillInstalled: async () => false,
      dedupeReposByPkgName: (repos) => ({ repos, dropped: [] }),
      warnDroppedPackageConflicts: () => {},
      listFingerprint: () => "fp"
    },
    useCases: {
      update: {
        getState: () => ({ checkedAt: Date.now(), updateAvailable: false }),
        check: async () => {},
        run: async () => ({ status: "no-update", latestVersion: "1.0.0" }),
        closeState: () => {}
      },
      backup: {
        buildBackup: () => ({ app: "dsh-plugin-marketplace", repos: [] }),
        isValidBackup: () => true,
        diffBackup: () => ({ missing: [], already: [], log: [] }),
        pushWebdav: async () => ({ status: "done" }),
        restoreWebdav: async () => ({ status: "done", missing: [], already: [], log: [] })
      },
      feedback: {
        getPending: () => [],
        getState: () => ({ hasToken: false }),
        submitFeedback: async () => ({ status: "done", issueUrl: null }),
        setToken: async () => ({ status: "done", hasToken: false })
      },
      envEdit: {
        getStored: () => ({}),
        applyEnvEdit: async () => ({ status: "done", applied: [], restartRequired: true })
      },
      prepareInstall: async () => ({ cacheDir: "/dsh/cache/x" }),
      installCli: async () => ({ status: "continue", cacheDir: "/dsh/cache/x", cliCommand: null, npmTargetUsed: null }),
      preflight: async () => ({ status: "continue", type: "skill", scannedVars: [], cliCommand: null }),
      install: async () => ({ status: "done" }),
      uninstall: async () => ({ status: "done", removed: 1 })
    },
    helpers: {
      adaptorRedirectRepo: () => null,
      slugify: (value) => String(value).toLowerCase(),
      normalizeRepoRef: (value) => String(value),
      readPackageVersion: async () => null,
      fetchNpmLatest: async () => null,
      scanRequirements: async () => [],
      sanitizeLog: (value) => value,
      classifyInstallFailure: () => null,
      compareVersions: (a, b) => (a === b ? 0 : a < b ? -1 : 1),
      pushLog: () => {},
      pushEvent: (event) => events.push(event),
      safeAssign: (target, ...sources) => Object.assign(target, ...sources)
    },
    fs: {
      stat: async () => ({ isDirectory: () => true }),
      readFile: async () => "{}",
      writeFile: async () => {},
      rm: async () => {},
      join,
      resolve: (value) => value,
      sep: "/"
    },
    constants: { LOG_LINE_MAX: 4096 },
    ...overrides
  };
  return { deps, registered, calls, state, events };
}

const expectedPaths = [
  "/api/marketplace/self-update",
  "/api/marketplace/list",
  "/api/marketplace/skills",
  "/api/marketplace/backup",
  "/api/marketplace/restore/diff",
  "/api/marketplace/backup/webdav",
  "/api/marketplace/restore/webdav",
  "/api/marketplace/logs",
  "/api/marketplace/feedback/pending",
  "/api/marketplace/feedback",
  "/api/marketplace/feedback/token",
  "/api/marketplace/env-keys",
  "/api/marketplace/profile",
  "/api/marketplace/check-update",
  "/api/marketplace/env-edit",
  "/api/marketplace/install",
  "/api/marketplace/uninstall"
];

{
  const { deps, registered } = makeDeps();
  registerRoutes(deps);
  check("注册 17 个路由", registered.length, 17);
  check("路由路径、顺序和唯一性", registered.map((route) => route.path), expectedPaths);
  check("全部路由为 exact 且有 handler", registered.every((route) => route.kind === "exact" && typeof route.handler === "function"), true);
}

check("routes 不反向导入 index", /from\s+["']\.\.\/index\.js["']/.test(routesSource), false);
check("routes 不创建互斥或队列", /create(?:Mutex|Queue)\s*\(/.test(routesSource), false);
check("routes 不直接持有近期日志数组", /recentLogs/.test(routesSource), false);
check("routes 统一通过正式版本响应包装器", (routesSource.match(/\bjson\(res,/g) ?? []).length, 1);

{
  const { deps, registered } = makeDeps();
  let snapshotCalls = 0;
  deps.state.getRecentLogs = () => {
    snapshotCalls++;
    return ["log line", "second line"];
  };
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/logs");
  const res = makeResponse();
  await route.handler({ method: "GET", url: route.path }, res);
  check("logs 只读取一次 detached snapshot", snapshotCalls, 1);
  check("logs 保持文本与 count，并带正式响应版本", res.value, {
    status: "done",
    text: "log line\nsecond line",
    count: 2,
    log: ["logsExported"],
    schemaVersion: MARKETPLACE_RESPONSE_SCHEMA_VERSION
  });
}

{
  const { deps, registered } = makeDeps();
  registerRoutes(deps);
  for (const [path, kind] of [["/api/marketplace/list", "list"], ["/api/marketplace/skills", "skills"]]) {
    const route = registered.find((item) => item.path === path);
    const res = makeResponse();
    await route.handler({ method: "GET", url: path }, res);
    check(`${kind} handler 输出满足共享契约`, inspectMarketplacePayload(kind, res.value).ok, true);
    check(`${kind} handler 使用正式 schemaVersion`, res.value.schemaVersion, MARKETPLACE_RESPONSE_SCHEMA_VERSION);
  }
}

{
  // route 最终排序：已装优先，否则按 stargazers 降序（去重后的整表排序，domain 层不含）
  const repos = [
    { full_name: "b/high", name: "high", stargazers_count: 999, installedMarker: null },
    { full_name: "a/inst", name: "inst", stargazers_count: 1, installedMarker: null },
    { full_name: "c/low", name: "low", stargazers_count: 1, installedMarker: null }
  ];
  const { deps, registered } = makeDeps({
    list: {
      ...makeDeps().deps.list,
      getList: async () => repos,
      annotateInstalled: async (repo) => repo.full_name === "a/inst",
      dedupeReposByPkgName: (flagged) => ({ repos: flagged, dropped: [] })
    }
  });
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/list");
  const res = makeResponse();
  await route.handler({ method: "GET", url: "/api/marketplace/list" }, res);
  const order = res.value.repos.map((r) => r.full_name);
  check("list 已装优先排序", order.indexOf("a/inst"), 0);
  check("list 未装按 stars 降序", [order[1], order[2]], ["b/high", "c/low"]);
}

{
  const { deps, registered } = makeDeps();
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/list");
  const res = makeResponse();
  await route.handler({ method: "POST", url: "/api/marketplace/list" }, res);
  check("list 非 GET 返回 405", res.status, 405);
}

{
  const { deps, registered } = makeDeps({
    list: { ...makeDeps().deps.list, getList: async () => { throw new Error("boom"); } }
  });
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/list");
  const res = makeResponse();
  await route.handler({ method: "GET", url: "/api/marketplace/list" }, res);
  check("list 加载失败返回 500", res.status, 500);
  check("list 失败文案走 listFail", String(res.value?.error), "listFail:boom");
}

{
  const { deps, registered } = makeDeps({
    list: { ...makeDeps().deps.list, getList: async () => { throw new Error("boom"); } }
  });
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/skills");
  const res = makeResponse();
  await route.handler({ method: "GET", url: "/api/marketplace/skills" }, res);
  check("skills 加载失败返回 500", res.status, 500);
}

// skills 200 成功分支：非分页（无 page/pageSize/q）→ flagWorker 并发标注 + dedupe + 排序
{
  const skillRepos = [
    { full_name: "a/skill-a", name: "skill-a", has_skill: true, stargazers_count: 5 },
    { full_name: "b/skill-b", name: "skill-b", has_skill: true, stargazers_count: 10 },
    { full_name: "c/not-skill", name: "not-skill", has_skill: false, stargazers_count: 100 }
  ];
  let annotateCalls = 0;
  const { deps, registered } = makeDeps({
    list: {
      ...makeDeps().deps.list,
      getList: async () => skillRepos,
      detectSkillInstalled: async () => { annotateCalls++; return true; }
    }
  });
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/skills");
  const res = makeResponse();
  await route.handler({ method: "GET", url: "/api/marketplace/skills" }, res);
  check("skills 非分页 200", res.status, 200);
  check("skills 非分页过滤 has_skill=false", res.value?.repos?.length, 2);
  check("skills 非分页标注 installed", res.value?.repos?.every((r) => r.installed === true), true);
  check("skills 非分页并发标注调用", annotateCalls, 2);
  check("skills 非分页已装优先排序", res.value?.repos?.[0]?.full_name, "b/skill-b");
  check("skills 非分页 total 与 filtered", [res.value?.total, res.value?.filtered], [2, 2]);
}

// skills 200 分页分支（page/pageSize）→ 分页切片 + annotateSkillInstalled 标注
{
  const skillRepos = Array.from({ length: 5 }, (_, i) => ({
    full_name: `a/skill-${i}`, name: `skill-${i}`, has_skill: true, stargazers_count: i
  }));
  let annotateCalls = 0;
  const { deps, registered } = makeDeps({
    list: {
      ...makeDeps().deps.list,
      getList: async () => skillRepos,
      annotateSkillInstalled: async () => { annotateCalls++; return false; }
    }
  });
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/skills");
  const res = makeResponse();
  await route.handler({ method: "GET", url: "/api/marketplace/skills?page=1&pageSize=2" }, res);
  check("skills 分页 200", res.status, 200);
  check("skills 分页每页≤2", res.value?.repos?.length, 2);
  check("skills 分页 total=5", res.value?.total, 5);
  check("skills 分页 page/pageSize 回显", [res.value?.page, res.value?.pageSize], [1, 2]);
  check("skills 分页 annotateSkillInstalled 调用", annotateCalls, 2);
}

// skills 200 q 过滤分支（?q=）→ 过滤回调 + 分页 dedupe 回调（hasInstalledRecord 命中）
{
  const { dedupeReposByPkgName } = await import("../../../lib/domain/list.js");
  const skillRepos = [
    { full_name: "a/pdf-tool", name: "pdf-tool", has_skill: true, stargazers_count: 5, pkg_name: "shared-pdf" },
    { full_name: "b/image-tool", name: "image-tool", has_skill: true, stargazers_count: 10 },
    { full_name: "c/pdf-helper", name: "pdf-helper", has_skill: true, stargazers_count: 1, pkg_name: "shared-pdf" }
  ];
  const { deps, registered } = makeDeps({
    list: {
      ...makeDeps().deps.list,
      getList: async () => skillRepos,
      dedupeReposByPkgName
    },
    installed: {
      ...makeDeps().deps.installed,
      hasInstalledRecord: (fullName) => fullName === "a/pdf-tool"
    }
  });
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/skills");
  const res = makeResponse();
  await route.handler({ method: "GET", url: "/api/marketplace/skills?q=pdf&page=1&pageSize=10" }, res);
  check("skills q 过滤 200", res.status, 200);
  check("skills q 过滤 dedupe 去重同 pkg", res.value?.repos?.map((r) => r.full_name), ["a/pdf-tool"]);
  check("skills q 过滤 total=1", res.value?.total, 1);
  check("skills q 过滤 dropped=1", res.value?.dropped, 1);
  check("skills q 过滤 filtered=2", res.value?.filtered, 2);
}

{
  const { deps, registered } = makeDeps();
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/check-update");
  const res = makeResponse();
  await route.handler({ method: "POST", url: route.path, body: { repo: "missing/owner" } }, res);
  check("check-update 未安装返回 404", res.status, 404);
}

{
  const { deps, registered } = makeDeps({
    auth: { isTrustedRequest: () => false, isWriteAllowed: async () => false }
  });
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/backup");
  const res = makeResponse();
  await route.handler({ method: "GET", url: "/api/marketplace/backup" }, res);
  check("backup 未通过只读鉴权返回 403", res.status, 403);
}

{
  let writeChecks = 0;
  const { deps, registered } = makeDeps({
    auth: {
      isTrustedRequest: () => true,
      isWriteAllowed: async () => { writeChecks++; return false; }
    }
  });
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/install");
  const res = makeResponse();
  await route.handler({ method: "POST", url: "/api/marketplace/install" }, res);
  check("install 未通过写鉴权返回 403", res.status, 403);
  check("install 经过写鉴权函数", writeChecks, 1);
}

{
  const backup = { app: "dsh-plugin-marketplace", repos: [{ repo: "a/b" }] };
  const { deps, registered } = makeDeps({
    useCases: {
      ...makeDeps().deps.useCases,
      backup: { ...makeDeps().deps.useCases.backup, buildBackup: () => backup }
    }
  });
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/backup");
  const res = makeResponse();
  await route.handler({ method: "GET", url: "/api/marketplace/backup" }, res);
  check("backup handler 转接 app 结果", res.value?.backup, backup);
  check("backup handler 输出满足共享契约", inspectMarketplacePayload("backup", res.value).ok, true);
  check("backup handler 返回 200", res.status, 200);
}

{
  const feedbackResult = { status: "done", issueUrl: "https://example.invalid/issue" };
  const { deps, registered } = makeDeps({
    useCases: {
      ...makeDeps().deps.useCases,
      feedback: {
        ...makeDeps().deps.useCases.feedback,
        submitFeedback: async (input) => {
          check("feedback 参数转接", input, { repo: "a/b", ok: true, note: "ok", lang: "zh" });
          return feedbackResult;
        }
      }
    }
  });
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/feedback");
  const res = makeResponse();
  await route.handler({ method: "POST", url: "/api/marketplace/feedback", body: { repo: "a/b", ok: true, note: "ok" } }, res);
  check("feedback handler 转接 app 结果并附版本", res.value, {
    ...feedbackResult,
    schemaVersion: MARKETPLACE_RESPONSE_SCHEMA_VERSION
  });
  check("feedback handler 输出满足共享契约", inspectMarketplacePayload("feedback", res.value).ok, true);
  check("feedback handler 返回 200", res.status, 200);
}

{
  const { deps, registered } = makeDeps();
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/self-update");
  const res = makeResponse();
  await route.handler({
    method: "POST",
    url: "/api/marketplace/self-update",
    headers: {},
    socket: { remoteAddress: "127.0.0.1" }
  }, res);
  check("self-update 无更新转接 no-update", res.value?.status, "no-update");
  check("self-update 输出满足共享契约", inspectMarketplacePayload("selfUpdate", res.value).ok, true);
}

{
  const { deps, registered, events } = makeDeps();
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/install");
  const res = makeResponse();
  await route.handler({ method: "POST", url: "/api/marketplace/install", body: { repo: "bad" } }, res);
  check("install 非法 repo 返回 400", res.status, 400);
  check("install 非法 repo 错误满足共享契约", inspectMarketplacePayload("error", res.value).ok, true);
  check("install 非法 repo 不产生事件", events.length, 0);
}

{
  const { deps, registered, events } = makeDeps();
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/install");
  const res = makeResponse();
  await route.handler({
    method: "POST",
    url: "/api/marketplace/install",
    body: { repo: "fixture-owner/fixture-ready" }
  }, res);
  check("install 完成返回 200", res.status, 200);
  check("install done 事件名与级别", [events[0]?.event, events[0]?.level], ["install.done", "info"]);
  check("install done 无 error_code", events[0]?.error_code, null);
  check("install done 带非负 duration_ms", typeof events[0]?.duration_ms === "number" && events[0]?.duration_ms >= 0, true);
}

{
  const { deps, registered, events } = makeDeps({
    useCases: {
      ...makeDeps().deps.useCases,
      install: async () => ({ status: "failed" })
    }
  });
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/install");
  const res = makeResponse();
  await route.handler({
    method: "POST",
    url: "/api/marketplace/install",
    body: { repo: "bad/install" }
  }, res);
  check("install 返回 failed 时事件为 install.failed", events[0]?.event, "install.failed");
  check("install 返回 failed 时 level=error", events[0]?.level, "error");
}

{
  const { deps, registered, events } = makeDeps({
    useCases: {
      ...makeDeps().deps.useCases,
      install: async () => { throw new Error("boom"); }
    }
  });
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/install");
  const res = makeResponse();
  await route.handler({
    method: "POST",
    url: "/api/marketplace/install",
    body: { repo: "bad/throw" }
  }, res);
  check("install 抛错时事件为 install.failed", events[0]?.event, "install.failed");
  check("install 抛错时 error_code=install_failed", events[0]?.error_code, "install_failed");
}

{
  const { deps, registered, events } = makeDeps({
    useCases: {
      ...makeDeps().deps.useCases,
      install: async () => ({ status: "manual" })
    }
  });
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/install");
  const res = makeResponse();
  await route.handler({
    method: "POST",
    url: "/api/marketplace/install",
    body: { repo: "bad/manual" }
  }, res);
  check("install manual 事件名与级别", [events[0]?.event, events[0]?.level], ["install.manual", "info"]);
}

{
  const { deps, registered, events } = makeDeps({
    useCases: {
      ...makeDeps().deps.useCases,
      install: async () => ({ status: "aborted" })
    }
  });
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/install");
  const res = makeResponse();
  await route.handler({
    method: "POST",
    url: "/api/marketplace/install",
    body: { repo: "bad/aborted" }
  }, res);
  check("install aborted 事件名与级别", [events[0]?.event, events[0]?.level], ["install.aborted", "info"]);
}

{
  const { deps, registered, events } = makeDeps({
    useCases: {
      ...makeDeps().deps.useCases,
      install: async () => ({ status: "awaiting-input" })
    }
  });
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/install");
  const res = makeResponse();
  await route.handler({
    method: "POST",
    url: "/api/marketplace/install",
    body: { repo: "bad/awaiting" }
  }, res);
  check("install awaiting-input 事件名与级别", [events[0]?.event, events[0]?.level], ["install.awaiting-input", "info"]);
}

{
  const { deps, registered } = makeDeps();
  deps.useCases.backup.pushWebdav = async () => ({ status: "invalid-url" });
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/backup/webdav");
  const res = makeResponse();
  await route.handler({ method: "POST", url: route.path, body: { url: "ftp://example.invalid" } }, res);
  check("backup WebDAV 非法 URL 返回 400", res.status, 400);
}

{
  const { deps, registered } = makeDeps();
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/feedback");
  const res = makeResponse();
  await route.handler({ method: "POST", url: route.path, body: { repo: "" } }, res);
  check("feedback 空 repo 返回 400", res.status, 400);
}

{
  const { deps, registered } = makeDeps();
  deps.state.installMutex.isBusy = () => true;
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/profile");
  const res = makeResponse();
  await route.handler({ method: "POST", url: route.path, body: { profile: "web" } }, res);
  check("profile 互斥时返回 409", res.status, 409);
}

{
  const { deps, registered } = makeDeps();
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/profile");
  const res = makeResponse();
  await route.handler({ method: "POST", url: route.path, body: { profile: ".." } }, res);
  check("profile 非法名返回 400", res.status, 400);
}

{
  const { deps, registered } = makeDeps();
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/profile");
  const res = makeResponse();
  await route.handler({ method: "GET", url: route.path }, res);
  check("profile GET 返回当前名", [res.status, res.value?.profile], [200, "web"]);
}

{
  const { deps, registered } = makeDeps({
    fs: { ...makeDeps().deps.fs, writeFile: async () => { throw new Error("disk full"); } }
  });
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/profile");
  const res = makeResponse();
  await route.handler({ method: "POST", url: route.path, body: { profile: "web" } }, res);
  check("profile 写盘失败返回 500", res.status, 500);
}

{
  const { deps, registered } = makeDeps();
  deps.useCases.envEdit.applyEnvEdit = async () => ({ status: "not-installed" });
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/env-edit");
  const res = makeResponse();
  await route.handler({ method: "POST", url: route.path, body: { repo: "a/b", values: {} } }, res);
  check("env-edit 未安装映射 404", res.status, 404);
  check("env-edit 错误满足共享契约", inspectMarketplacePayload("error", res.value).ok, true);
}

{
  const { deps, registered, events } = makeDeps();
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/uninstall");
  const res = makeResponse();
  await route.handler({ method: "POST", url: route.path, body: { repo: "a/b" } }, res);
  check("uninstall done 事件名与级别", [events[0]?.event, events[0]?.level], ["uninstall.done", "info"]);
  check("uninstall done 无 error_code", events[0]?.error_code, null);
}

{
  const { deps, registered, events } = makeDeps({
    useCases: {
      ...makeDeps().deps.useCases,
      uninstall: async () => ({ status: "failed", removed: 0 })
    }
  });
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/uninstall");
  const res = makeResponse();
  await route.handler({ method: "POST", url: route.path, body: { repo: "a/b" } }, res);
  check("uninstall failed 事件名/级别/error_code", [events[0]?.event, events[0]?.level, events[0]?.error_code], ["uninstall.failed", "error", "uninstall_failed"]);
}

{
  const { deps, registered, events } = makeDeps({
    useCases: {
      ...makeDeps().deps.useCases,
      update: {
        ...makeDeps().deps.useCases.update,
        getState: () => ({ checkedAt: 0, updateAvailable: true }),
        run: async () => ({ status: "done", installedVersion: "1.2.0" })
      }
    }
  });
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/self-update");
  const res = makeResponse();
  await route.handler({ method: "POST", url: route.path }, res);
  check("self-update done 事件名与级别", [events[0]?.event, events[0]?.level], ["self_update.done", "info"]);
  check("self-update done 带非负 duration_ms", typeof events[0]?.duration_ms === "number" && events[0]?.duration_ms >= 0, true);
}

{
  const { deps, registered, events } = makeDeps({
    useCases: {
      ...makeDeps().deps.useCases,
      update: {
        ...makeDeps().deps.useCases.update,
        run: async () => { throw new Error("boom"); }
      }
    }
  });
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/self-update");
  const res = makeResponse();
  await route.handler({ method: "POST", url: route.path }, res);
  check("self-update failed 事件名/级别/error_code", [events[0]?.event, events[0]?.level, events[0]?.error_code], ["self_update.failed", "error", "self_update_fail"]);
}

{
  const { deps, registered, events } = makeDeps();
  deps.helpers.readOwnVersion = () => "1.5.5";
  deps.useCases.update.run = async () => { throw new Error("staged package incomplete"); };
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/self-update");
  const res = makeResponse();
  await route.handler({ method: "POST", url: route.path }, res);
  check("self-update 版本校验失败 error_code 为 version_fail", events[0]?.error_code, "self_update_version_fail");
  check("self-update 版本校验失败仍标记 failed", res.value?.status, "failed");
  check("self-update 版本校验失败返回 500", res.status, 500);
}

{
  const { deps, registered, events } = makeDeps({
    useCases: {
      ...makeDeps().deps.useCases,
      feedback: {
        ...makeDeps().deps.useCases.feedback,
        submitFeedback: async () => ({ status: "not-found", issueUrl: null, error: "not found" })
      }
    }
  });
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/feedback");
  const res = makeResponse();
  await route.handler({ method: "POST", url: route.path, body: { repo: "a/b", ok: true } }, res);
  check("feedback not_found 事件名/级别/error_code", [events[0]?.event, events[0]?.level, events[0]?.error_code], ["feedback.not_found", "warn", "feedback_not_found"]);
}

{
  const { deps, registered, events } = makeDeps();
  deps.installed.getInstalledRecord = () => ({ type: "cli", name: "pkg-a", version: "1.0.0" });
  deps.helpers.readPackageVersion = async () => "1.0.0";
  deps.helpers.fetchNpmLatest = async () => "1.1.0";
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/check-update");
  const res = makeResponse();
  await route.handler({ method: "POST", url: route.path, body: { repo: "a/b" } }, res);
  check("check-update done 事件名与级别", [events[0]?.event, events[0]?.level], ["check_update.done", "info"]);
}

{
  const { deps, registered } = makeDeps({
    http: { ...makeDeps().deps.http, readJsonBody: async () => { throw { status: 413 }; } }
  });
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/feedback");
  const res = makeResponse();
  await route.handler({ method: "POST", url: route.path, body: { repo: "a/b", note: "x" } }, res);
  check("feedback 超大 body 返回 413", res.status, 413);
  check("feedback 413 文案映射 bodyTooLarge", res.value?.error, "bodyTooLarge");
}

{
  const { deps, registered } = makeDeps({
    http: { ...makeDeps().deps.http, readJsonBody: async () => { throw { status: 413 }; } }
  });
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/env-edit");
  const res = makeResponse();
  await route.handler({ method: "POST", url: route.path, body: { repo: "a/b", values: {} } }, res);
  check("env-edit 超大 body 返回 413", res.status, 413);
  check("env-edit 413 文案映射 bodyTooLarge", res.value?.error, "bodyTooLarge");
}

{
  const { deps, registered } = makeDeps({
    http: { ...makeDeps().deps.http, readJsonBody: async () => { throw { status: 413 }; } }
  });
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/install");
  const res = makeResponse();
  await route.handler({ method: "POST", url: route.path, body: { repo: "a/b" } }, res);
  check("install 超大 body 返回 413", res.status, 413);
  check("install 413 文案映射 bodyTooLarge", res.value?.error, "bodyTooLarge");
}

{
  const { deps, registered } = makeDeps({
    state: { ...makeDeps().deps.state, installMutex: { isBusy: () => true, run: async (f) => await f() } }
  });
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/self-update");
  const res = makeResponse();
  await route.handler({ method: "POST", url: route.path }, res);
  check("self-update 互斥时返回 409", res.status, 409);
}

{
  const { deps, registered, events } = makeDeps({
    state: { ...makeDeps().deps.state, installMutex: { isBusy: () => true, run: async (f) => await f() } }
  });
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/install");
  const res = makeResponse();
  await route.handler({ method: "POST", url: route.path, body: { repo: "a/b" } }, res);
  check("install 互斥时返回 409", res.status, 409);
  check("install 409 不发 install 事件", events.length, 0);
}

{
  const { deps, registered, events } = makeDeps({
    state: { ...makeDeps().deps.state, installMutex: { isBusy: () => true, run: async (f) => await f() } }
  });
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/uninstall");
  const res = makeResponse();
  await route.handler({ method: "POST", url: route.path, body: { repo: "a/b" } }, res);
  check("uninstall 互斥时返回 409", res.status, 409);
  check("uninstall 409 不发事件", events.length, 0);
}

{
  const { deps, registered } = makeDeps();
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/env-keys");
  const res = makeResponse();
  await route.handler({ method: "GET", url: "/api/marketplace/env-keys?repo=bad" }, res);
  check("env-keys 非法 repo 返回 400", res.status, 400);
}

{
  const { deps, registered } = makeDeps();
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/env-keys");
  const res = makeResponse();
  await route.handler({ method: "GET", url: "/api/marketplace/env-keys?repo=a%2Fb" }, res);
  check("env-keys 未安装返回 200 空键", [res.status, res.value?.envKeys], [200, []]);
}

{
  // managed 目录内的已装插件无 envKeys 时，env-keys 触发 requirements 扫描
  const { deps, registered } = makeDeps();
  deps.installed.getInstalledRecord = () => ({ type: "plugin", location: "/dsh/profiles/web/node_modules/owner/demo", envKeys: null });
  deps.helpers.scanRequirements = async () => ["API_KEY", "TOKEN"];
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/env-keys");
  const res = makeResponse();
  await route.handler({ method: "GET", url: "/api/marketplace/env-keys?repo=owner%2Fdemo" }, res);
  check("env-keys managed 目录触发扫描", res.value?.envKeys, ["API_KEY", "TOKEN"]);
  check("env-keys 扫描键映射 configured", res.value?.configured, { API_KEY: false, TOKEN: false });
}

{
  // 非 managed 目录的已装插件不触发扫描，返回空键
  const { deps, registered } = makeDeps();
  deps.installed.getInstalledRecord = () => ({ type: "plugin", location: "/outside/owner/demo", envKeys: null });
  let scanned = 0;
  deps.helpers.scanRequirements = async () => { scanned++; return ["API_KEY"]; };
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/env-keys");
  const res = makeResponse();
  await route.handler({ method: "GET", url: "/api/marketplace/env-keys?repo=owner%2Fdemo" }, res);
  check("env-keys 非 managed 目录不扫描", [res.value?.envKeys, scanned], [[], 0]);
}

{
  const { deps, registered } = makeDeps();
  deps.useCases.backup.isValidBackup = () => false;
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/restore/diff");
  const res = makeResponse();
  await route.handler({ method: "POST", url: route.path, body: { backup: null } }, res);
  check("restore/diff 非法 backup 返回 400", res.status, 400);
}

{
  const { deps, registered } = makeDeps();
  registerRoutes(deps);
  const route = registered.find((item) => item.path === "/api/marketplace/restore/diff");
  const res = makeResponse();
  const diff = { missing: ["a/b"], already: [], log: [] };
  deps.useCases.backup.isValidBackup = () => true;
  deps.useCases.backup.diffBackup = () => diff;
  await route.handler({
    method: "POST",
    url: route.path,
    body: { backup: { app: "dsh-plugin-marketplace", repos: [{ repo: "a/b" }] } }
  }, res);
  check("restore/diff 转接 app 结果并附版本", res.value, { status: "done", ...diff, schemaVersion: MARKETPLACE_RESPONSE_SCHEMA_VERSION });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
