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
  now = () => Date.now()
}) {
  const message = (lang, key, params) => translate(lang, key, params);

  return async function prepareInstall({ repo, cacheDir, logLine, lang }) {
    logLine(message(lang, "step1", { repo }));
    await mkdir(cacheRoot, { recursive: true });

    let reused = false;
    try {
      const st = await stat(cacheDir);
      reused = st.isDirectory() && now() - st.mtimeMs < cacheReuseMs;
    } catch {}

    if (reused) {
      logLine(message(lang, "cacheReuse"));
      return { cacheDir, reused: true };
    }

    await rm(cacheDir, { recursive: true, force: true });
    await runGit(["clone", "--depth", "1", `https://github.com/${repo}.git`, cacheDir], { timeout: 180000 });
    logLine(message(lang, "cloneDone"));

    if (await exists(joinPath(cacheDir, ".gitmodules"))) {
      const gitmodules = await readFile(joinPath(cacheDir, ".gitmodules"), "utf8").catch(() => "");
      const { unsafe } = parseGitmodulesUrls(gitmodules);
      if (unsafe.length > 0) throw new Error(message(lang, "submoduleUnsafe", { urls: unsafe.join(", ") }));
      await runGit(["-c", "protocol.file.allow=never", "submodule", "update", "--init", "--recursive", "--depth", "1"], {
        cwd: cacheDir,
        timeout: 180000
      });
      logLine(message(lang, "submoduleDone"));
    }

    return { cacheDir, reused: false };
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
  saveInstalled,
  queueFeedbackSafe,
  buildEnvProfile,
  buildFeedbackLogSnapshot,
  cleanupCache,
  translate,
  now = () => Date.now()
}) {
  return async function runInstallCli({
    repo,
    cacheDir,
    installProfile,
    log,
    logLine,
    lang
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

      await saveInstalled(repo, {
        type: "cli",
        name: cliInstall.target,
        names: null,
        location: null,
        version: null,
        installedAt: now(),
        envKeys: null,
        profile: installProfile
      });
      await queueFeedbackSafe({
        repo,
        name: cliInstall.target,
        type: "cli",
        version: null,
        installedAt: now(),
        method: "cli",
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
        name: cliInstall.target,
        cliCommand: cliInstall.command,
        latestVersion: null,
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
