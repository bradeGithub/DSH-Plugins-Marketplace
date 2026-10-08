/**
 * 从 package spec 里取出裸包名（用于安装记录：卸载时按依赖名删）。
 * 只认注册表包名（含 scoped `@scope/name`，可带 `@version` 后缀）；
 * git 地址 / tarball / 本地路径返回 null——这类 spec 无法直接当作依赖键名使用。
 * 独立导出以便单测。
 */
export function packageNameFromSpec(spec) {
  const value = String(spec ?? "").trim();
  if (value.length === 0) return null;
  if (/^(?:github|git|git\+https?|git\+ssh|https?|file):/i.test(value)) return null;
  if (value.startsWith(".") || value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value)) return null;
  const at = value.startsWith("@") ? value.indexOf("@", 1) : value.indexOf("@");
  const name = at > 0 ? value.slice(0, at) : value;
  return /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i.test(name) ? name : null;
}

export function createInstallPreparation({
  cacheRoot,
  mkdir,
  stat,
  rm,
  exists,
  readFile,
  runGit,
  parseGitmodulesUrls,
  cacheReuseMs,
  joinPath,
  translate,
  normalizeRepoRef,
  now = () => Date.now()
}) {
  const message = (lang, key, params) => translate(lang, key, params);
  // 碰撞候选目录探测上限：调用方用 slugify(owner)__slugify(name) 拼 cacheDir，slugify 有损
  // （foo.bar 与 foo-bar 同键）——同名目录被其他仓库占用时顺延到 <dir>~2、~3……
  const MAX_DIR_PROBES = 16;

  /** 读候选缓存目录的 clone 来源（git remote origin），归一化为 owner/repo；识别不了返回 null。 */
  async function cacheRemoteOf(dir) {
    try {
      // 用 `config --get` 读「记录的字面 URL」而非 `remote get-url`——后者会应用
      // url.insteadOf 重写（SSH→HTTPS 代理、镜像、测试 fixture），拿到重写后地址会让
      // 归一化比对失配，续装顺延到 ~N 目录并把原目录留成孤儿缓存。
      const result = await runGit(["-C", dir, "config", "--get", "remote.origin.url"], { timeout: 10000 });
      return normalizeRepoRef(String(result?.stdout ?? result ?? ""));
    } catch {
      return null;
    }
  }

  return async function prepareInstall({ repo, cacheDir, logLine, lang }) {
    logLine(message(lang, "step1", { repo }));
    await mkdir(cacheRoot, { recursive: true });

    // slug 碰撞防护：仅凭 mtime 复用会在复用窗内给碰撞仓库装上错误内容；且 script 型
    // 安装的 location 就是 cacheDir，误删他人目录会毁掉其已安装载荷。故候选目录存在时
    // 先比对 clone remote——属主一致才复用/重建，属主不符（含来源不可识别，宁留勿删）
    // 顺延带 ~N 后缀的目录。
    const want = normalizeRepoRef(repo);
    let dir = cacheDir;
    let reused = false;
    for (let probe = 0; probe < MAX_DIR_PROBES; probe++) {
      const st = await stat(dir).catch(() => null);
      if (!st || !st.isDirectory()) break; // 目录不存在 → 占用
      const remote = await cacheRemoteOf(dir);
      if (want !== null && remote === want) {
        reused = now() - st.mtimeMs < cacheReuseMs; // 本仓库缓存：新鲜复用、过期重建
        break;
      }
      dir = `${cacheDir}~${probe + 2}`; // 他人占用/来源不明 → 探测下一个带后缀候选
    }

    if (reused) {
      logLine(message(lang, "cacheReuse"));
      return { cacheDir: dir, reused: true };
    }

    try {
      await rm(dir, { recursive: true, force: true });
      await runGit(["clone", "--depth", "1", `https://github.com/${repo}.git`, dir], { timeout: 180000 });
      logLine(message(lang, "cloneDone"));

      if (await exists(joinPath(dir, ".gitmodules"))) {
        const gitmodules = await readFile(joinPath(dir, ".gitmodules"), "utf8").catch(() => "");
        const { unsafe } = parseGitmodulesUrls(gitmodules);
        if (unsafe.length > 0) throw new Error(message(lang, "submoduleUnsafe", { urls: unsafe.join(", ") }));
        await runGit(["-c", "protocol.file.allow=never", "submodule", "update", "--init", "--recursive", "--depth", "1"], {
          cwd: dir,
          timeout: 180000
        });
        logLine(message(lang, "submoduleDone"));
      }
    } catch (error) {
      // 顺延到带后缀目录时把实际占用目录标到错误上——调用方的失败清理默认只删
      // 原始 cacheDir，不标注会把他人占用的原始目录误删。
      if (dir !== cacheDir && error && typeof error === "object") error.installCacheDir = dir;
      throw error;
    }

    return { cacheDir: dir, reused: false };
  };
}

