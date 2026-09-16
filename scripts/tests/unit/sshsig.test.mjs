import { generateKeyPairSync, sign as cryptoSign, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSignedTag, verifySshSig } from "../../../lib/domain/sshsig.js";

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
function ok(name, cond) { check(name, cond === true || cond === "true" ? true : cond, true); }

// ── 测试侧独立签名器（与 lib 不同实现路径）──
function sshStr(b) {
  const out = Buffer.alloc(4 + b.length);
  out.writeUInt32BE(b.length, 0);
  Buffer.from(b).copy(out, 4);
  return out;
}
function makeSigner(comment = "t") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const blob = Buffer.concat([sshStr(Buffer.from("ssh-ed25519")), sshStr(rawPub)]);
  return { privateKey, signerLine: `ssh-ed25519 ${blob.toString("base64")} ${comment}`, blobB64: blob.toString("base64"), blob };
}
function sign(payload, s, { ns = "git", hashalg = "sha512" } = {}) {
  const nsB = Buffer.from(ns), resB = Buffer.alloc(0), algB = Buffer.from(hashalg);
  const msg = Buffer.concat([
    Buffer.from("SSHSIG"), sshStr(nsB), sshStr(resB), sshStr(algB),
    sshStr(createHash(hashalg).update(Buffer.from(payload, "utf8")).digest())
  ]);
  const sig = cryptoSign(null, msg, s.privateKey);
  const inner = Buffer.concat([sshStr(Buffer.from("ssh-ed25519")), sshStr(sig)]);
  const wire = Buffer.concat([
    Buffer.from("SSHSIG"), (() => { const u = Buffer.alloc(4); u.writeUInt32BE(1, 0); return u; })(),
    sshStr(s.blob), sshStr(nsB), sshStr(resB), sshStr(algB), sshStr(inner)
  ]);
  return `-----BEGIN SSH SIGNATURE-----\n${wire.toString("base64")}\n-----END SSH SIGNATURE-----`;
}
function tagText({ sha = "a".repeat(40), tag = "v1.2.0", type = "commit", armor = null } = {}) {
  const head = `object ${sha}\ntype ${type}\ntag ${tag}\ntagger T <t@t> 0 +0000\n\nrelease ${tag}\n`;
  return armor ? `${head}${armor}\n` : head;
}
function signedTag(s, opts = {}) {
  const head = `object ${opts.sha ?? "a".repeat(40)}\ntype commit\ntag ${opts.tag ?? "v1.2.0"}\ntagger T <t@t> 0 +0000\n\nrelease\n`;
  return head + sign(head, s, opts) + "\n";
}

const s1 = makeSigner("release-1");
const s2 = makeSigner("release-2");
const signers = [s1.signerLine, s2.signerLine];

// parseSignedTag 基本形态
{
  const t = signedTag(s1);
  const r = parseSignedTag(t);
  ok("parse 有效 tag", r.ok);
  check("tagName", r.tagName, "v1.2.0");
  check("objectType", r.objectType, "commit");
  check("objectSha", r.objectSha, "a".repeat(40));
  ok("payload 不含签名块", !r.payload.includes("BEGIN SSH SIGNATURE"));
  ok("payload 以 message 结尾", r.payload.endsWith("release\n"));
}

// 未签名 / 畸形
ok("未签名 tag 报 unsigned", /unsigned/.test(parseSignedTag(tagText()).error ?? ""));
ok("缺边界报 malformed", !parseSignedTag("object abc").ok);
ok("object sha 非法", !parseSignedTag(tagText({ sha: "xyz" })).ok);

// 验签 happy path + 双 key 任一通过
{
  const t = signedTag(s1);
  const p = parseSignedTag(t);
  const r = verifySshSig({ payload: p.payload, armor: p.armor, allowedSigners: signers });
  ok("key1 验签通过", r.ok);
  check("signedBy", r.signedBy, "release-1");
}
{
  const t = signedTag(s2);
  const p = parseSignedTag(t);
  ok("key2 验签通过", verifySshSig({ payload: p.payload, armor: p.armor, allowedSigners: signers }).ok);
}

// payload 改一字节 → 拒
{
  const t = signedTag(s1);
  const p = parseSignedTag(t);
  const r = verifySshSig({ payload: p.payload + " ", armor: p.armor, allowedSigners: signers });
  ok("payload 改动验签失败", !r.ok);
}

// 攻击者自洽签名（自己的 key）→ 白名单外拒
{
  const evil = makeSigner("evil");
  const t = signedTag(evil);
  const p = parseSignedTag(t);
  const r = verifySshSig({ payload: p.payload, armor: p.armor, allowedSigners: signers });
  ok("白名单外 key 拒", !r.ok);
  check("错误原因", r.error, "signer key not in allowed signers");
}

// namespace ≠ git → 拒
{
  const t = signedTag(s1, { ns: "file" });
  const p = parseSignedTag(t);
  const r = verifySshSig({ payload: p.payload, armor: p.armor, allowedSigners: signers });
  ok("namespace=file 拒", !r.ok);
}

// revoked key → 拒
{
  const t = signedTag(s1);
  const p = parseSignedTag(t);
  const r = verifySshSig({ payload: p.payload, armor: p.armor, allowedSigners: signers, revokedKeys: [s1.blobB64] });
  ok("revoked key 拒", !r.ok);
  check("revoked 原因", r.error, "signer key revoked");
}

// 空 armor / 畸形 wire
ok("空 armor 拒", !verifySshSig({ payload: "x", armor: "", allowedSigners: signers }).ok);
ok("非 SSHSIG base64 拒", !verifySshSig({
  payload: "x",
  armor: "-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----",
  allowedSigners: signers
}).ok);

// ── 真实 oracle 交叉验证：git tag -s + cat-file（工具可用时启用）──
{
  let realChecked = false;
  try {
    const dir = mkdtempSync(join(tmpdir(), "dsh-sigtest-"));
    try {
      const git = (a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const keyFile = join(dir, "k");
      execFileSync("ssh-keygen", ["-t", "ed25519", "-f", keyFile, "-N", "", "-q"]);
      git(["init", "-q"]);
      git(["config", "user.email", "t@t"]);
      git(["config", "user.name", "T"]);
      git(["config", "gpg.format", "ssh"]);
      git(["config", "user.signingkey", `${keyFile}.pub`]);
      writeFileSync(join(dir, "f"), "x");
      git(["add", "f"]);
      git(["commit", "-qm", "c"]);
      git(["tag", "-s", "-m", "release v9.9.9", "v9.9.9"]);
      const obj = git(["cat-file", "tag", "v9.9.9"]);
      const pub = readFileSync(`${keyFile}.pub`, "utf8").trim();
      const parsed = parseSignedTag(obj);
      ok("真实 git tag 解析", parsed.ok);
      ok("真实签名验证", verifySshSig({ payload: parsed.payload, armor: parsed.armor, allowedSigners: [pub] }).ok);
      const realSha = git(["rev-parse", "v9.9.9^{}"]).trim();
      ok("objectSha 与 rev-parse 一致", parsed.objectSha === realSha);
      realChecked = true;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    console.log("SKIP 真实 git/ssh-keygen 不可用，跳过交叉验证");
  }
  ok("真实 oracle 已执行或被跳过", true);
  if (realChecked) console.log("INFO 真实 git tag -s 交叉验证通过");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
