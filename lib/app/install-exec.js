export function createInstallExecutor({
  fs: { mkdir, rm, cp, readFile, writeFile, readdir, exists },
  path: { joinPath, resolvePath, pathSep },
  proc: { runScript },
  scan: { findSkillRoots, findPluginRoots, findPresetRoots, readSkillManifest, needsPluginBuild },
  package: { sanitizeManifest, isBundlePackage, packageNamePattern, copyFilter, readPackageVersion },
  adapters: { registerBundlePackage, appendPatchEntry },
  env: { buildMinimalEnv, buildFilteredEnv },
  managedDirs: { skillsDir, presetsDir },
  selfUpdateRepo,
  platform = "unknown",
  slugify,
  buildPluginPackage,
  npmInstallWithFallback,
  translate,
}) {
  const message = (lang, key, params) => translate(lang, key, params);
  const isWindows = platform === "win32";

  return async function installRepo({
    type,
    cacheDir,
    repo,
    log,
    answers = {},
    logLine,
    lang,
    envAllowList = [],
    npmTarget = null,
    profilePaths,
  }) {
    const installProfilePaths = profilePaths;
    const allowedAnswers = new Set(envAllowList);
    const env = type === "script" ? buildMinimalEnv() : buildFilteredEnv();
    for (const key of Object.keys(answers)) {
      if (key.startsWith("__")) continue;
      if (allowedAnswers.has(key)) env[key] = answers[key];
    }

    if (type === "skill") {
      const roots = await findSkillRoots(cacheDir);
      if (roots.length === 0) throw new Error("No SKILL.md was found after cloning the repository.");
      const installed = [];
      await mkdir(skillsDir, { recursive: true });
      for (const root of roots) {
        let skillName = slugify(roots.length === 1 ? repo.split("/")[1] : root.split(pathSep).at(-1));
        try {
          const text = await readSkillManifest(root);
          const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
          const match = fm && fm[1].match(/^name:\s*"?([a-z0-9][a-z0-9-]*)"?$/m);
          if (match) skillName = match[1];
        } catch {}
        const dest = joinPath(skillsDir, skillName);
        await rm(dest, { recursive: true, force: true });
        await cp(root, dest, { recursive: true, filter: copyFilter(root, true) });
        installed.push({ name: skillName, location: dest });
        logLine(message(lang, "skillInstalled", { name: skillName, dest }));
      }
      return {
        type,
        name: installed.length === 1 ? installed[0].name : `${installed.length}-skills`,
        names: installed.map((item) => item.name),
        count: installed.length,
        location: installed.length === 1 ? installed[0].location : skillsDir,
      };
    }

    if (type === "agent-preset") {
      const repoName = repo.split("/")[1] ?? "preset";
      const roots = await findPresetRoots(cacheDir);
      const installRoots = roots.length > 0 ? roots : [cacheDir];
      const installed = [];
      await mkdir(presetsDir, { recursive: true });
      for (const root of installRoots) {
        const base = root === cacheDir ? "" : root.split(pathSep).at(-1) ?? "";
        const presetId = base === "preset" || base === "" ? slugify(repoName) : slugify(base);
        const dest = joinPath(presetsDir, presetId);
        await rm(dest, { recursive: true, force: true });
        await cp(root, dest, { recursive: true, filter: copyFilter(root, true) });
        installed.push({ name: presetId, location: dest });
        logLine(message(lang, "presetInstalled", { name: presetId, dest }));
      }
      return {
        type,
        name: installed.length === 1 ? installed[0].name : `${installed.length}-presets`,
        names: installed.map((item) => item.name),
        count: installed.length,
        location: installed.length === 1 ? installed[0].location : presetsDir,
      };
    }

    if (type === "bundle") {
      if (repo === selfUpdateRepo) throw new Error(message(lang, "selfPatchSkipped"));
      let pkg = null;
      try {
        pkg = JSON.parse(await readFile(joinPath(cacheDir, "package.json"), "utf8"));
      } catch {}
      if (!pkg) throw new Error(`bundle 安装失败：无法读取 ${cacheDir}/package.json`);
      if (!isBundlePackage(pkg)) throw new Error(`bundle 安装失败：${repo} 的 package.json 未声明 dsh.bundle.patch（类型判定与安装判定漂移）`);
      const pkgName = typeof pkg.name === "string" && pkg.name.length > 0 ? pkg.name : slugify(repo.split("/")[1]);
      if (!packageNamePattern.test(pkgName)) throw new Error(`非法包名: ${JSON.stringify(pkgName)}（拒绝安装）`);
      const version = typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : null;
      if (!version) throw new Error(message(lang, "bundleNoVersion", { name: pkgName }));
      const depSpec = typeof npmTarget === "string" && npmTarget.length > 0 ? version : `github:${repo}`;
      logLine(message(lang, "bundleDetected"));
      const resolvedPkg = await registerBundlePackage(pkgName, depSpec, env, logLine, lang, installProfilePaths);
      logLine(message(lang, "bundleDone"));
      return { type, name: pkgName, location: resolvedPkg, version, bundle: true };
    }

    if (type === "script") {
      const hasPs1 = await exists(joinPath(cacheDir, "install.ps1"));
      const hasSh = await exists(joinPath(cacheDir, "install.sh"));
      const usePs1 = hasPs1 && (!hasSh || isWindows);
      if (usePs1) {
        logLine(message(lang, "runPs1"));
        await runScript(joinPath(cacheDir, "install.ps1"), { cwd: cacheDir, env, timeout: 600000 });
      } else if (hasSh) {
        logLine(message(lang, "runSh"));
        await runScript(joinPath(cacheDir, "install.sh"), { cwd: cacheDir, env, timeout: 600000 });
      } else {
        throw new Error(message(lang, "noScript", { repo }));
      }
      logLine(message(lang, "scriptDone", { dir: cacheDir }));
      return { type, location: cacheDir };
    }

    if (type === "cordis-plugin") {
      const roots = await findPluginRoots(cacheDir);
      const scanRoots = roots.length > 0 ? roots : [cacheDir];
      const shouldBuild = String(answers.__confirm_build__) === "allow";
      const installed = [];
      const entryWarnings = [];
      for (const root of scanRoots) {
        let pkgName = slugify(root === cacheDir ? repo.split("/")[1] : root.split(pathSep).at(-1));
        let deps = {};
        let pkg = null;
        try {
          pkg = JSON.parse(await readFile(joinPath(root, "package.json"), "utf8"));
          if (typeof pkg.name === "string" && pkg.name.length > 0) pkgName = pkg.name;
          if (!shouldBuild) {
            const removed = sanitizeManifest(pkg);
            if (removed.length > 0) {
              logLine(message(lang, "npmLocalDeps", { n: removed.length, names: removed.join(", ") }));
              await writeFile(joinPath(root, "package.json"), JSON.stringify(pkg, null, 2), "utf8");
            }
          }
          deps = { ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
        } catch {}
        if (!packageNamePattern.test(pkgName)) throw new Error(`非法包名: ${JSON.stringify(pkgName)}（拒绝安装）`);
        const dest = joinPath(installProfilePaths.nodeModules, pkgName);
        if (!resolvePath(dest).startsWith(resolvePath(installProfilePaths.nodeModules) + pathSep)) {
          throw new Error(`目标路径越界: ${dest}（拒绝安装）`);
        }
        if (isBundlePackage(pkg) && root && repo !== selfUpdateRepo) {
          const version = typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : null;
          if (!version) throw new Error(message(lang, "bundleNoVersion", { name: pkgName }));
          const depSpec = typeof npmTarget === "string" && npmTarget.length > 0 ? version : `github:${repo}`;
          logLine(message(lang, "bundleDetected"));
          const resolvedPkg = await registerBundlePackage(pkgName, depSpec, env, logLine, lang, installProfilePaths);
          logLine(message(lang, "bundleDone"));
          installed.push({ name: pkgName, location: resolvedPkg, version, bundle: true });
          continue;
        }
        if (shouldBuild && await needsPluginBuild(root)) {
          await buildPluginPackage(root, env, logLine, lang);
          logLine(message(lang, "buildDone"));
        }
        if (!shouldBuild && Object.keys(deps).length > 0) {
          logLine(message(lang, "deps", { n: Object.keys(deps).length }));
          const allowScripts = String(answers.__confirm_npm_scripts__) === "allow";
          if (allowScripts) logLine(message(lang, "npmScriptsAllowed"));
          await npmInstallWithFallback(root, env, logLine, lang, allowScripts);
          logLine(message(lang, "depsDone"));
        }
        await mkdir(installProfilePaths.nodeModules, { recursive: true });
        await rm(dest, { recursive: true, force: true });
        await cp(root, dest, { recursive: true, filter: copyFilter(root, false) });
        logLine(message(lang, "copied", { dest }));
        let entryOk = false;
        try {
          const pkgCheck = JSON.parse(await readFile(joinPath(dest, "package.json"), "utf8"));
          const mainFile = typeof pkgCheck.main === "string" && pkgCheck.main.length > 0 ? pkgCheck.main : null;
          entryOk = Boolean(mainFile && await exists(joinPath(dest, mainFile)))
            || (!mainFile && await exists(joinPath(dest, "lib", "index.js")))
            || Boolean(pkgCheck.dsh && (pkgCheck.dsh.client || pkgCheck.dsh.bundle))
            || (await readdir(dest).catch(() => [])).some((file) => /\.(js|cjs|mjs)$/.test(file));
        } catch {}
        if (!entryOk) {
          logLine(message(lang, "entryMissing", { name: pkgName }));
          entryWarnings.push(pkgName);
        }
        const entryId = slugify(pkgName);
        if (repo === selfUpdateRepo) {
          logLine(message(lang, "selfPatchSkipped"));
        } else {
          const appended = await appendPatchEntry(entryId, pkgName, installProfilePaths.patchFile);
          logLine(appended ? message(lang, "patchDone", { id: entryId }) : message(lang, "patchExists"));
        }
        const installedVersion = await readPackageVersion(dest);
        installed.push({ name: pkgName, location: dest, version: installedVersion });
      }
      return {
        type,
        name: installed.length === 1 ? installed[0].name : `${installed.length}-plugins`,
        names: installed.map((item) => item.name),
        count: installed.length,
        location: installed.length === 1 ? installed[0].location : installProfilePaths.nodeModules,
        version: installed.length === 1 ? installed[0].version : null,
        bundle: installed.some((item) => item.bundle),
        ...(entryWarnings.length > 0 ? { warnings: entryWarnings } : {})
      };
    }

    const readme = await readFile(joinPath(cacheDir, "README.md"), "utf8").catch(() => "");
    logLine(message(lang, "instructions"));
    logLine((readme || message(lang, "noReadme")).slice(0, 3000));
    return { type, instructions: true };
  };
}
