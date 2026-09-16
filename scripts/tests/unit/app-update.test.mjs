import { generateKeyPairSync, sign as cryptoSign, createHash } from "node:crypto";
import { createUpdateUseCase } from "../../../lib/app/update.js";

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

const DEST = "/plugins/marketplace";
const STAGING = "/plugins/.dsh-marketplace-staging-abcd";
const BACKUP = "/plugins/.dsh-marketplace-backup-abcd";
const COMMIT = "a".repeat(40);
const TAG_SHA = "b".repeat(40);

// ── 测试侧独立签名器（与 lib/domain/sshsig.js 不同实现路径，同一 wire 规范）──
function sshStr(b) {
  const out = Buffer.alloc(4 + b.length);
  out.writeUInt32BE(b.length, 0);
  Buffer.from(b).copy(out, 4);
  return out;
}
function makeSigner(comment = "test-release") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const blob = Buffer.concat([sshStr(Buffer.from("ssh-ed25519")), sshStr(rawPub)]);
  return { privateKey, signerLine: `ssh-ed25519 ${blob.toString("base64")} ${comment}`, blob };
}
function signPayload(payload, { privateKey, blob }, { ns = "git", hashalg = "sha512" } = {}) {
  const nsB = Buffer.from(ns), resB = Buffer.alloc(0), algB = Buffer.from(hashalg);
  const digest = createHash(hashalg).update(Buffer.from(payload, "utf8")).digest();
  const msg = Buffer.concat([Buffer.from("SSHSIG"), sshStr(nsB), sshStr(resB), sshStr(algB), sshStr(digest)]);
  const sig = cryptoSign(null, msg, privateKey);
  const inner = Buffer.concat([sshStr(Buffer.from("ssh-ed25519")), sshStr(sig)]);
  const wire = Buffer.concat([
    Buffer.from("SSHSIG"),
    (() => { const u = Buffer.alloc(4); u.writeUInt32BE(1, 0); return u; })(),
    sshStr(blob), sshStr(nsB), sshStr(resB), sshStr(algB), sshStr(inner)
  ]);
  return `-----BEGIN SSH SIGNATURE-----\n${wire.toString("base64")}\n-----END SSH SIGNATURE-----`;
}
function makeTagText({ sha = COMMIT, tag = "v1.2.0", type = "commit", armor = null }) {
  const head = `object ${sha}\ntype ${type}\ntag ${tag}\ntagger T <t@t> 0 +0000\n\nrelease ${tag}\n`;
  return armor ? `${head}${armor}\n` : head;
}

const signer = makeSigner();
const goodTagText = makeTagText({ tag: "v1.2.0", armor: signPayload(makeTagText({ tag: "v1.2.0" }), signer) });
// 按 tag 名惰性产出对应签名对象（签名内容与对象字节严格一致）
const tagTextCache = new Map([["v1.2.0", goodTagText]]);
function tagFor(name) {
  if (!tagTextCache.has(name)) {
    tagTextCache.set(name, makeTagText({ tag: name, armor: signPayload(makeTagText({ tag: name }), signer) }));
  }
  return tagTextCache.get(name);
}

function makeUpdate(overrides = {}) {
  const calls = [];
  const logs = [];
  let ownVersion = "1.0.0";
  const options = {
    readOwnVersion: () => ownVersion,
    fetchVersionAtRef: async () => "1.2.0",
    fetchLatestFromCache: () => null,
    shouldUpdate: (i, l) => l !== null && i !== null && l > i,
    compareVersions: (a, b) => (a > b ? 1 : a < b ? -1 : 0),
    listTagRefs: async () => [{ name: "v1.2.0", sha: TAG_SHA, type: "tag" }],
    runDsh: async (args, opts) => calls.push(["dsh", args, opts]),
    runGit: async (args, opts) => {
      calls.push(["git", args, opts]);
      if (args.includes("cat-file")) return { stdout: tagFor(args[args.length - 1]) };
      if (args.includes("rev-parse")) return { stdout: COMMIT };
      return { stdout: "" };
    },
    readFile: async (path) => {
      if (String(path).endsWith("pnpm-lock.yaml")) return `version: github.com/owner/marketplace/${COMMIT}`;
      return JSON.stringify({ version: "1.2.0" });
    },
    exists: async () => true,
    rename: async (from, to) => calls.push(["rename", from, to]),
    rm: async (path) => calls.push(["rm", path]),
    mkdir: async (path) => calls.push(["mkdir", path]),
    mkdtemp: async () => "/tmp/dsh-tag-x",
    tmpdirPath: () => "/tmp",
    joinPath: (...parts) => parts.join("/"),
    dirnamePath: (p) => p.split("/").slice(0, -1).join("/"),
    randomHex: () => "abcd",
    selfUpdateRepo: "owner/marketplace",
    destRoot: DEST,
    pushLog: (line) => logs.push(line),
    recordSelfUpdate: async (e) => calls.push(["record", e]),
    allowedSigners: [signer.signerLine],
    revokedKeys: [],
    now: () => 1000,
    ...overrides
  };
  return {
    flow: createUpdateUseCase(options),
    calls,
    logs,
    setOwnVersion: (v) => { ownVersion = v; }
  };
}

