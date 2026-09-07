import { withMarketplaceResponseSchema } from "./marketplace-contract.js";

export function registerRoutes({
  webServer,
  logger,
  http: { json, readJsonBody },
  i18n: { t, langOf },
  auth: { isTrustedRequest, isWriteAllowed },
  state: {
    installMutex,
    getRecentLogs,
    MARKET_ROOT,
    DSH_HOME,
    CACHE_DIR,
    SKILLS_DIR,
    PRESETS_DIR
  },
  profile: {
    PROFILE_NAME_RE,
    profileName,
    profileDir,
    profileNodeModules,
    profilePatchFile,
    profilePackageFile,
    setTargetProfile,
    resolveRecordNodeModules
  },
  installed: { getInstalledRecord, hasInstalledRecord },
  list: {
    getList,
    getListCacheState,
    invalidateProfileCaches,
    applyAdaptorList,
    withStableProfileState,
    scanProfilePackages,
    matchProfileEntry,
    annotateInstalled,
    annotateSkillInstalled,
    detectSkillInstalled,
    dedupeReposByPkgName,
    warnDroppedPackageConflicts,
    listFingerprint
  },
  useCases: {
    update: runUpdateUseCase,
    backup: runBackupUseCase,
    feedback: feedbackUseCase,
    envEdit: envEditUseCase,
    prepareInstall: prepareInstallCache,
    installCli: runInstallCliFlow,
    preflight: runInstallPreflight,
    install: runInstallUseCase,
    uninstall: runUninstallUseCase
  },
  helpers: {
    adaptorRedirectRepo,
    slugify,
    normalizeRepoRef,
    readPackageVersion,
    readOwnVersion,
    compareVersions,
    fetchNpmLatest,
    scanRequirements,
    sanitizeLog,
    classifyInstallFailure,
    pushLog,
    pushEvent,
    safeAssign
  },
  fs: { stat, readFile, writeFile, rm, join, resolve, sep },
  constants: { LOG_LINE_MAX }
}) {
  const marketplaceJson = (res, status, payload) => json(res, status, withMarketplaceResponseSchema(payload));

  webServer.register({
    kind: "exact",
    path: "/api/marketplace/self-update",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: "" });
      if (req.method === "GET") {
        if (Date.now() - runUpdateUseCase.getState().checkedAt > 30 * 60 * 1000) {
          runUpdateUseCase.check().catch(() => {});
        }
        return marketplaceJson(res, 200, runUpdateUseCase.getState());
      }
      if (req.method !== "POST") return marketplaceJson(res, 405, { error: t(lang, "methodNotAllowed") });
      if (!(await isWriteAllowed(req))) return marketplaceJson(res, 403, { error: t(lang, "forbidden") });
      if (installMutex.isBusy()) return marketplaceJson(res, 409, { error: t(lang, "selfUpdateBusy") });
      return await installMutex.run(async () => {
        const t0 = Date.now();
        try {
          const result = await runUpdateUseCase.run();
          if (result.status === "no-update") {
            return marketplaceJson(res, 200, {
              status: "no-update",
              latestVersion: result.latestVersion,
              error: t(lang, "selfUpdateNone", { v: result.latestVersion ?? "?" })
            });
          }
          runUpdateUseCase.closeState(result);
          pushLog(`self-update: 已更新到 v${result.installedVersion}`);
          pushEvent({ event: "self_update.done", level: "info", duration_ms: Date.now() - t0, message: `已更新到 v${result.installedVersion}` });
          return marketplaceJson(res, 200, {
            status: "done",
            installedVersion: result.installedVersion,
            message: t(lang, "selfUpdateCopied", { new: result.installedVersion })
          });
        } catch (error) {
          const msg = String(error?.message ?? error);
          const versionFail = /staged package incomplete|Version check failed/i.test(msg);
          pushLog(`self-update: 失败 ${msg}`);
          pushEvent({ event: "self_update.failed", level: "error", error_code: versionFail ? "self_update_version_fail" : "self_update_fail", duration_ms: Date.now() - t0, message: msg });
          return marketplaceJson(res, 500, {
            status: "failed",
            error: t(
              lang,
              versionFail ? "selfUpdateVersionFail" : "selfUpdateFail",
              versionFail ? { got: "?", cur: readOwnVersion() ?? "?" } : { err: msg }
            )
          });
        }
      });
    }
  });

  webServer.register({
    kind: "exact",
    path: "/api/marketplace/list",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: new URL(req.url, "http://x").searchParams.get("lang") });
      if (req.method !== "GET") return marketplaceJson(res, 405, { error: t(lang, "methodNotAllowed") });
      try {
        const force = new URL(req.url, "http://x").searchParams.get("refresh") === "1";
        if (force) invalidateProfileCaches();
        const repos = applyAdaptorList(await getList("dsh", force));
        const { deduped, dropped } = await withStableProfileState(async () => {
          const profile = await scanProfilePackages();
          const flagged = new Array(repos.length);
          const workers = Math.min(12, repos.length);
          let cursor = 0;
          const worker = async () => {
            while (cursor < repos.length) {
              const idx = cursor++;
              const repo = repos[idx];
              const record = getInstalledRecord(repo.full_name);
              const slug = slugify(repo.name);
              const owner = slugify(String(repo.full_name).split("/")[0] ?? "");
              const cliTarget = record && record.type === "cli" ? String(record.name ?? "") : null;
              const cliNpmForm = cliTarget !== null && !/^[\w.-]+\/[\w.-]+$/.test(cliTarget);
              const versionedType = !cliNpmForm;
              let installedVersion = versionedType && record && record.version ? record.version : null;
              if (versionedType && !installedVersion) {
                const versionKeys = [slug, repo.name];
                if (repo.pkg_name) versionKeys.push(repo.pkg_name);
                if (repo.npm_pkg_name) versionKeys.push(repo.npm_pkg_name);
                const hit = await matchProfileEntry(profile, repo, versionKeys);
                installedVersion = hit && hit.version ? hit.version : null;
              }
              if (cliNpmForm) {
                const cliParts = cliTarget.split("/");
                if (cliParts.length > 2 || cliParts.some((s) => !/^@?[a-zA-Z0-9][a-zA-Z0-9._~-]*$/.test(s) || s === "." || s === "..")) {
                  installedVersion = null;
                } else {
                  installedVersion = await readPackageVersion(join(resolveRecordNodeModules(record), ...cliParts));
                }
              }
              const latestVersion = cliNpmForm
                ? (repo.npm_version ?? null)
                : (repo.version ?? (await readPackageVersion(join(CACHE_DIR, `${owner}__${slug}`))));
              const updateAvailable = Boolean(installedVersion && latestVersion && compareVersions(installedVersion, latestVersion) < 0);
              flagged[idx] = safeAssign({}, repo, {
                installed: await annotateInstalled(repo),
                installedVersion,
                latestVersion,
                updateAvailable,
                cliNpm: cliNpmForm
              });
            }
          };
          await Promise.all(Array.from({ length: workers }, () => worker()));
          const { repos: deduped, dropped } = dedupeReposByPkgName(flagged, (r) => r.installed === true);
          warnDroppedPackageConflicts(dropped);
          deduped.sort((a, b) => {
            if (a.installed !== b.installed) return a.installed ? -1 : 1;
            return (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0);
          });
          return { deduped, dropped };
        });
        marketplaceJson(res, 200, {
          repos: deduped,
          cached_at: getListCacheState("dsh").at,
          total: deduped.length,
          dropped: dropped.length,
          source: getListCacheState("dsh").source ?? "registry",
          fp: listFingerprint(deduped)
        });
      } catch (error) {
        marketplaceJson(res, 500, { error: t(lang, "listFail", { err: String(error?.message ?? error) }) });
      }
    }
  });

  webServer.register({
    kind: "exact",
    path: "/api/marketplace/skills",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: new URL(req.url, "http://x").searchParams.get("lang") });
      if (req.method !== "GET") return marketplaceJson(res, 405, { error: t(lang, "methodNotAllowed") });
      try {
        const params = new URL(req.url, "http://x").searchParams;
        const force = params.get("refresh") === "1";
        if (force) invalidateProfileCaches();
        const q = (params.get("q") ?? "").trim().toLowerCase();
        const page = Math.max(1, Number(params.get("page") ?? "1") || 1);
        const pageSize = Math.min(200, Math.max(1, Number(params.get("pageSize") ?? "100") || 100));
        const paged = params.has("page") || params.has("pageSize") || params.has("q");
        const repos = await getList("skills", force);
        let list = repos.filter((r) => r.has_skill !== false);
        if (q) {
          list = list.filter((r) =>
            (r.name + " " + r.full_name + " " + (r.topics || []).join(" ") + " " + (r.description || "")).toLowerCase().includes(q)
          );
        }
        if (!paged) {
          const flagged = new Array(list.length);
          const workers = Math.min(12, list.length);
          let cursor = 0;
          const flagWorker = async () => {
            while (cursor < list.length) {
              const idx = cursor++;
              const repo = list[idx];
              const record = getInstalledRecord(repo.full_name);
              flagged[idx] = safeAssign({}, repo, {
                installed: await detectSkillInstalled(repo),
                installedAt: record && record.installedAt ? record.installedAt : null
              });
            }
          };
          await Promise.all(Array.from({ length: workers }, () => flagWorker()));
          const { repos: deduped, dropped } = dedupeReposByPkgName(flagged, (r) => r.installed === true);
          warnDroppedPackageConflicts(dropped);
          deduped.sort((a, b) => {
            if (a.installed !== b.installed) return a.installed ? -1 : 1;
            return (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0);
          });
          marketplaceJson(res, 200, {
            repos: deduped,
            cached_at: getListCacheState("skills").at,
            total: deduped.length,
            filtered: list.length,
            dropped: dropped.length,
            source: getListCacheState("skills").source ?? "registry"
          });
          return;
        }
        const { repos: deduped, dropped } = dedupeReposByPkgName(list, (r) => hasInstalledRecord(r.full_name));
        warnDroppedPackageConflicts(dropped);
        deduped.sort((a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0));
        const total = deduped.length;
        const start = (page - 1) * pageSize;
        const slice = deduped.slice(start, start + pageSize);
        const flagged = [];
        const workers = Math.min(12, slice.length);
        let cursor = 0;
        const flagWorker = async () => {
          while (cursor < slice.length) {
            const idx = cursor++;
            const repo = slice[idx];
            const record = getInstalledRecord(repo.full_name);
            flagged[idx] = safeAssign({}, repo, {
              installed: await annotateSkillInstalled(repo),
              installedAt: record && record.installedAt ? record.installedAt : null
            });
          }
        };
        await Promise.all(Array.from({ length: workers }, () => flagWorker()));
        marketplaceJson(res, 200, {
          repos: flagged,
          cached_at: getListCacheState("skills").at,
          total,
          page,
          pageSize,
          filtered: list.length,
          dropped: dropped.length,
          source: getListCacheState("skills").source ?? "registry"
        });
      } catch (error) {
        marketplaceJson(res, 500, { error: t(lang, "listFail", { err: String(error?.message ?? error) }) });
      }
    }
  });

  webServer.register({
    kind: "exact",
    path: "/api/marketplace/backup",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: "" });
      if (req.method !== "GET") return marketplaceJson(res, 405, { error: t(lang, "methodNotAllowed") });
      if (!isTrustedRequest(req)) return marketplaceJson(res, 403, { error: t(lang, "forbidden") });
      const backup = runBackupUseCase.buildBackup();
      if (backup.repos.length === 0) return marketplaceJson(res, 200, { status: "done", backup, log: [t(lang, "backupEmpty")] });
      return marketplaceJson(res, 200, { status: "done", backup, log: [t(lang, "backupDone", { n: backup.repos.length })] });
    }
  });

  webServer.register({
    kind: "exact",
    path: "/api/marketplace/restore/diff",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: "" });
      if (req.method !== "POST") return marketplaceJson(res, 405, { error: t(lang, "methodNotAllowed") });
      if (!isTrustedRequest(req)) return marketplaceJson(res, 403, { error: t(lang, "forbidden") });
      let body;
      try { body = await readJsonBody(req); } catch (error) { return marketplaceJson(res, error.status ?? 400, { error: error.message }); }
      if (!runBackupUseCase.isValidBackup(body?.backup)) return marketplaceJson(res, 400, { error: t(lang, "badBackup") });
      const diff = runBackupUseCase.diffBackup(body.backup, lang);
      return marketplaceJson(res, 200, { status: "done", ...diff });
    }
  });

  webServer.register({
    kind: "exact",
    path: "/api/marketplace/backup/webdav",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: "" });
      if (req.method !== "POST") return marketplaceJson(res, 405, { error: t(lang, "methodNotAllowed") });
      if (!(await isWriteAllowed(req))) return marketplaceJson(res, 403, { error: t(lang, "forbidden") });
      let body;
      try { body = await readJsonBody(req); } catch (error) { return marketplaceJson(res, error.status ?? 400, { error: error.message }); }
      const url = String(body?.url ?? "").trim();
      const result = await runBackupUseCase.pushWebdav({
        url,
        backup: body?.backup,
        username: body?.username,
        password: body?.password,
        lang
      });
      if (result.status === "invalid-url") return marketplaceJson(res, 400, { error: t(lang, "webdavBadUrl") });
      return marketplaceJson(res, 200, result);
    }
  });

  webServer.register({
    kind: "exact",
    path: "/api/marketplace/restore/webdav",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: "" });
      if (req.method !== "POST") return marketplaceJson(res, 405, { error: t(lang, "methodNotAllowed") });
      if (!(await isWriteAllowed(req))) return marketplaceJson(res, 403, { error: t(lang, "forbidden") });
      let body;
      try { body = await readJsonBody(req); } catch (error) { return marketplaceJson(res, error.status ?? 400, { error: error.message }); }
      const url = String(body?.url ?? "").trim();
      const result = await runBackupUseCase.restoreWebdav({
        url,
        username: body?.username,
        password: body?.password,
        lang
      });
      if (result.status === "invalid-url") return marketplaceJson(res, 400, { error: t(lang, "webdavBadUrl") });
      if (result.status === "invalid-backup") return marketplaceJson(res, 400, { error: t(lang, "badBackup") });
      return marketplaceJson(res, 200, result);
    }
  });

  webServer.register({
    kind: "exact",
    path: "/api/marketplace/logs",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: "" });
      if (req.method !== "GET") return marketplaceJson(res, 405, { error: t(lang, "methodNotAllowed") });
      if (!isTrustedRequest(req)) return marketplaceJson(res, 403, { error: t(lang, "forbidden") });
      const logSnapshot = getRecentLogs();
      const lines = sanitizeLog(logSnapshot.join("\n"));
      return marketplaceJson(res, 200, { status: "done", text: lines, count: logSnapshot.length, log: [t(lang, "logsExported", { n: logSnapshot.length })] });
    }
  });

  webServer.register({
    kind: "exact",
    path: "/api/marketplace/feedback/pending",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: "" });
      if (req.method !== "GET") return marketplaceJson(res, 405, { error: t(lang, "methodNotAllowed") });
      if (!isTrustedRequest(req)) return marketplaceJson(res, 403, { error: t(lang, "forbidden") });
      return marketplaceJson(res, 200, { status: "done", pending: feedbackUseCase.getPending() });
    }
  });

  webServer.register({
    kind: "exact",
    path: "/api/marketplace/feedback",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: "" });
      if (req.method !== "POST") return marketplaceJson(res, 405, { error: t(lang, "methodNotAllowed") });
      if (!(await isWriteAllowed(req))) return marketplaceJson(res, 403, { error: t(lang, "forbidden") });
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        return marketplaceJson(res, error.status === 413 ? 413 : 400, {
          error: t(lang, error.status === 413 ? "bodyTooLarge" : "badRequest")
        });
      }
      const repo = typeof body.repo === "string" ? body.repo.trim() : "";
      const ok = body.ok === true;
      const note = typeof body.note === "string" ? body.note.trim().slice(0, 2000) : "";
      if (!repo) return marketplaceJson(res, 400, { error: t(lang, "badRepo") });
      const feedback = await feedbackUseCase.submitFeedback({ repo, ok, note, lang });
      if (feedback.status === "not-found") {
        pushEvent({ event: "feedback.not_found", level: "warn", error_code: "feedback_not_found", message: repo });
        return marketplaceJson(res, 200, { status: "done", issueUrl: null, error: feedback.error });
      }
      pushEvent({ event: "feedback.done", level: "info", message: repo });
      return marketplaceJson(res, 200, feedback);
    }
  });

  webServer.register({
    kind: "exact",
    path: "/api/marketplace/feedback/token",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: "" });
      if (req.method === "GET") {
        if (!isTrustedRequest(req)) return marketplaceJson(res, 403, { error: t(lang, "forbidden") });
        return marketplaceJson(res, 200, { status: "done", hasToken: feedbackUseCase.getState().hasToken });
      }
      if (req.method !== "POST") return marketplaceJson(res, 405, { error: t(lang, "methodNotAllowed") });
      if (!(await isWriteAllowed(req))) return marketplaceJson(res, 403, { error: t(lang, "forbidden") });
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        return marketplaceJson(res, error.status === 413 ? 413 : 400, {
          error: t(lang, error.status === 413 ? "bodyTooLarge" : "badRequest")
        });
      }
      const token = typeof body.token === "string" ? body.token.trim() : "";
      return marketplaceJson(res, 200, await feedbackUseCase.setToken(token));
    }
  });

  webServer.register({
    kind: "exact",
    path: "/api/marketplace/env-keys",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: "" });
      if (req.method !== "GET") return marketplaceJson(res, 405, { error: t(lang, "methodNotAllowed") });
      if (!isTrustedRequest(req)) return marketplaceJson(res, 403, { error: t(lang, "forbidden") });
      const params = new URL(req.url, "http://x").searchParams;
      const repo = String(params.get("repo") ?? "").trim();
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return marketplaceJson(res, 400, { error: t(lang, "badRepo") });
      const record = getInstalledRecord(repo);
      if (!record) return marketplaceJson(res, 200, { status: "done", repo, envKeys: [], configured: {} });
      let keys = Array.isArray(record.envKeys) ? record.envKeys : [];
      if (keys.length === 0 && typeof record.location === "string" && record.location.length > 0) {
        const loc = String(record.location ?? "");
        const locResolved = resolve(loc);
        const managed = [resolveRecordNodeModules(record), SKILLS_DIR, PRESETS_DIR, CACHE_DIR].some((d) => {
          const dr = resolve(d);
          return locResolved === dr || locResolved.startsWith(dr + sep);
        });
        if (managed) {
          try {
            keys = await scanRequirements(loc);
          } catch {}
        }
      }
      const stored = envEditUseCase.getStored(repo);
      const configured = {};
      for (const k of keys) configured[k] = Boolean(stored[k]);
      return marketplaceJson(res, 200, { status: "done", repo, envKeys: keys, configured });
    }
  });

  webServer.register({
    kind: "exact",
    path: "/api/marketplace/profile",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: "" });
      if (req.method === "GET") {
        if (!isTrustedRequest(req)) return marketplaceJson(res, 403, { error: t(lang, "forbidden") });
        return marketplaceJson(res, 200, { status: "done", profile: profileName() });
      }
      if (req.method !== "POST") return marketplaceJson(res, 405, { error: t(lang, "methodNotAllowed") });
      if (!(await isWriteAllowed(req))) return marketplaceJson(res, 403, { error: t(lang, "forbidden") });
      if (installMutex.isBusy()) return marketplaceJson(res, 409, { error: t(lang, "installBusy") });
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return marketplaceJson(res, 400, { error: t(lang, "badRequest") });
      }
      const name = String(body?.profile ?? "").trim();
      if (!PROFILE_NAME_RE.test(name)) return marketplaceJson(res, 400, { error: t(lang, "badProfile") });
      try {
        const st = await stat(join(DSH_HOME, "profiles", name));
        if (!st.isDirectory()) return marketplaceJson(res, 400, { error: t(lang, "badProfile") });
      } catch {
        return marketplaceJson(res, 400, { error: t(lang, "badProfile") });
      }
      try {
        const cfgPath = join(MARKET_ROOT, "config.json");
        let cfg = {};
        try { cfg = JSON.parse(await readFile(cfgPath, "utf8")); } catch {}
        cfg.targetProfile = name;
        await writeFile(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
      } catch {
        return marketplaceJson(res, 500, { error: t(lang, "profileSaveFail") });
      }
      setTargetProfile(name);
      logger?.info?.(`dsh-plugin-marketplace: 目标 profile 已切换为 ${name}`);
      return marketplaceJson(res, 200, { status: "done", profile: name });
    }
  });

  webServer.register({
    kind: "exact",
    path: "/api/marketplace/check-update",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: "" });
      if (req.method !== "POST") return marketplaceJson(res, 405, { error: t(lang, "methodNotAllowed") });
      if (!isTrustedRequest(req)) return marketplaceJson(res, 403, { error: t(lang, "forbidden") });
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return marketplaceJson(res, 400, { error: t(lang, "badRequest") });
      }
      const repo = typeof body.repo === "string" ? body.repo.trim() : "";
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return marketplaceJson(res, 400, { error: t(lang, "badRepo") });
      const record = getInstalledRecord(repo);
      if (!record || record.type !== "cli") return marketplaceJson(res, 404, { error: t(lang, "notInstalled") });
      const pkgName = String(record.name ?? "");
      if (/^[\w.-]+\/[\w.-]+$/.test(pkgName)) return marketplaceJson(res, 400, { error: t(lang, "checkUpdateNotNpm") });
      const parts = pkgName.split("/");
      if (parts.length > 2 || parts.some((s) => !/^@?[a-zA-Z0-9][a-zA-Z0-9._~-]*$/.test(s) || s === "." || s === "..")) {
        return marketplaceJson(res, 400, { error: t(lang, "badPkgName") });
      }
      const pkgDir = join(resolveRecordNodeModules(record), ...parts);
      const installedVersion = await readPackageVersion(pkgDir);
      if (!installedVersion) {
        return marketplaceJson(res, 200, {
          status: "done",
          installedVersion: null,
          latestVersion: null,
          updateAvailable: false,
          error: t(lang, "checkUpdateNoPkg")
        });
      }
      const latestVersion = await fetchNpmLatest(pkgName);
      if (!latestVersion) {
        return marketplaceJson(res, 200, {
          status: "done",
          installedVersion,
          latestVersion: null,
          updateAvailable: false,
          error: t(lang, "checkUpdateNpmFail")
        });
      }
      pushLog(`check-update ${repo}: 已装 ${installedVersion} / npm latest ${latestVersion}`);
      pushEvent({ event: "check_update.done", level: "info", message: `${repo} ${installedVersion} -> ${latestVersion}` });
      return marketplaceJson(res, 200, {
        status: "done",
        repo,
        installedVersion,
        latestVersion,
        updateAvailable: compareVersions(installedVersion, latestVersion) < 0
      });
    }
  });

  webServer.register({
    kind: "exact",
    path: "/api/marketplace/env-edit",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: "" });
      if (req.method !== "POST") return marketplaceJson(res, 405, { error: t(lang, "methodNotAllowed") });
      if (!(await isWriteAllowed(req))) return marketplaceJson(res, 403, { error: t(lang, "forbidden") });
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        return marketplaceJson(res, error.status === 413 ? 413 : 400, {
          error: t(lang, error.status === 413 ? "bodyTooLarge" : "badRequest")
        });
      }
      const repo = typeof body.repo === "string" ? body.repo.trim() : "";
      const values = body.values && typeof body.values === "object" ? body.values : {};
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return marketplaceJson(res, 400, { error: t(lang, "badRepo") });
      try {
        const result = await envEditUseCase.applyEnvEdit({ repo, values });
        if (result.status === "not-installed") return marketplaceJson(res, 404, { error: t(lang, "notInstalled") });
        if (result.status === "too-many-keys") return marketplaceJson(res, 400, { error: t(lang, "tooManyEnvKeys") });
        if (result.status === "invalid-key") return marketplaceJson(res, 400, { error: t(lang, "badEnvKey", { key: result.key }) });
        if (result.status === "no-applied") return marketplaceJson(res, 400, { error: t(lang, "noEnvApplied") });
        return marketplaceJson(res, 200, result);
      } catch (error) {
        return marketplaceJson(res, 500, { error: String(error?.message ?? error) });
      }
    }
  });

  webServer.register({
    kind: "exact",
    path: "/api/marketplace/install",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: "" });
      if (req.method !== "POST") return marketplaceJson(res, 405, { error: t(lang, "methodNotAllowed") });
      if (!(await isWriteAllowed(req))) return marketplaceJson(res, 403, { error: t(lang, "forbidden") });
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        return marketplaceJson(res, error.status === 413 ? 413 : 400, {
          error: t(lang, error.status === 413 ? "bodyTooLarge" : "badRequest")
        });
      }
      const langFull = langOf(req, body);
      const repo0 = typeof body.repo === "string" ? body.repo.trim() : "";
      const answers = body.answers && typeof body.answers === "object" ? body.answers : {};
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo0)) return marketplaceJson(res, 400, { error: t(langFull, "badRepo") });
      const redirected = adaptorRedirectRepo(repo0);
      const repo = redirected ?? repo0;
      if (installMutex.isBusy()) return marketplaceJson(res, 409, { error: t(langFull, "installBusy") });
      const installProfile = profileName();
      const installProfilePaths = {
        profileDir: profileDir(installProfile),
        nodeModules: profileNodeModules(installProfile),
        patchFile: profilePatchFile(installProfile),
        packageFile: profilePackageFile(installProfile)
      };
      return await installMutex.run(async () => {
        const started = Date.now();
        const log = [];
        const logLine = (line) => {
          const clipped = String(line ?? "").slice(0, LOG_LINE_MAX);
          log.push(clipped);
          pushLog(`install ${repo}: ${clipped}`);
        };
        let cacheDir = null;
        let npmTargetUsed = null;
        const emitInstall = (status, error_code = null) => {
          pushEvent({ event: `install.${status}`, level: status === "failed" ? "error" : "info", error_code, duration_ms: Date.now() - started, message: `${repo} ${status}` });
        };
        try {
          if (redirected) logLine(t(langFull, "adaptorRedirected", { from: repo0, to: redirected }));
          const [owner, repoName] = repo.split("/");
          cacheDir = join(CACHE_DIR, `${slugify(owner)}__${slugify(repoName)}`);
          const prepared = await prepareInstallCache({ repo, cacheDir, logLine, lang: langFull });
          cacheDir = prepared.cacheDir;
          const cliResult = await runInstallCliFlow({ repo, cacheDir, installProfile, log, logLine, lang: langFull });
          cacheDir = cliResult.cacheDir;
          npmTargetUsed = cliResult.npmTargetUsed;
          if (cliResult.status === "done") {
            emitInstall("done");
            return marketplaceJson(res, 200, cliResult);
          }
          const cliCommand = cliResult.cliCommand;
          const preflight = await runInstallPreflight({
            cacheDir,
            repo,
            answers,
            log,
            logLine,
            lang: langFull,
            cliCommand
          });
          if (preflight.status !== "continue") {
            emitInstall(preflight.status);
            return marketplaceJson(res, 200, preflight);
          }
          const type = preflight.type;
          const scannedVars = preflight.scannedVars;
          logLine(t(langFull, "step4"));
          const result = await runInstallUseCase({
            type,
            cacheDir,
            repo,
            answers,
            log,
            logLine,
            lang: langFull,
            envAllowList: scannedVars,
            npmTarget: npmTargetUsed,
            npmTargetUsed,
            profilePaths: installProfilePaths,
            cliCommand: preflight.cliCommand
          });
          emitInstall(result.status);
          return marketplaceJson(res, 200, result);
        } catch (error) {
          if (cacheDir) await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
          const errText = [error?.message, error?.stderr].filter(Boolean).join("\n");
          const hint = classifyInstallFailure(errText, langFull);
          logLine(t(langFull, "fail", { err: String(error?.message ?? error) }));
          if (hint) logLine(hint);
          emitInstall("failed", "install_failed");
          return marketplaceJson(res, 200, {
            status: "failed",
            repo,
            log,
            error: hint ? `${String(error?.message ?? error)}\n\n${hint}` : String(error?.message ?? error)
          });
        }
      });
    }
  });

  webServer.register({
    kind: "exact",
    path: "/api/marketplace/uninstall",
    handler: async (req, res) => {
      const lang = langOf(req, { lang: "" });
      if (req.method !== "POST") return marketplaceJson(res, 405, { error: t(lang, "methodNotAllowed") });
      if (!(await isWriteAllowed(req))) return marketplaceJson(res, 403, { error: t(lang, "forbidden") });
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        return marketplaceJson(res, error.status ?? 400, { error: error.message });
      }
      const repo = normalizeRepoRef(String(body?.repo ?? ""));
      if (!repo) return marketplaceJson(res, 400, { error: t(lang, "badRepo") });
      if (installMutex.isBusy()) return marketplaceJson(res, 409, { error: t(lang, "installBusy") });
      return await installMutex.run(async () => {
        const log = [];
        const logLine = (line) => {
          const clipped = String(line ?? "").slice(0, LOG_LINE_MAX);
          log.push(clipped);
          pushLog(`uninstall ${repo}: ${clipped}`);
        };
        const result = await runUninstallUseCase({ repo, log, logLine, lang });
        pushEvent({ event: `uninstall.${result.status}`, level: result.status === "failed" ? "error" : "info", error_code: result.status === "failed" ? "uninstall_failed" : null, message: `${repo} ${result.status}` });
        return marketplaceJson(res, 200, result);
      });
    }
  });
}