export function createInstallCliFlow({
  scanCliInstallHint,
  scanExternalCliHint,
  findCliInstall,
  buildFilteredEnv,
  getInstalledRecord,
  fetchNpmLatest,
  runDsh,
  installNpmTargetToTemp,
  isNpmCliTarget,
  isCliInstallTarget,
  saveInstalled,
  queueFeedbackSafe,
  buildEnvProfile,
  buildFeedbackLogSnapshot,
  cleanupCache,
  translate,
  pluginManager = null,
  builtinAllowed = null,
  now = () => Date.now()
}) {
  /**
   * README 要求用官方 `dsh plugin ... add <包>` 安装时，优先交给 DSH 进程内的插件管理器。
   *
   * 桌面端必须走这条：`desktop` profile 由 Electron 应用独占，CLI 会直接拒绝
   * （error: profile "desktop" is managed exclusively by the Electron application），
   * 只有进程内服务能完成安装。`dsh plugin` 命令作为回退保留（老版本 DSH / 非当前 profile）。
   *
   * 返回值三态：
   *   { used: false }                    → 内置路径不可用，调用方继续走 CLI；
   *   { used: true, needsRestart }        → 内置路径安装成功；
   *   { used: false, rejected: true, error } → 内置路径**拒绝**了这次安装（不兼容版本、
   *                                          registry/supply-chain 策略等）——必须如实上报，
   *                                          不能回退 CLI/复制路径绕过宿主的判定。
   */
  async function tryBuiltin(target, logLine, lang) {
    if (typeof builtinAllowed !== "function" || builtinAllowed() !== true) return { used: false };
    if (!pluginManager || typeof pluginManager.available !== "function" || !pluginManager.available()) {
      return { used: false };
    }
    logLine(translate(lang, "builtinInstallStart", { spec: target }));
    const result = await pluginManager.installBundle(target, { activate: true });
    if (result.unavailable === true) return { used: false };
    if (result.ok !== true) {
      return {
        used: false,
        rejected: true,
        error: result.error ?? result.application ?? "unknown"
      };
    }
    logLine(translate(lang, result.needsRestart ? "builtinInstallRestart" : "builtinInstallDone", { name: target }));
    return { used: true, needsRestart: result.needsRestart === true };
  }

  return async function runInstallCli({
    repo,
    cacheDir,
    installProfile,
    log,
    logLine,
    lang,
    answers = {}
  }) {
    const cliCommand = await scanCliInstallHint(cacheDir, repo);
    const externalCliHint = cliCommand
      ? null
      : await scanExternalCliHint(cacheDir);
    const cliInstall = await findCliInstall(cacheDir, repo);

    if (cliCommand) {
      logLine(translate(lang, "cliHint", { cmd: cliCommand }));
    }
    if (externalCliHint) {
      logLine(translate(lang, "externalCliHint", {
        cli: externalCliHint.cli,
        cmd: externalCliHint.command
      }));
    }

    if (!cliInstall) {
      return {
        status: "continue",
        cacheDir,
        npmTargetUsed: null,
        cliCommand: cliCommand || null
      };
    }

    // 白名单门：target 必须是 npm 包名或 owner/repo 形态（win32 cmd.exe /c 注入面）——
    // 提取层已过滤，此处防御性复查（findCliInstall 为注入依赖，不信任其内部实现）
    if (!isCliInstallTarget(cliInstall.target)) {
      logLine(translate(lang, "cliUnsafeTarget", { cmd: cliInstall.command }));
      return {
        status: "continue",
        cacheDir,
        npmTargetUsed: null,
        cliCommand: cliCommand || cliInstall.command
      };
    }

    // CLI 代执行确认门：白名单只保证 target 形态安全，「是否执行 README 给出的第三方命令」
    // 仍需用户确认——与 script/npm 生命周期门同级。cancel 不中止安装，回退常规市场安装流程。
    if (answers.__confirm_cli__ === void 0) {
      return {
        status: "awaiting-input",
        repo,
        cacheDir,
        questions: [{
          id: "__confirm_cli__",
          header: translate(lang, "qCliHeader"),
          question: translate(lang, "qCli", { repo, cmd: cliInstall.command }),
          options: [
            { value: "continue", label: translate(lang, "optContinue"), description: translate(lang, "optCliContinueDesc") },
            { value: "cancel", label: translate(lang, "optCliCancel"), description: translate(lang, "optCliCancelDesc") }
          ]
        }],
        log
      };
    }
    if (String(answers.__confirm_cli__) !== "continue") {
      logLine(translate(lang, "cliSkipped"));
      return {
        status: "continue",
        cacheDir,
        npmTargetUsed: null,
        cliCommand: cliCommand || cliInstall.command
      };
    }

    logLine(translate(lang, "cliExec", { cmd: cliInstall.command }));

    try {
      const cliEnv = buildFilteredEnv();
      let target = cliInstall.target;
      if (
        getInstalledRecord(repo) &&
        !/^[\w.-]+\/[\w.-]+$/.test(target)
      ) {
        const npmLatest = await fetchNpmLatest(target);
        if (npmLatest) {
          target = `${target}@${npmLatest}`;
          logLine(translate(lang, "cliUpdateTo", {
            target,
            version: npmLatest
          }));
        }
      }

      // 桌面端/0.2.0+：优先交给 DSH 进程内的插件管理器（`desktop` profile 下 CLI 被应用独占拒绝）。
      const builtin = await tryBuiltin(target, logLine, lang);
      if (builtin.rejected) {
        logLine(translate(lang, "builtinInstallFail", { name: target, err: builtin.error }));
        return { status: "failed", repo, error: builtin.error, log };
      }
      const viaBuiltin = builtin.used === true;
      const installedName = viaBuiltin ? (packageNameFromSpec(target) ?? cliInstall.target) : cliInstall.target;

      if (!viaBuiltin) {
        const args = [
          "plugin",
          "--profile",
          installProfile,
          cliInstall.verb === "add" ? "add" : "install",
          target
        ];
        await runDsh(args, {
          cwd: cacheDir,
          env: cliEnv,
          timeout: 180000
        });
        logLine(translate(lang, "cliDone"));
      }

      await saveInstalled(repo, {
        type: "cli",
        name: installedName,
        names: null,
        location: null,
        version: null,
        installedAt: now(),
        envKeys: null,
        profile: installProfile,
        // 内置安装器装出来的是 profile bundle 依赖：卸载要走插件管理器的 removeBundle /
        // pnpm remove（而非删目录 + 清 patch 条目），因此把 bundle 标记一并记下来。
        ...(viaBuiltin ? { bundle: true, viaBuiltin: true } : {})
      });
      await queueFeedbackSafe({
        repo,
        name: installedName,
        type: "cli",
        version: null,
        installedAt: now(),
        method: viaBuiltin ? "builtin" : "cli",
        reinstall: Boolean(getInstalledRecord(repo)),
        envProfile: await buildEnvProfile(),
        logSnapshot: buildFeedbackLogSnapshot(log)
      }, logLine, lang);
      logLine(translate(lang, "feedbackQueued"));

      try {
        await cleanupCache(cacheDir);
      } catch {}

      return {
        status: "done",
        repo,
        installed: true,
        type: "cli",
        name: installedName,
        cliCommand: cliInstall.command,
        latestVersion: null,
        ...(viaBuiltin ? { viaBuiltin: true, bundle: true } : {}),
        log
      };
    } catch (error) {
      logLine(translate(lang, "cliFailFallback", {
        err: String(error?.message ?? error).slice(0, 200)
      }));

      if (isNpmCliTarget(cliInstall.target)) {
        try {
          const npmDir = await installNpmTargetToTemp(cliInstall.target);
          if (npmDir) {
            logLine(translate(lang, "cliNpmFallback", {
              target: cliInstall.target
            }));
            return {
              status: "continue",
              cacheDir: npmDir,
              npmTargetUsed: cliInstall.target,
              cliCommand: cliCommand || cliInstall.command
            };
          }
        } catch {}
      }

      return {
        status: "continue",
        cacheDir,
        npmTargetUsed: null,
        cliCommand: cliCommand || cliInstall.command
      };
    }
  };
}