{
  const { flow } = makeUpdate();
  check("初始状态形态", flow.getState(), {
    installedVersion: null, latestVersion: null, updateAvailable: false, checkedAt: 0, error: null
  });
}

{
  const { flow } = makeUpdate();
  await flow.check();
  check("check 验签通过状态", flow.getState(), {
    installedVersion: "1.0.0", latestVersion: "1.2.0", updateAvailable: true, checkedAt: 1000, error: null
  });
}

{
  const { flow } = makeUpdate({
    listTagRefs: async () => { throw new Error("net down"); },
    fetchLatestFromCache: () => "1.1.0"
  });
  await flow.check();
  check("check 直连失败回退缓存", flow.getState(), {
    installedVersion: "1.0.0", latestVersion: "1.1.0", updateAvailable: true, checkedAt: 1000, error: null
  });
}

{
  const { flow } = makeUpdate({
    listTagRefs: async () => { throw new Error("net down"); }
  });
  await flow.check();
  const state = flow.getState();
  check("check 直连失败无缓存保留旧状态", state.installedVersion, null);
  check("check 直连失败无缓存记录错误", state.error, "net down");
  check("check 直连失败无缓存更新 checkedAt", state.checkedAt, 1000);
}

{
  const { flow } = makeUpdate({
    listTagRefs: async () => [],
    fetchLatestFromCache: () => "1.1.0"
  });
  await flow.check();
  check("check 无已验签 tag 回退缓存", flow.getState().latestVersion, "1.1.0");
}

{
  const { flow, calls } = makeUpdate({
    fetchVersionAtRef: async () => "1.0.0",
    listTagRefs: async () => [{ name: "v1.0.0", sha: TAG_SHA, type: "tag" }]
  });
  const result = await flow.run();
  check("run 无更新返回 no-update", result, { status: "no-update", installedVersion: "1.0.0", latestVersion: "1.0.0" });
  check("run 无更新不执行 CLI", calls.filter((c) => c[0] === "dsh"), []);
}

{
  const { flow, calls, setOwnVersion } = makeUpdate({
    rename: async (from, to) => {
      calls.push(["rename", from, to]);
      if (to === DEST) setOwnVersion("1.2.0");
    }
  });
  const result = await flow.run();
  check("run fetch-tag 成功返回 done", result, { status: "done", installedVersion: "1.2.0" });
  const gitCalls = calls.filter((c) => c[0] === "git").map((c) => c[1]);
  check("按 sha 取证", gitCalls.some((a) => a[0] === "-C" && a.includes("fetch") && a.includes(COMMIT)), true);
  check("不 clone main HEAD", gitCalls.some((a) => a[0] === "clone"), false);
  check("detached checkout FETCH_HEAD", gitCalls.some((a) => a.includes("checkout") && a.includes("FETCH_HEAD")), true);
  check("原子替换顺序", calls.filter((c) => c[0] === "rename"), [["rename", DEST, BACKUP], ["rename", STAGING, DEST]]);
  check("取证记录写入", calls.filter((c) => c[0] === "record")[0][1].sha, COMMIT);
}

{
  // fetch-tag 失败 → CLI pin 回退；lockfile 记录 commit === toSha → 采信
  const { flow, calls, setOwnVersion } = makeUpdate({
    runGit: async (args, opts) => {
      calls.push(["git", args, opts]);
      if (args.includes("cat-file")) return { stdout: goodTagText };
      if (args.includes("rev-parse")) return { stdout: COMMIT };
      if (args.includes("fetch") && args.includes("-C")) throw new Error("fetch denied");
      return { stdout: "" };
    },
    runDsh: async (args, opts) => {
      calls.push(["dsh", args, opts]);
      setOwnVersion("1.2.0");
    }
  });
  const result = await flow.run();
  check("fetch 失败回退 CLI pin 成功", result, { status: "done", installedVersion: "1.2.0" });
  check("CLI 参数带 sha pin", calls.filter((c) => c[0] === "dsh")[0][1], ["plugin", "--profile", "web", "install", `github:owner/marketplace#${COMMIT}`]);
}

