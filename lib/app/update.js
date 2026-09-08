// 自更新用例层：市场本体版本检测与更新编排（check-update / self-update）。
// 通过依赖注入接收版本读取、GitHub 直连、registry 缓存兜底、版本判定、官方 DSH CLI、
// git clone、文件系统与路径能力，不依赖 HTTP request/response；互斥与响应由组合层负责。
// 状态机（selfUpdateState）归本模块持有，route 经 getState/check/run/closeState 访问。

export function createUpdateUseCase({
  readOwnVersion,
  fetchLatestVersion,
  fetchLatestFromCache,
  shouldUpdate,
  compareVersions,
  runDsh,
  runGit,
  readFile,
  exists,
  rename,
  rm,
  joinPath,
  dirnamePath,
  randomHex,
  selfUpdateRepo,
  destRoot,
  pushLog,
  now = () => Date.now()
}) {
  let selfUpdateState = { installedVersion: null, latestVersion: null, updateAvailable: false, checkedAt: 0, error: null };

  /** 直链 GitHub（contents API，实时不过 CDN 缓存）查市场本体最新版本，与已装版本对比。 */
  async function check() {
    try {
      const installedVersion = readOwnVersion();
      const latestVersion = await fetchLatestVersion();
      if (latestVersion === null) throw new Error("GitHub API non-ok");
      selfUpdateState = {
        installedVersion,
        latestVersion,
        updateAvailable: shouldUpdate(installedVersion, latestVersion),
        checkedAt: now(),
        error: null
      };
    } catch (error) {
      // 直连失败：回退 registry 索引里的版本号；都没有则保留上次状态并记录错误
      const fallback = fetchLatestFromCache();
      if (fallback) {
        const installedVersion = readOwnVersion();
        selfUpdateState = {
          installedVersion,
          latestVersion: fallback,
          updateAvailable: shouldUpdate(installedVersion, fallback),
          checkedAt: now(),
          error: null
        };
      } else {
        selfUpdateState = { ...selfUpdateState, checkedAt: now(), error: String(error?.message ?? error) };
      }
    }
  }

  /**
   * 目录替换式自更新（v1.4.10 路径，官方 CLI 不可用时的回退）：
   * git clone 最新仓库 → staging 校验（版本高于当前 + 核心文件齐全）→
   * rename 原子替换本体目录（destRoot → backup，staging → destRoot，失败回滚）。
   */
  async function updateByClone() {
    const parent = dirnamePath(destRoot);
    const staging = joinPath(parent, `.dsh-marketplace-staging-${randomHex()}`);
    const backup = joinPath(parent, `.dsh-marketplace-backup-${randomHex()}`);
    const installedVersion = readOwnVersion();
    try {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      await rm(backup, { recursive: true, force: true }).catch(() => {});
      await runGit(["clone", "--depth", "1", `https://github.com/${selfUpdateRepo}.git`, staging], { timeout: 300000 });
      // staging 校验：版本必须高于当前、核心文件齐全（防半成品覆盖本体）
      const stagedPkg = JSON.parse(await readFile(joinPath(staging, "package.json"), "utf8"));
      const stagedVersion = typeof stagedPkg?.version === "string" ? stagedPkg.version : null;
      if (!stagedVersion || !installedVersion || compareVersions(stagedVersion, installedVersion) <= 0) {
        throw new Error(`staging version check failed: got v${stagedVersion ?? "?"}, installed v${installedVersion ?? "?"}`);
      }
      for (const f of ["package.json", "lib/index.js", "lib/client.js", "install.sh", "install.ps1"]) {
        if (!(await exists(joinPath(staging, f)))) throw new Error(`staging incomplete: missing ${f}`);
      }
      // 原子替换：destRoot → backup，staging → destRoot；第二步失败回滚
      await rename(destRoot, backup);
      try {
        await rename(staging, destRoot);
      } catch (error) {
        await rename(backup, destRoot).catch(() => {});
        throw error;
      }
      await rm(backup, { recursive: true, force: true }).catch(() => {});
      const newVersion = readOwnVersion();
      if (!newVersion || compareVersions(newVersion, installedVersion) <= 0) {
        throw new Error(`self-update verification failed: still v${newVersion ?? "?"}`);
      }
      return { status: "done", installedVersion: newVersion };
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** 更新市场本体（v1.4.7）：官方 CLI 优先，失败回退目录替换；staging 校验通过才替换。
   *  - 最新版本优先实时直连 GitHub（与 check 同源），失败直接报错（不回退索引——索引
   *    version 是构建期抓的，可能滞后，fallback 会误判「已是最新」让用户以为更新成功）；
   *  - 无更新返回 { status: "no-update" }，成功返回 { status: "done", installedVersion }。
   *  调用方（路由）负责 installMutex 互斥。 */
  async function run() {
    const installedVersion = readOwnVersion();
    let latestVersion = null;
    try {
      latestVersion = await fetchLatestVersion();
    } catch {
      // v1.4.10：执行更新时直连失败直接报错，不再回退索引版本——索引 version 是构建期抓的，
      // 可能滞后（实测曾停在旧版本），fallback 会误判「已是最新」让用户以为更新成功；
      // 直连都失败时 git clone 大概率也失败，明确报错比误导更诚实。
      throw new Error("unable to reach GitHub to check the latest version");
    }
    if (!latestVersion) throw new Error("unable to read the latest version from GitHub");
    if (!shouldUpdate(installedVersion, latestVersion)) {
      return { status: "no-update", installedVersion, latestVersion };
    }
    // v1.4.11：改走官方 CLI 安装（dsh plugin install）——pnpm workspace profile 下本体以
    // github: 依赖安装并锁定在 pnpm-lock.yaml，仅替换目录文件会在下一次 pnpm install 时
    // 被按 lock 还原（实测：更新 pi2dsh 触发 pnpm install 后本体被还原成 lock 锁定的旧版）。
    // 官方 CLI 会同步更新 package.json 与 pnpm-lock.yaml，才是完整、可持久的更新。
    // dsh CLI 优先用 %APPDATA%\npm\dsh.cmd（start-dsh.bat 同款路径），缺失时回退 PATH 里的 dsh。
    try {
      // 自更新固定 web：本体的宿主 profile 与 targetProfile（插件安装目标）是两个概念
      // ——用户在 web 里跑市场、把插件装去 desktop 时，本体更新仍应回到自己的家。
      const dshArgs = ["plugin", "--profile", "web", "install", selfUpdateRepo];
      // 超时 180s：官方 CLI 内部 spawn pnpm 在 Windows 上可能因 .cmd 垫片 EINVAL 立即失败，
      // 但也可能挂起——快速失败进入目录替换回退比让用户干等更合理。
      await runDsh(dshArgs, { timeout: 180000 });
    } catch (error) {
      // 官方 CLI 路径不可用（dsh CLI 缺失 / pnpm 缺失 / Windows pnpm.cmd 垫片 EINVAL /
      // pnpm 拦截 git 依赖 build 脚本等）→ 回退 v1.4.10 目录替换式更新。
      // 已知代价：pnpm workspace profile 下可能被后续 pnpm install 按 lock 还原——
      // 但这比「完全无法更新」好，且回退路径本身带版本校验与原子回滚。
      pushLog(`self-update: 官方 CLI 失败（${String(error?.message ?? error).slice(0, 120)}），回退目录替换更新`);
      return await updateByClone();
    }
    // 安装后验证：本体版本必须真的更新了（官方 CLI 可能静默失败/装旧版）
    const newVersion = readOwnVersion();
    if (!newVersion || compareVersions(newVersion, installedVersion) <= 0) {
      throw new Error(`self-update verification failed: still v${newVersion ?? "?"}`);
    }
    return { status: "done", installedVersion: newVersion };
  }

  /** #157 回归：更新成功后闭合状态机——本体已写入新版本（updateByClone 替换目录），
   *  若不重置 updateAvailable，GET /self-update 仍返回旧 state（true）→ 客户端横幅刷新后复活。
   *  直接以新版本覆盖，不再触发网络重查（刚拉过最新，本地即权威）。 */
  function closeState(result) {
    selfUpdateState = {
      installedVersion: result.installedVersion ?? readOwnVersion(),
      latestVersion: result.latestVersion ?? result.installedVersion,
      updateAvailable: false,
      checkedAt: now(),
      error: null
    };
  }

  return {
    getState: () => selfUpdateState,
    check,
    run,
    closeState
  };
}
