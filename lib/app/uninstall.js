// 卸载用例层：删除已安装的文件与写入的配置（skill/agent 预设直接删目录；
// cordis 插件删包目录 + cordis.patch.yml 注册条目；多插件仓库按记录的子包名逐个删除）。
// 通过依赖注入接收记录查询、路径派生、受管目录、文件删除、pnpm、patch 与反馈清理能力，
// 不依赖 HTTP request/response；互斥与日志快照由组合层（route）负责。

export function createUninstallUseCase({
  getInstalledRecord,
  removeInstalled,
  resolveRecordNodeModules,
  profileNodeModules,
  profileDir,
  profilePatchFile,
  profilePackageFile,
  joinPath,
  resolvePath,
  dirnamePath,
  pathSep,
  rm,
  runPnpm,
  buildFilteredEnv,
  readProfileManifest,
  writeProfileManifest,
  removePatchEntry,
  managedDirs,
  removePendingFeedback,
  saveFeedback,
  translate
}) {
  return async function runUninstallUseCase({ repo, log, logLine, lang }) {
    const record = getInstalledRecord(repo);
    if (!record) {
      logLine(translate(lang, "uninstallNone"));
      return { status: "done", repo, removed: 0, log };
    }
    logLine(translate(lang, "uninstalling", { repo }));
    let removed = 0;
    try {
      if (record.type === "skill" || record.type === "agent-preset") {
        // skill / agent 预设：直接删除安装目录（location 即目标目录，且必须在受管目录内）。
        // 多预设记录（嵌套预设仓库）location 是 PRESETS_DIR 本身——必须按 names 逐个删，
        // 绝不能整体删除（会误删其他预设）。
        if (record.type === "agent-preset" && Array.isArray(record.names) && record.names.length > 0) {
          for (const presetName of record.names) {
            const target = joinPath(managedDirs.presetsDir, presetName);
            if (resolvePath(target).startsWith(resolvePath(managedDirs.presetsDir) + pathSep)) {
              await rm(target, { recursive: true, force: true }).catch(() => {});
              removed++;
            }
          }
        } else {
          // 安全约束：多 skill / 多预设仓库安装时 location 记为 SKILLS_DIR / PRESETS_DIR 本身
          //（无尾分隔符，见 installRepo 多根分支）——此前仅前缀校验恒 false，rm 被跳过、
          // 目录残留而记录已删；精确相等（=== 目录本身）同样放行，仍受受管目录约束，无越界。
          const location = String(record.location ?? "");
          const skillsDir = resolvePath(managedDirs.skillsDir);
          const presetsDir = resolvePath(managedDirs.presetsDir);
          const loc = resolvePath(location);
          const insideManaged = loc === skillsDir || loc === presetsDir
            || loc.startsWith(skillsDir + pathSep) || loc.startsWith(presetsDir + pathSep);
          if (location && insideManaged) {
            await rm(location, { recursive: true, force: true }).catch(() => {});
            removed++;
          }
        }
      } else if (record.type === "cordis-plugin" || record.type === "bundle" || record.type === "cli") {
        // 多插件仓库按记录的子包名逐个删除；单插件用 name（包名）；旧记录退化为 location 推断。
        // cli 类型（官方 CLI 安装，如 `dsh plugin add dshmarket`）同样按包目录 + patch 条目清理。
        // 安全校验：`!/-plugins$/` 是防呆——个别仓库把 record.name 存成了
        // "xxx-plugins"（仓库目录名而非包名，如聚合型仓库），直接当包目录删会误删 node_modules
        // 下不存在的路径；真实插件包名不会以 -plugins 结尾，命中则放弃该 name 走 location 推断。
        let targets = [];
        if (Array.isArray(record.names) && record.names.length > 0) {
          targets = record.names;
        } else if (typeof record.name === "string" && record.name && !/-plugins$/.test(record.name)) {
          targets = [record.name];
        }
        // 目标 profile 切换后卸载旧 profile 的安装（issue #184 边界）：按包名拼的
        // 路径指向当前 profileNodeModules()——旧 profile 的实体不在那里，rm force:true 静默
        // 无操作 → 记录删除但目录/patch 残留（孤儿态）。resolveRecordNodeModules
        // 按 record.location 定位真实落点，pnpm remove 以其所属 profile 为工作目录。
        const recordNm = resolveRecordNodeModules(record);
        const legacyProfileDir = recordNm !== profileNodeModules() ? dirnamePath(recordNm) : null;
        // 旧记录退化为 location 推断：锚点按记录定位（跨 profile 时 location 在
        // 旧 profile 的 node_modules 内，同样可推断包名——不能用当前 profileNodeModules() 判断）
        if (targets.length === 0 && typeof record.location === "string"
            && record.location !== recordNm
            && resolvePath(record.location).startsWith(resolvePath(recordNm) + pathSep)) {
          targets = [record.location.split(pathSep).at(-1)];
        }
        if (targets.length > 0) {
          // 卸载步骤失败不得静默吞错——目录删除失败或 patch 条目移除失败
          // 会造成「目录已删但 patch 残留（下次启动注册失败）」或反向的状态分裂。
          // 逐项如实反馈，汇总进 removed/removeErrors。
          for (const pkgName of targets) {
            if (record.bundle === true) {
              // bundle 注册包（issue #134）：无 patch 条目；主路径 pnpm remove
              // （同步清理 profile package.json / lockfile / 目录）。pnpm 不可用时
              // 降级为手工移除 profile 条目 + 目录删除。
              logLine(translate(lang, "uninstallBundlePnpm", { name: pkgName }));
              try {
                // --ignore-workspace：同注册路径（runPnpm 的 workspace 吞依赖陷阱）
                await runPnpm(["remove", "--ignore-workspace", pkgName], { cwd: legacyProfileDir ?? profileDir(), env: buildFilteredEnv(), timeout: 600000 });
                removed++;
              } catch (error) {
                const legacyManifest = legacyProfileDir ? joinPath(legacyProfileDir, "package.json") : profilePackageFile();
                const manifest = await readProfileManifest(legacyManifest);
                if (manifest) {
                  let changed = false;
                  if (manifest.dependencies && typeof manifest.dependencies === "object"
                      && manifest.dependencies[pkgName] !== undefined) {
                    delete manifest.dependencies[pkgName];
                    changed = true;
                  }
                  const bundles = manifest?.dsh?.profile?.bundles;
                  if (Array.isArray(bundles)) {
                    const idx = bundles.indexOf(pkgName);
                    if (idx >= 0) {
                      bundles.splice(idx, 1);
                      changed = true;
                    }
                  }
                  if (changed) await writeProfileManifest(manifest, legacyManifest).catch(() => {});
                }
                const bundleDest = joinPath(recordNm, pkgName);
                if (resolvePath(bundleDest).startsWith(resolvePath(recordNm) + pathSep)) {
                  await rm(bundleDest, { recursive: true, force: true }).catch(() => {});
                }
                logLine(translate(lang, "uninstallBundleDegraded", { name: pkgName, err: String(error?.message ?? error).slice(0, 200) }));
              }
              continue;
            }
            const dest = joinPath(recordNm, pkgName);
            if (resolvePath(dest).startsWith(resolvePath(recordNm) + pathSep)) {
              try {
                await rm(dest, { recursive: true, force: true });
                removed++;
              } catch (error) {
                logLine(translate(lang, "uninstallRmFail", { name: pkgName, err: String(error?.message ?? error) }));
              }
            }
            try {
              // 跨 profile 卸载：patch 条目在安装时的 profile（recordNm 所属），
              // 不在当前 profilePatchFile()——清错文件会让旧 profile 启动时注册失败
              await removePatchEntry(pkgName, legacyProfileDir ? joinPath(legacyProfileDir, "cordis.patch.yml") : profilePatchFile());
            } catch (error) {
              logLine(translate(lang, "uninstallPatchFail", { name: pkgName, err: String(error?.message ?? error) }));
            }
          }
        } else {
          logLine(translate(lang, "uninstallNoTargets"));
        }
      } else if (record.type === "script") {
        // 脚本型插件：自身效果无法回滚，仅移除安装记录与克隆缓存。
        // 受管目录校验（与 skill/preset/cordis 型一致）：location 必须位于克隆缓存
        // CACHE_DIR 内——防 installed.json 被篡改时删除任意路径（安全纵深）。
        const location = String(record.location ?? "");
        const insideCache = location && resolvePath(location).startsWith(resolvePath(managedDirs.cacheDir) + pathSep);
        if (insideCache) {
          await rm(location, { recursive: true, force: true }).catch(() => {});
        }
        logLine(translate(lang, "uninstallScriptNote"));
      }
      await removeInstalled(repo);
      // 卸载后清理反馈队列：已卸载插件的「这个插件正常吗」询问无意义（queueFeedback
      // 只在安装成功路径入队，卸载路径此前不清理——下次打开市场仍会弹已卸载插件的反馈）
      if (removePendingFeedback(repo)) await saveFeedback();
      logLine(translate(lang, "uninstalled"));
      return { status: "done", repo, removed, log };
    } catch (error) {
      logLine(translate(lang, "uninstallFail", { err: String(error?.message ?? error) }));
      return { status: "failed", repo, log, error: String(error?.message ?? error) };
    }
  };
}
