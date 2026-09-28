import { withPnpmWorkspaceScope } from "../domain/pnpm-args.js";

export function createBundleRegisterAdapter({
  fs: { readFile, writeFile, rename, rm, realpath, exists },
  profilePaths: { profileDir, nodeModules, packageFile },
  runPnpm,
  resolvePackage,
  joinPath,
  resolvePath,
  pathSep,
  packageNamePattern,
  translate,
}) {
  const message = (lang, key, params) => translate(lang, key, params);

  async function readManifest(path) {
    try {
      const data = JSON.parse(await readFile(path, "utf8"));
      return data && typeof data === "object" ? data : null;
    } catch {
      return null;
    }
  }

  async function writeManifest(data, path) {
    const tmp = path + ".tmp";
    await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    await rename(tmp, path);
  }

  async function registerBundlePackage(pkgName, depSpec, env, logLine, lang, paths = {}) {
    const bundleProfileDir = paths.profileDir ?? profileDir();
    const bundleNodeModules = paths.nodeModules ?? nodeModules();
    const bundlePackageFile = paths.packageFile ?? packageFile();
    const manifest = await readManifest(bundlePackageFile);
    if (!manifest) throw new Error(message(lang, "bundleNoProfilePkg"));

    const snapshot = JSON.stringify(manifest);
    const rollback = async () => {
      try {
        await writeManifest(JSON.parse(snapshot), bundlePackageFile);
      } catch (rollbackErr) {
        logLine(message(lang, "bundleRollbackWarn", {
          err: String(rollbackErr?.message ?? rollbackErr).slice(0, 200),
        }));
      }
    };

    const deps = manifest.dependencies && typeof manifest.dependencies === "object"
      ? manifest.dependencies
      : {};
    deps[pkgName] = depSpec;
    manifest.dependencies = deps;
    const dsh = manifest.dsh && typeof manifest.dsh === "object" ? manifest.dsh : {};
    const profile = dsh.profile && typeof dsh.profile === "object" ? dsh.profile : {};
    const bundles = Array.isArray(profile.bundles) ? profile.bundles : [];
    if (!bundles.includes(pkgName)) bundles.push(pkgName);
    profile.bundles = bundles;
    dsh.profile = profile;
    manifest.dsh = dsh;
    await writeManifest(manifest, bundlePackageFile);
    logLine(message(lang, "bundleRecorded", { name: pkgName, spec: depSpec }));
    logLine(message(lang, "bundlePnpm"));

    let pnpmErr = null;
    try {
      // profile 自带 pnpm-workspace.yaml 时它即 workspace 根锚（pnpm 上溯到最近的
      // 文件即停）且 nodeLinker/allowBuilds 等 settings 必须生效；缺失时才需
      // --ignore-workspace 兜底祖先 workspace 吞依赖（issue #146，详见 pnpm-args.js）。
      const hasOwnWorkspace = await exists(joinPath(bundleProfileDir, "pnpm-workspace.yaml"));
      await runPnpm(withPnpmWorkspaceScope(["install"], hasOwnWorkspace), {
        cwd: bundleProfileDir,
        env,
        timeout: 600000,
      });
    } catch (error) {
      // 保留 stderr 尾部而非头部：execFile error.message 形如
      // "Command failed: <cmd>\n<stderr>"，pnpm 的真实 ERR_/git 错误在输出末尾，
      // 截头只剩 runner 噪音（issue #256 里真错误就是被这样截掉的）。
      const errText = typeof error?.stderr === "string" && error.stderr
        ? error.stderr
        : String(error?.message ?? error);
      pnpmErr = errText.slice(-400);
    }

    const resolvedPkg = joinPath(bundleNodeModules, ...pkgName.split("/"));
    if (!(await exists(joinPath(resolvedPkg, "package.json")))) {
      await rollback();
      throw new Error(message(lang, "bundleResolveFail", { name: pkgName, err: pnpmErr ?? "" }));
    }
    if (pnpmErr) logLine(message(lang, "bundlePnpmWarn", { err: pnpmErr }));

    let depNames = [];
    let bundlePkg = null;
    try {
      bundlePkg = JSON.parse(await readFile(joinPath(resolvedPkg, "package.json"), "utf8"));
    } catch {}
    if (bundlePkg && typeof bundlePkg.main === "string" && bundlePkg.main.length > 0) {
      const rootResolved = resolvePath(resolvedPkg);
      const mainResolved = resolvePath(joinPath(resolvedPkg, bundlePkg.main));
      const mainInside = mainResolved === rootResolved || mainResolved.startsWith(rootResolved + pathSep);
      if (!mainInside) {
        await rollback();
        await rm(resolvedPkg, { recursive: true, force: true }).catch(() => {});
        throw new Error(message(lang, "bundleEntryTraversal", { name: pkgName, main: bundlePkg.main }));
      }
      if (!(await exists(mainResolved))) {
        await rollback();
        await rm(resolvedPkg, { recursive: true, force: true }).catch(() => {});
        throw new Error(message(lang, "bundleEntryMissing", { name: pkgName, main: bundlePkg.main }));
      }
    }

    if (bundlePkg) depNames = Object.keys({
      ...(bundlePkg.dependencies ?? {}),
      ...(bundlePkg.peerDependencies ?? {}),
    });
    const invalidDeps = depNames.filter((name) => !packageNamePattern.test(String(name)));
    if (invalidDeps.length > 0) {
      await rollback();
      throw new Error(message(lang, "bundleDepInvalid", {
        name: pkgName,
        deps: invalidDeps.slice(0, 5).join(", "),
      }));
    }

    const missing = [];
    let anchor = resolvedPkg;
    try {
      anchor = await realpath(resolvedPkg);
    } catch {}
    for (const depName of depNames) {
      let resolved = false;
      for (const spec of [`${depName}/package.json`, depName]) {
        try {
          if (await resolvePackage(anchor, spec)) {
            resolved = true;
            break;
          }
        } catch {}
      }
      if (!resolved) missing.push(depName);
    }
    if (missing.length > 0) {
      await rollback();
      throw new Error(message(lang, "bundleDepsResolveFail", {
        name: pkgName,
        deps: missing.slice(0, 5).join(", "),
      }));
    }
    return resolvedPkg;
  }

  return { registerBundlePackage };
}