{
  // fetch-tag 失败 + CLI 装了但 lockfile 无 commit 记录 → 中止（不采信）
  const { flow } = makeUpdate({
    runGit: async (args) => {
      if (args.includes("cat-file")) return { stdout: goodTagText };
      if (args.includes("rev-parse")) return { stdout: COMMIT };
      if (args.includes("fetch") && args.includes("-C")) throw new Error("fetch denied");
      return { stdout: "" };
    },
    runDsh: async () => {},
    readFile: async () => JSON.stringify({ version: "1.2.0" }) // lockfile 读不到 → null
  });
  let threw = null;
  try { await flow.run(); } catch (error) { threw = error.message; }
  check("CLI pin 无观测面中止", threw, "self-update aborted: CLI install did not provably pin the signed commit");
}

{
  // HEAD 绑定：staged rev-parse 与签名 commit 不符 → 主路径拒；CLI 回退亦无版本提升 → 终拒
  const { flow, calls } = makeUpdate({
    runGit: async (args) => {
      if (args.includes("cat-file")) return { stdout: goodTagText };
      if (args.includes("rev-parse")) return { stdout: "f".repeat(40) };
      return { stdout: "" };
    }
  });
  let threw = null;
  try { await flow.run(); } catch (error) { threw = error.message; }
  check("staged HEAD 不符终拒", threw, "self-update verification failed: still v1.0.0");
  check("无 rename 替换发生", calls.filter((c) => c[0] === "rename"), []);
}

{
  // 验签失败：payload 被改 → 视为无已验签 release → run 抛错
  const badTag = makeTagText({ tag: "v1.2.0", armor: signPayload(makeTagText({ tag: "v9.9.9" }), signer) });
  const { flow } = makeUpdate({
    runGit: async (args) => args.includes("cat-file") ? { stdout: badTag } : { stdout: "" }
  });
  let threw = null;
  try { await flow.run(); } catch (error) { threw = error.message; }
  check("验签失败拒更新", threw, "no maintainer-signed release tag found; refusing unanchored self-update");
}

{
  // 未签名高版本 tag 不挡住低版本已签名 tag（修正①回归）
  const { flow, setOwnVersion } = makeUpdate({
    listTagRefs: async () => [
      { name: "v9.9.9", sha: "c".repeat(40), type: "tag" },
      { name: "v1.2.0", sha: TAG_SHA, type: "tag" }
    ],
    runGit: async (args) => {
      if (args.includes("cat-file")) {
        const t = args[args.length - 1];
        return { stdout: t === "v9.9.9" ? makeTagText({ tag: "v9.9.9" }) : tagFor(t) };
      }
      if (args.includes("rev-parse")) return { stdout: COMMIT };
      return { stdout: "" };
    },
    fetchVersionAtRef: async (ref) => ref === "v1.2.0" ? "1.2.0" : null,
    rename: async (from, to) => { if (to === DEST) setOwnVersion("1.2.0"); }
  });
  const result = await flow.run();
  check("高版本未签名不挡已签名", result, { status: "done", installedVersion: "1.2.0" });
}

{
  // lightweight tag（type=commit）与 prerelease 默认跳过
  const { flow } = makeUpdate({
    listTagRefs: async () => [
      { name: "v9.0.0", sha: "d".repeat(40), type: "commit" },
      { name: "v8.0.0-rc.1", sha: "e".repeat(40), type: "tag" }
    ]
  });
  let threw = null;
  try { await flow.run(); } catch (error) { threw = error.message; }
  check("lightweight+prerelease 均跳过", threw, "no maintainer-signed release tag found; refusing unanchored self-update");
}

{
  // 空白名单 → fail-closed
  const { flow } = makeUpdate({ allowedSigners: [] });
  let threw = null;
  try { await flow.run(); } catch (error) { threw = error.message; }
  check("空白名单拒绝自更新", threw, "self-update disabled: no release signing keys configured");
}

{
  // tag↔version 绑定：签名合法但 package.json version 不符 → 拒
  const { flow } = makeUpdate({ fetchVersionAtRef: async () => "9.9.9" });
  let threw = null;
  try { await flow.run(); } catch (error) { threw = error.message; }
  check("tag 与 version 不符拒更新", threw, "no maintainer-signed release tag found; refusing unanchored self-update");
}

{
  const { flow } = makeUpdate();
  flow.closeState({ status: "done", installedVersion: "1.2.0" });
  check("closeState 闭合状态机", flow.getState(), {
    installedVersion: "1.2.0", latestVersion: "1.2.0", updateAvailable: false, checkedAt: 1000, error: null
  });
}

{
  const { flow } = makeUpdate();
  flow.closeState({ status: "done", installedVersion: "1.2.0", latestVersion: "1.3.0" });
  check("closeState 优先用 result.latestVersion", flow.getState().latestVersion, "1.3.0");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
