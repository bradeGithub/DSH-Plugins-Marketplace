// 自更新用例层：市场本体版本检测与更新编排（check-update / self-update）。
// 通过依赖注入接收版本读取、tag 解析、GitHub 直连、registry 缓存兜底、版本判定、
// 官方 DSH CLI、git、文件系统与路径能力，不依赖 HTTP request/response；
// 互斥与响应由组合层负责。状态机（selfUpdateState）归本模块持有。
//
// 完整性锚（S6）：更新目标必须是「维护者离线私钥签名的 annotated git tag」——
// 候选 semver 降序逐个取证验签，首个通过者生效；验签只认本地 git 对象
// （bare fetch tag ref → cat-file 原文），不拼 API 字段；公钥白名单为组合层注入的
// 编译期常量（lib/allowed-signers.js），绝不读 staged/远端同名内容。
// 任何一步失败 fail-closed，不回落 main HEAD。

import { parseSignedTag, verifySshSig } from "../domain/sshsig.js";

const STABLE_TAG = /^v?\d+\.\d+\.\d+$/;
const PRERELEASE_TAG = /^v?\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/;
const MAX_TAG_CANDIDATES = 30;
const CORE_FILES = ["package.json", "lib/index.js", "lib/client.js", "install.sh", "install.ps1"];