export function createInstallPreflight({
  detectTypeDetail,
  findPluginRoots,
  scanRequirements,
  scanCacheSecrets,
  scanCacheVulnerabilities,
  scanScriptHazards,
  scanLifecycleHazards,
  readLifecycleScripts,
  scanHostShadowDeps,
  needsPluginBuild,
  readPackageJsonObject,
  looksLikeDshPlugin,
  exists,
  readFile,
  joinPath,
  cleanupCache,
  redactLog,
  translate
}) {
  const cleanup = async (cacheDir) => {
    try {
      await cleanupCache(cacheDir);
    } catch {}
  };
  const message = (lang, key, params) => translate(lang, key, params);

  return async function runInstallPreflight({
    cacheDir,
    repo,
    answers = {},
    log,
    logLine,
    lang,
    cliCommand = null
  }) {
    const detect = await detectTypeDetail(cacheDir);
    const type = detect.type;
    logLine(message(lang, "step2", { type: message(lang, `type.${type}`) }));
    logLine(message(lang, "typeReason", {
      matched: message(lang, detect.reasonKey),
      hint: message(lang, detect.hintKey)
    }));

    const pluginRoots = type === "cordis-plugin" ? await findPluginRoots(cacheDir) : [];
    const pkgDirs = pluginRoots.length > 0 ? pluginRoots : [cacheDir];
    const scannedVars = ["script", "cordis-plugin"].includes(type)
      ? [...new Set((await Promise.all(pkgDirs.map((dir) => scanRequirements(dir)))).flat())].slice(0, 8)
      : [];
    const required = scannedVars.filter((name) => !(name in answers));
    logLine(message(lang, "step3", {
      list: required.length === 0 ? message(lang, "none") : required.join(", ")
    }));
    if (required.length > 0) {
      logLine(message(lang, "awaiting"));
      return {
        status: "awaiting-input",
        repo,
        type,
        questions: required.map((name) => ({
          id: name,
          header: message(lang, "qEnvHeader", { repo, v: name }),
          question: message(lang, "qEnv", { v: name })
        })),
        log
      };
    }

    if (answers.__confirm_secrets__ === void 0) {
      const secretHits = await scanCacheSecrets(cacheDir);
      if (secretHits.length > 0) {
        logLine(message(lang, "secretsFound", { n: secretHits.length }));
        const secretsText = secretHits
          .map((hit) => `  ${hit.file}#L${hit.line} [${hit.kind}] ${redactLog(hit.text)}`)
          .join("\n");
        return {
          status: "awaiting-input",
          repo,
          type,
          questions: [{
            id: "__confirm_secrets__",
            header: message(lang, "qSecretsHeader"),
            question: message(lang, "qSecrets", { repo, n: secretHits.length, secrets: secretsText }),
            options: [
              { value: "continue", label: message(lang, "optSecretsContinue"), description: message(lang, "optSecretsContinueDesc") },
              { value: "cancel", label: message(lang, "optSecretsCancel"), description: message(lang, "optSecretsCancelDesc") }
            ]
          }],
          log
        };
      }
    }
    if (String(answers.__confirm_secrets__) === "cancel") {
      await cleanup(cacheDir);
      logLine(message(lang, "secretsCancelled"));
      return { status: "aborted", repo, type, log };
    }

    if (answers.__confirm_vulns__ === void 0) {
      const vulnHits = await scanCacheVulnerabilities(cacheDir);
      if (vulnHits.length > 0) {
        logLine(message(lang, "vulnsFound", { n: vulnHits.length }));
        const vulnsText = vulnHits
          .slice(0, 10)
          .map((hit) => `  [${hit.severity}] ${hit.name}@${hit.version} — ${hit.title}${hit.url ? `\n    ${hit.url}` : ""}`)
          .join("\n")
          + (vulnHits.length > 10 ? `\n  … +${vulnHits.length - 10} more` : "");
        return {
          status: "awaiting-input",
          repo,
          type,
          questions: [{
            id: "__confirm_vulns__",
            header: message(lang, "qVulnsHeader"),
            question: message(lang, "qVulns", { repo, n: vulnHits.length, vulns: vulnsText }),
            options: [
              { value: "continue", label: message(lang, "optVulnsContinue"), description: message(lang, "optVulnsContinueDesc") },
              { value: "cancel", label: message(lang, "optVulnsCancel"), description: message(lang, "optVulnsCancelDesc") }
            ]
          }],
          log
        };
      }
    }
    if (String(answers.__confirm_vulns__) === "cancel") {
      await cleanup(cacheDir);
      logLine(message(lang, "vulnsCancelled"));
      return { status: "aborted", repo, type, log };
    }

    // bundle 确认门：registerBundlePackage 会写 profile dependencies 并执行
    // pnpm install——github:/file: 依赖的 prepare 等生命周期脚本是否运行取决于 pnpm
    // 版本与 onlyBuiltDependencies，行为不确定，故与 npm 生命周期门同级显式确认。
    // bundle 为依赖清单形态、无 .env 面，env 扫描维持跳过（已知限制）。
    if (type === "bundle" && answers.__confirm_bundle__ === void 0) {
      const pkg = await readPackageJsonObject(cacheDir).catch(() => null);
      const patch = pkg?.dsh?.bundle?.patch ?? "";
      const pkgName = typeof pkg?.name === "string" && pkg.name.length > 0 ? pkg.name : repo;
      logLine(message(lang, "bundleGateDetected", { name: pkgName }));
      return {
        status: "awaiting-input",
        repo,
        type,
        questions: [{
          id: "__confirm_bundle__",
          header: message(lang, "qBundleHeader"),
          question: message(lang, "qBundle", { repo, name: pkgName, patch }),
          options: [
            { value: "allow", label: message(lang, "optAllow"), description: message(lang, "optBundleAllowDesc") },
            { value: "deny", label: message(lang, "optDeny"), description: message(lang, "optBundleDenyDesc") }
          ]
        }],
        log
      };
    }
    if (type === "bundle" && String(answers.__confirm_bundle__) === "deny") {
      await cleanup(cacheDir);
      logLine(message(lang, "bundleCancelled"));
      return { status: "aborted", repo, type, log };
    }

    if (type === "script" && answers.__confirm_script__ === void 0) {
      logLine(message(lang, "scriptDetected"));
      const scriptFiles = [];
      for (const file of ["install.ps1", "install.sh"]) {
        if (await exists(joinPath(cacheDir, file))) scriptFiles.push(file);
      }
      const hazardHits = (await Promise.all(scriptFiles.map((file) => scanScriptHazards(joinPath(cacheDir, file)))))
        .flatMap((hits, index) => hits.map((hit) => ({ ...hit, file: scriptFiles[index] })));
      if (hazardHits.length > 0) logLine(message(lang, "scriptHazardsFound", { n: hazardHits.length }));
      const hazards = hazardHits
        .map((hit) => `  ${hit.file}#L${hit.line} [${message(lang, `hazard.${hit.category}`)}] ${hit.text}`)
        .join("\n");
      return {
        status: "awaiting-input",
        repo,
        type,
        questions: [{
          id: "__confirm_script__",
          header: message(lang, "qScriptHeader"),
          question: hazardHits.length > 0
            ? message(lang, "qScriptHazards", { repo, n: hazardHits.length, hazards })
            : message(lang, "qScript", { repo }),
          options: [
            { value: "continue", label: message(lang, "optContinue"), description: message(lang, "optContinueDesc") },
            { value: "cancel", label: message(lang, "optCancel"), description: message(lang, "optCancelDesc") }
          ]
        }],
        log
      };
    }
    if (type === "script" && String(answers.__confirm_script__) !== "continue") {
      logLine(message(lang, "scriptCancelled"));
      await cleanup(cacheDir);
      return { status: "aborted", repo, type, log };
    }

    if (type === "cordis-plugin" && answers.__confirm_npm_scripts__ === void 0) {
      const scripts = [...new Set((await Promise.all(pkgDirs.map((dir) => readLifecycleScripts(dir)))).flat())];
      const jsHazards = (await Promise.all(pkgDirs.map((dir) => scanLifecycleHazards(dir)))).flat();
      if (scripts.length > 0) {
        logLine(message(lang, "npmScriptsDetected", { scripts: scripts.join(", ") }));
        const hazardsText = jsHazards.length > 0
          ? jsHazards.map((hit) => `  ${hit.script}[${message(lang, `hazard.${hit.category}`)}] ${hit.text}`).join("\n")
          : "";
        return {
          status: "awaiting-input",
          repo,
          type,
          questions: [{
            id: "__confirm_npm_scripts__",
            header: message(lang, "qNpmScriptsHeader"),
            question: jsHazards.length > 0
              ? message(lang, "qNpmScriptsHazards", { repo, scripts: scripts.join(", "), hazards: hazardsText })
              : message(lang, "qNpmScripts", { repo, scripts: scripts.join(", ") }),
            options: [
              { value: "allow", label: message(lang, "optAllow"), description: message(lang, "optAllowDesc") },
              { value: "deny", label: message(lang, "optDeny"), description: message(lang, "optDenyDesc") }
            ]
          }],
          log
        };
      }
    }
    if (type === "cordis-plugin" && String(answers.__confirm_npm_scripts__) === "deny") {
      await cleanup(cacheDir);
      logLine(message(lang, "npmScriptsDenied"));
      return { status: "aborted", repo, type, log };
    }

    if (type === "cordis-plugin" && answers.__confirm_host_deps__ === void 0) {
      const hostDeps = [...new Set((await Promise.all(pkgDirs.map((dir) => scanHostShadowDeps(dir)))).flat())];
      if (hostDeps.length > 0) {
        logLine(message(lang, "hostShadowDepsDetected", { names: hostDeps.join(", ") }));
        return {
          status: "awaiting-input",
          repo,
          type,
          questions: [{
            id: "__confirm_host_deps__",
            header: message(lang, "qHostDepsHeader"),
            question: message(lang, "qHostDeps", { repo, names: hostDeps.join(", ") }),
            options: [
              { value: "continue", label: message(lang, "optHostDepsContinue"), description: message(lang, "optHostDepsContinueDesc") },
              { value: "deny", label: message(lang, "optDeny"), description: message(lang, "optHostDepsDenyDesc") }
            ]
          }],
          log
        };
      }
    }
    if (type === "cordis-plugin" && String(answers.__confirm_host_deps__) === "deny") {
      await cleanup(cacheDir);
      logLine(message(lang, "hostDepsDenied"));
      return { status: "aborted", repo, type, log };
    }

    if (type === "cordis-plugin" && pluginRoots.length === 0 && answers.__confirm_non_plugin__ === void 0) {
      const looksLike = looksLikeDshPlugin(await readPackageJsonObject(cacheDir));
      if (looksLike === false) {
        logLine(message(lang, "nonPluginDetected"));
        return {
          status: "awaiting-input",
          repo,
          type,
          questions: [{
            id: "__confirm_non_plugin__",
            header: message(lang, "qNonPluginHeader"),
            question: message(lang, "qNonPlugin", { repo, url: `https://github.com/${repo}` }),
            options: [
              { value: "continue", label: message(lang, "optNonPluginContinue"), description: message(lang, "optNonPluginContinueDesc") },
              { value: "cancel", label: message(lang, "optNonPluginCancel"), description: message(lang, "optNonPluginCancelDesc") }
            ]
          }],
          log
        };
      }
    }
    if (type === "cordis-plugin" && String(answers.__confirm_non_plugin__) === "cancel") {
      await cleanup(cacheDir);
      logLine(message(lang, "nonPluginCancelled"));
      return { status: "aborted", repo, type, log };
    }

    if (type === "cordis-plugin" && answers.__confirm_build__ === void 0) {
      const needBuild = (await Promise.all(pkgDirs.map((dir) => needsPluginBuild(dir)))).some(Boolean);
      if (needBuild) {
        logLine(message(lang, "buildDetected"));
        return {
          status: "awaiting-input",
          repo,
          type,
          questions: [{
            id: "__confirm_build__",
            header: message(lang, "qBuildHeader"),
            question: message(lang, "qBuild", { repo }),
            options: [
              { value: "allow", label: message(lang, "optAllowBuild"), description: message(lang, "optAllowBuildDesc") },
              { value: "deny", label: message(lang, "optDenyBuild"), description: message(lang, "optDenyBuildDesc") }
            ]
          }],
          log
        };
      }
    }
    if (type === "cordis-plugin" && String(answers.__confirm_build__) === "deny") {
      await cleanup(cacheDir);
      logLine(message(lang, "buildDenied"));
      return { status: "aborted", repo, type, log };
    }

    if (type === "instructions" && answers.__confirm_manual__ === void 0) {
      const readme = await readFile(joinPath(cacheDir, "README.md"), "utf8").catch(() => "");
      logLine(message(lang, "manualDetected"));
      return {
        status: "awaiting-input",
        repo,
        type,
        questions: [{
          id: "__confirm_manual__",
          header: message(lang, "qManualHeader"),
          question: message(lang, "qManual", {
            repo,
            url: `https://github.com/${repo}`,
            readme: (readme || message(lang, "noReadme")).slice(0, 800)
          }),
          options: [{ value: "cancel", label: message(lang, "optManualCancel"), description: message(lang, "optManualCancelDesc") }]
        }],
        log
      };
    }
    if (type === "instructions" && String(answers.__confirm_manual__) === "cancel") {
      await cleanup(cacheDir);
      logLine(message(lang, "manualCancelled"));
      return { status: "aborted", repo, type, log };
    }

    return {
      status: "continue",
      repo,
      type,
      scannedVars,
      cliCommand
    };
  };
}

