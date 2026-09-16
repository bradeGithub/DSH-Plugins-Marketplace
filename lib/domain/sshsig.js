// SSHSIG（PROTOCOL.sshsig）签名 tag 的纯函数解析与验证。
// 只依赖 node:crypto；不做任何 IO/网络——payload 字节由调用方（本地 git 对象）提供，
// 信任根（allowedSigners / revokedKeys）由调用方注入，本模块不读任何文件或远端内容。

import { createHash, createPublicKey, verify } from "node:crypto";

const MAGIC = Buffer.from("SSHSIG"); // 6 字节裸 magic（非 SSH string）
const ARMOR_BEGIN = "-----BEGIN SSH SIGNATURE-----";
const ARMOR_END = "-----END SSH SIGNATURE-----";

// ed25519 SPKI DER 前缀（RFC 8410）：SEQUENCE{SEQUENCE{OID 1.3.101.112}, BITSTRING}
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function readU32(buf, off) {
  if (off + 4 > buf.length) throw new Error("sshsig: truncated u32");
  return [buf.readUInt32BE(off), off + 4];
}

function readString(buf, off) {
  const [len, start] = readU32(buf, off);
  if (start + len > buf.length) throw new Error("sshsig: truncated string");
  return [buf.subarray(start, start + len), start + len];
}

function sshString(bytes) {
  const out = Buffer.alloc(4 + bytes.length);
  out.writeUInt32BE(bytes.length, 0);
  bytes.copy(out, 4);
  return out;
}

/** 解析 allowed_signers 行 `<keytype> <base64-blob> [comment]` → 公钥条目。 */
function parseSignerLine(line) {
  const parts = String(line ?? "").trim().split(/\s+/);
  if (parts.length < 2 || parts[0] !== "ssh-ed25519") return null;
  let blob;
  try {
    blob = Buffer.from(parts[1], "base64");
  } catch {
    return null;
  }
  // blob 为 SSH wire：string("ssh-ed25519") || string(32B raw key)
  try {
    const [ktype, off] = readString(blob, 0);
    const [rawKey, end] = readString(blob, off);
    if (end !== blob.length || ktype.toString("utf8") !== "ssh-ed25519" || rawKey.length !== 32) return null;
    return { blob, rawKey, principal: parts.slice(2).join(" ") || "release" };
  } catch {
    return null;
  }
}

/**
 * 解析 git tag 对象原文。
 * → { ok:true, tagName, objectSha, objectType, payload, armor } | { ok:false, error }
 * payload = 去掉 armor 签名块的对象原文（保持 git 写入时的原始字节与换行）。
 */
export function parseSignedTag(text) {
  if (typeof text !== "string" || text.length === 0) return { ok: false, error: "empty tag object" };
  const headerEnd = text.indexOf("\n\n");
  if (headerEnd === -1) return { ok: false, error: "tag object missing header/body boundary" };
  const headers = {};
  for (const line of text.slice(0, headerEnd).split("\n")) {
    const sp = line.indexOf(" ");
    if (sp > 0) headers[line.slice(0, sp)] = line.slice(sp + 1);
  }
  const partial = { objectSha: headers.object, tagName: headers.tag, objectType: headers.type };
  if (!/^[0-9a-f]{40}$/.test(headers.object ?? "")) return { ok: false, error: "tag object missing/invalid object sha", ...partial };
  if (typeof headers.tag !== "string" || headers.tag.length === 0) return { ok: false, error: "tag object missing tag name", ...partial };
  if (typeof headers.type !== "string") return { ok: false, error: "tag object missing type", ...partial };
  const begin = text.indexOf(ARMOR_BEGIN);
  // 未签名也带回已解析字段，供 ALLOW_UNSIGNED 逃生口继续使用（绑定断言仍执行）
  if (begin === -1) return { ok: false, error: "tag object unsigned (no SSH signature block)", ...partial, payload: text };
  const endIdx = text.indexOf(ARMOR_END, begin);
  if (endIdx === -1) return { ok: false, error: "unterminated SSH signature block" };
  const armor = text.slice(begin, endIdx + ARMOR_END.length);
  const payload = text.slice(0, begin);
  return {
    ok: true,
    tagName: headers.tag,
    objectSha: headers.object,
    objectType: headers.type,
    payload,
    armor
  };
}

/**
 * 验证 SSHSIG v1 签名。
 * → { ok:true, signedBy } | { ok:false, error }
 * 内嵌公钥仅用于「选」白名单条目；实际验签用白名单 key。约束：namespace=git、
 * hashalg=sha512、ktype=ssh-ed25519；key 命中 revokedKeys 即拒。
 */
export function verifySshSig({ payload, armor, allowedSigners, revokedKeys = [] }) {
  try {
    const b64 = String(armor ?? "")
      .split("\n")
      .filter((l) => l !== ARMOR_BEGIN && l !== ARMOR_END && l.trim() !== "")
      .join("");
    const wire = Buffer.from(b64, "base64");
    if (wire.subarray(0, 6).toString("utf8") !== "SSHSIG") return { ok: false, error: "bad SSHSIG magic" };
    let off = 6;
    const [version, o1] = readU32(wire, off); off = o1;
    if (version !== 1) return { ok: false, error: `unsupported SSHSIG version ${version}` };
    const [pubkey, o2] = readString(wire, off); off = o2;
    const [ns, o3] = readString(wire, off); off = o3;
    const [reserved, o4] = readString(wire, off); off = o4;
    const [hashalg, o5] = readString(wire, off); off = o5;
    const [sigField, o6] = readString(wire, off); off = o6;
    if (off !== wire.length) return { ok: false, error: "trailing bytes in SSHSIG blob" };
    if (ns.toString("utf8") !== "git") return { ok: false, error: `unexpected namespace ${JSON.stringify(ns.toString("utf8"))}` };
    if (hashalg.toString("utf8") !== "sha512") return { ok: false, error: `unsupported hashalg ${hashalg.toString("utf8")}` };

    const [ktype, s1] = readString(sigField, 0);
    const [sigBytes, s2] = readString(sigField, s1);
    if (s2 !== sigField.length || ktype.toString("utf8") !== "ssh-ed25519" || sigBytes.length !== 64) {
      return { ok: false, error: "unsupported inner signature type" };
    }

    const revoked = new Set(revokedKeys);
    const candidates = (allowedSigners ?? []).map(parseSignerLine).filter(Boolean);
    const signer = candidates.find((c) => c.blob.equals(pubkey));
    if (!signer) return { ok: false, error: "signer key not in allowed signers" };
    if (revoked.has(signer.blob.toString("base64"))) return { ok: false, error: "signer key revoked" };

    const signedMessage = Buffer.concat([
      MAGIC,
      sshString(ns),
      sshString(reserved),
      sshString(hashalg),
      sshString(createHash("sha512").update(Buffer.from(payload, "utf8")).digest())
    ]);
    const keyObj = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, signer.rawKey]),
      format: "der",
      type: "spki"
    });
    if (!verify(null, signedMessage, keyObj, sigBytes)) return { ok: false, error: "signature verification failed" };
    return { ok: true, signedBy: signer.principal };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
