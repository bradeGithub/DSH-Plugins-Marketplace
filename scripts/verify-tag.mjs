#!/usr/bin/env node
// 发布 tag 签名验证（硬门控共用件）：pre-push hook 与 tag-verify CI 都走本脚本。
// 用法: node scripts/verify-tag.mjs <tag> [<tag>...]
//   对当前工作目录所在 git 仓库执行 `git cat-file tag <name>` 取对象原文，
//   用 lib/domain/sshsig.js 纯函数验证（namespace=git / sha512 / ssh-ed25519）。
// 信任根 = lib/allowed-signers.js 编译期常量（含 REVOKED_KEYS 吊销集）；
// 测试可用 DSH_RELEASE_SIGNERS_FILE 注入 fixture allowed_signers 文件（每行一把公钥）。
// 退出码：全部通过 0；任一失败 1（输出逐 tag 明细）。

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSignedTag, verifySshSig } from "../lib/domain/sshsig.js";
import { ALLOWED_SIGNERS, REVOKED_KEYS } from "../lib/allowed-signers.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadSigners() {
  const file = process.env.DSH_RELEASE_SIGNERS_FILE;
  if (!file) return ALLOWED_SIGNERS;
  return readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
}

const tags = process.argv.slice(2).filter(Boolean);
if (tags.length === 0) {
  console.error("usage: node scripts/verify-tag.mjs <tag> [<tag>...]");
  process.exit(2);
}

const signers = loadSigners();
if (signers.length === 0) {
  console.error("[FAIL] 信任根为空：lib/allowed-signers.js 未配置任何 release 公钥");
  process.exit(1);
}

let failed = 0;
for (const tag of tags) {
  let text;
  try {
    text = execFileSync("git", ["cat-file", "tag", tag], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    console.error(`[FAIL] ${tag}: 非 annotated tag（或对象不存在）——发布 tag 必须 git tag -s 签名`);
    failed++;
    continue;
  }
  const parsed = parseSignedTag(text);
  if (!parsed.ok) {
    console.error(`[FAIL] ${tag}: ${parsed.error}`);
    failed++;
    continue;
  }
  if (parsed.objectType !== "commit") {
    console.error(`[FAIL] ${tag}: tag 对象 type=${parsed.objectType}，仅接受 commit`);
    failed++;
    continue;
  }
  const verdict = verifySshSig({ payload: parsed.payload, armor: parsed.armor, allowedSigners: signers, revokedKeys: REVOKED_KEYS });
  if (!verdict.ok) {
    console.error(`[FAIL] ${tag}: ${verdict.error}`);
    failed++;
    continue;
  }
  console.log(`[OK] ${tag}: 签名有效（${verdict.signedBy} → ${parsed.objectSha.slice(0, 12)}）`);
}
process.exit(failed === 0 ? 0 : 1);