export const INSTALLABLE_TYPES = new Set([
  "skill",
  "agent-preset",
  "cordis-plugin",
  "bundle",
  "script"
]);

export function createInstallUseCase({
  installRepo,
  saveInstalled,
  queueFeedbackSafe,
  getInstalledRecord,
  buildEnvProfile,
  buildFeedbackLogSnapshot,
  readPackageVersion,
  classifyInstallFailure,
  classifyInstallFailureKind,
  cleanupCache,
  translate,
  now = () => Date.now()
}) {
  return async function runInstall({
    type,
    cacheDir,
    repo,
    answers,
    log,
    logLine,
    lang,
    envAllowList = [],
    npmTarget = null,
    profilePaths = null,
    cliCommand = null,
    npmTargetUsed = null
  }) {
    try {
      if (translate) logLine(translate(lang, "step5"));
      const result = await installRepo({
        type,
        cacheDir,
        repo,
        log,
        answers,
        logLine,
        lang,
        envAllowList,
        npmTarget,
        profilePaths
      });
      let installed = false;
      if (result && INSTALLABLE_TYPES.has(result.type)) {
        await saveInstalled(repo, {
          type: result.type,
          name: result.name ?? null,
          names: Array.isArray(result.names) && result.names.length > 0 ? result.names : null,
          location: result.location ?? null,
          version: result.version ?? null,
          bundle: result.bundle === true,
          installedAt: now(),
          envKeys: envAllowList.length > 0 ? envAllowList : null
        });
        await queueFeedbackSafe({
          repo,
          name: result.name ?? repo,
          type: result.type,
          version: result.version ?? null,
          installedAt: now(),
          method: npmTargetUsed ? "cli-npm-fallback" : "market-direct",
          reinstall: Boolean(getInstalledRecord(repo)),
          envProfile: await buildEnvProfile(),
          logSnapshot: buildFeedbackLogSnapshot(log)
        }, logLine, lang);
        if (translate) logLine(translate(lang, "feedbackQueued"));
        installed = true;
      }
      const latestVersion = await readPackageVersion(cacheDir);
      if (result && result.type === "instructions") {
        await cleanupCache(cacheDir);
        return {
          status: "manual",
          repo,
          type: "instructions",
          url: `https://github.com/${repo}`,
          ...(cliCommand ? { cliCommand } : {}),
          log
        };
      }
      return {
        status: "done",
        repo,
        installed,
        latestVersion,
        ...result,
        ...(cliCommand ? { cliCommand } : {}),
        log
      };
    } catch (error) {
      await cleanupCache(cacheDir);
      const errText = [error?.message, error?.stderr].filter(Boolean).join("\n");
      const hint = classifyInstallFailure(errText, lang);
      logLine(translate(lang, "fail", { err: String(error?.message ?? error) }));
      if (hint) logLine(hint);
      // 安装失败同样入队反馈（outcome=install-failed + 结构化 errorClass），
      // 让「未走到成功路径」的失败也进入待提交队列。
      await queueFeedbackSafe({
        repo,
        name: repo,
        type: type ?? null,
        version: null,
        installedAt: now(),
        method: npmTargetUsed ? "cli-npm-fallback" : "market-direct",
        outcome: "install-failed",
        errorClass: classifyInstallFailureKind ? classifyInstallFailureKind(errText) : "unclassified",
        envProfile: await buildEnvProfile(),
        logSnapshot: buildFeedbackLogSnapshot(log)
      }, logLine, lang);
      return {
        status: "failed",
        repo,
        log,
        error: hint
          ? `${String(error?.message ?? error)}\n\n${hint}`
          : String(error?.message ?? error)
      };
    }
  };
}