export function createUpdateUseCase({
  readOwnVersion,
  fetchVersionAtRef,
  fetchLatestFromCache,
  shouldUpdate,
  compareVersions,
  listTagRefs,
  runDsh,
  runGit,
  readFile,
  exists,
  rename,
  rm,
  mkdir,
  mkdtemp,
  tmpdirPath,
  joinPath,
  dirnamePath,
  randomHex,
  selfUpdateRepo,
  updateRepoUrl,
  destRoot,
  pushLog,
  recordSelfUpdate,
  allowedSigners = [],
  revokedKeys = [],
  allowUnsigned = false,
  allowPrerelease = false,
  now = () => Date.now()
}) {
  let selfUpdateState = { installedVersion: null, latestVersion: null, updateAvailable: false, checkedAt: 0, error: null };

  // updateRepoUrl 允许镜像/测试重定向（验签仍在本地对象上，改 URL 不绕过签名）
  const repoUrl = () => updateRepoUrl ?? `https://github.com/${selfUpdateRepo}.git`;

  /**
   * 取证唯一入口：tag 对象只认本地 git 仓库里的字节。
   * API 的 message 字段只是说明文字（tagger 拆 JSON、日期格式不同），与
   * `cat-file tag` 不是同一串内容，不能用来构造验签 payload。
   */
  async function fetchTagObjectText(tagName) {
    const tmp = await mkdtemp(joinPath(tmpdirPath(), "dsh-tag-"));
    try {
      await runGit(["init", "--bare", tmp], { timeout: 30000 });
      await runGit(
        ["--git-dir", tmp, "fetch", "--depth", "1", "--no-tags", repoUrl(), `refs/tags/${tagName}:refs/tags/${tagName}`],
        { timeout: 120000 }
      );
      const out = await runGit(["--git-dir", tmp, "cat-file", "tag", tagName], { timeout: 30000 });
      return String(out?.stdout ?? "");
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * 候选 → 降序逐个验签 → 首个通过者（攻击者推未签名高版本 tag 只能造噪音，卡不住）。
   * 返回 {tag, sha, version, signedBy} | null。
   */
  async function resolveVerifiedRelease() {
    if (allowedSigners.length === 0 && !allowUnsigned) {
      throw new Error("self-update disabled: no release signing keys configured");
    }
    const refs = await listTagRefs();
    const tagPattern = allowPrerelease ? /^(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/ : STABLE_TAG;
    const candidates = (Array.isArray(refs) ? refs : [])
      .filter((r) => r && r.type === "tag" && typeof r.name === "string" && tagPattern.test(r.name))
      .map((r) => ({ name: r.name, version: r.name.replace(/^v/, "") }))
      .sort((a, b) => compareVersions(b.version, a.version))
      .slice(0, MAX_TAG_CANDIDATES);
    for (const cand of candidates) {
      const text = await fetchTagObjectText(cand.name).catch(() => null);
      if (!text) continue;
      const parsed = parseSignedTag(text);
      if (!parsed.ok) {
        // 显式逃生口：未签名 tag 仍须过 objectType/version 绑定，才允许进入
        if (allowUnsigned && /unsigned/.test(parsed.error ?? "") && parsed.objectType === "commit") {
          const version = await fetchVersionAtRef(cand.name).catch(() => null);
          if (version === cand.version) {
            pushLog(`self-update: tag ${cand.name} 未签名（ALLOW_UNSIGNED 逃生口生效）`);
            return { tag: cand.name, sha: parsed.objectSha, version, signedBy: null };
          }
        }
        continue; // unsigned / malformed → 跳过看下一个
      }
      if (parsed.objectType !== "commit") continue; // 只剥到 commit
      if (parsed.tagName !== cand.name) continue;   // ref 名与对象内 tag 名一致
      const sig = verifySshSig({ payload: parsed.payload, armor: parsed.armor, allowedSigners, revokedKeys });
      if (!sig.ok) {
        pushLog(`self-update: tag ${cand.name} 验签失败（${sig.error}），跳过`);
        continue;
      }
      // tag 名 ↔ package.json version 绑定（防签名合法但指向错版本）
      const version = await fetchVersionAtRef(cand.name).catch(() => null);
      if (version !== cand.version) {
        pushLog(`self-update: tag ${cand.name} 与 package.json version 不符（${version ?? "?"}），跳过`);
        continue;
      }
      return { tag: cand.name, sha: parsed.objectSha, version, signedBy: sig.signedBy };
    }
    return null;
  }

  /** 直链 GitHub 查最新已验证 release，与已装版本对比。 */
  async function check() {
    try {
      const installedVersion = readOwnVersion();
      const verifiedRelease = await resolveVerifiedRelease();
      if (!verifiedRelease) throw new Error("no maintainer-signed release tag found");
      selfUpdateState = {
        installedVersion,
        latestVersion: verifiedRelease.version,
        updateAvailable: shouldUpdate(installedVersion, verifiedRelease.version),
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
   * 自更新主路径（S6）：按已验证 commit sha 取证——fetch by sha 免疫「验签后 tag 被拧走」。
   * staging（init + fetch sha + detached checkout）→ HEAD 绑定 → version 绑定 →
   * 核心文件齐全 → rename 原子替换（destRoot → backup，staging → destRoot，失败回滚）。
   */
  async function updateByFetchTag(rel) {
    const parent = dirnamePath(destRoot);
    const staging = joinPath(parent, `.dsh-marketplace-staging-${randomHex()}`);
    const backup = joinPath(parent, `.dsh-marketplace-backup-${randomHex()}`);
    const installedVersion = readOwnVersion();
    try {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      await rm(backup, { recursive: true, force: true }).catch(() => {});
      await mkdir(staging, { recursive: true });
      await runGit(["-C", staging, "init"], { timeout: 30000 });
      await runGit(["-C", staging, "remote", "add", "origin", repoUrl()], { timeout: 30000 });
      try {
        await runGit(["-C", staging, "fetch", "--depth", "1", "origin", rel.sha], { timeout: 300000 });
      } catch {
        // 服务端不允许按 sha 抓（未开 allowReachableSHA1InWant）→ 退回按 tag ref 抓，
        // 下方 rev-parse 绑定仍会把关内容与已验签 commit 一致。
        await runGit(
          ["-C", staging, "fetch", "--depth", "1", "origin", `refs/tags/${rel.tag}:refs/tags/${rel.tag}`],
          { timeout: 300000 }
        );
      }
      await runGit(["-C", staging, "checkout", "--detach", "FETCH_HEAD"], { timeout: 60000 });
      const headOut = await runGit(["-C", staging, "rev-parse", "HEAD"], { timeout: 30000 });
      const head = String(headOut?.stdout ?? "").trim();
      if (head !== rel.sha) {
        throw new Error(`self-update binding failed: staged HEAD ${head} != signed commit ${rel.sha}`);
      }
      // staging 校验：版本必须等于已验证 tag 的版本、且高于当前、核心文件齐全
      const stagedPkg = JSON.parse(await readFile(joinPath(staging, "package.json"), "utf8"));
      const stagedVersion = typeof stagedPkg?.version === "string" ? stagedPkg.version : null;
      if (stagedVersion !== rel.version) {
        throw new Error(`staging version binding failed: package.json v${stagedVersion ?? "?"} != tag ${rel.tag}`);
      }
      if (!installedVersion || compareVersions(stagedVersion, installedVersion) <= 0) {
        throw new Error(`staging version check failed: got v${stagedVersion ?? "?"}, installed v${installedVersion ?? "?"}`);
      }
      for (const f of CORE_FILES) {
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

  /**
   * 观测面：pnpm-lock.yaml 中本包 git dep 是否记录了目标 commit。
   * pnpm 对 GitHub 源常记 codeload tarball 而非 resolution.commit——读不出即视为
   * 「pin 未证实」，绝不采信「看起来像新」的安装结果。
   */
  async function readPinnedCommit() {
    const lockPath = joinPath(dirnamePath(dirnamePath(destRoot)), "pnpm-lock.yaml");
    const text = await readFile(lockPath, "utf8").catch(() => null);
    if (!text) return null;
    const escRepo = selfUpdateRepo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const direct = text.match(new RegExp(`github\\.com/${escRepo}/([0-9a-f]{40})`));
    if (direct) return direct[1];
    const block = text.match(new RegExp(`${escRepo}["']?[\\s\\S]{0,400}?commit:\\s*([0-9a-f]{40})`));
    return block ? block[1] : null;
  }

  /** 更新市场本体：签名 tag 锚定的 fetch 路径优先，CLI pin 仅当观测面可证。 */
  async function run() {
    const installedVersion = readOwnVersion();
    if (allowedSigners.length === 0 && !allowUnsigned) {
      throw new Error("self-update disabled: no release signing keys configured");
    }
    let rel;
    try {
      rel = await resolveVerifiedRelease();
    } catch {
      throw new Error("unable to reach GitHub to check the latest version");
    }
    if (!rel) {
      throw new Error("no maintainer-signed release tag found; refusing unanchored self-update");
    }
    if (!shouldUpdate(installedVersion, rel.version)) {
      return { status: "no-update", installedVersion, latestVersion: rel.version };
    }
    let result;
    try {
      result = await updateByFetchTag(rel);
    } catch (primaryError) {
      // 次选：官方 CLI + sha pin；装后必须能观测到 pin 记录与版本提升，否则中止。
      pushLog(`self-update: fetch-tag 路径失败（${String(primaryError?.message ?? primaryError).slice(0, 120)}），尝试官方 CLI pin`);
      try {
        await runDsh(["plugin", "--profile", "web", "install", `github:${selfUpdateRepo}#${rel.sha}`], { timeout: 180000 });
      } catch (cliError) {
        throw new Error(`self-update failed: ${String(cliError?.message ?? cliError).slice(0, 160)}`);
      }
      const pinned = await readPinnedCommit();
      const newVersion = readOwnVersion();
      if (pinned !== rel.sha) {
        throw new Error("self-update aborted: CLI install did not provably pin the signed commit");
      }
      if (!newVersion || compareVersions(newVersion, installedVersion) <= 0) {
        throw new Error(`self-update verification failed: still v${newVersion ?? "?"}`);
      }
      result = { status: "done", installedVersion: newVersion };
    }
    if (recordSelfUpdate) {
      await recordSelfUpdate({
        at: new Date(now()).toISOString(),
        fromVersion: installedVersion,
        toVersion: result.installedVersion,
        tag: rel.tag,
        sha: rel.sha,
        signedBy: rel.signedBy
      }).catch(() => {});
    }
    pushLog(`self-update: ${installedVersion} → ${result.installedVersion}（tag ${rel.tag} @ ${rel.sha.slice(0, 8)}${rel.signedBy ? `, signed by ${rel.signedBy}` : ""}）`);
    return result;
  }

  /** #157 回归：更新成功后闭合状态机，不再触发网络重查（刚验过签，本地即权威）。 */
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
