// 发布 tag 签名硬门控测试：verify-tag.mjs CLI + check.mjs --stage=pre-push。
// fixture：临时 git 仓库 + ssh-keygen 真签名（工具缺失时整组 SKIP——CI 环境有 git/ssh-keygen）。
// 签名者注入走 DSH_RELEASE_SIGNERS_FILE（allowed_signers 格式文件），
// 生产信任根 lib/allowed-signers.js 不受影响。

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
let pass = 0, fail = 0, skip = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ---- fixture：真 git 仓库 + ssh-keygen 签名 ----
let fixture = null;
try {
  const dir = mkdtempSync(join(tmpdir(), "dsh-verifytag-")).replace(/\\/g, "/");
  const keyPath = join(dir, "release-key");
  execFileSync("ssh-keygen", ["-t", "ed25519", "-f", keyPath, "-N", "", "-q"]);
  const otherKeyPath = join(dir, "other-key");
  execFileSync("ssh-keygen", ["-t", "ed25519", "-f", otherKeyPath, "-N", "", "-q"]);
  const signersFile = join(dir, "allowed_signers");
  writeFileSync(signersFile, readFileSync(`${keyPath}.pub`, "utf8"));
  const git = (args) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "T"]);
  writeFileSync(join(dir, "f.txt"), "x");
  git(["add", "f.txt"]);
  git(["commit", "-qm", "c1"]);
  // 签名 tag（fixture key）
  git(["config", "gpg.format", "ssh"]);
  git(["config", "user.signingkey", `${keyPath}.pub`]);
  git(["tag", "-s", "-m", "signed release", "v9.9.9"]);
  // 未签名 annotated tag
  git(["tag", "-a", "-m", "unsigned release", "v9.9.8"]);
  // lightweight tag
  git(["tag", "v9.9.7"]);
  // 非 allowlisted key 签的 tag
  git(["-c", `user.signingkey=${otherKeyPath}.pub`, "tag", "-s", "-m", "foreign release", "v9.9.6"]);
  fixture = { dir, signersFile };
} catch (e) {
  console.log("SKIP verify-tag fixture 构建失败（需 git + ssh-keygen）:", e.message);
  skip++;
}

const verifyTag = (repo, signersFile, ...tags) => spawnSync(
  "node", [join(ROOT, "scripts", "verify-tag.mjs"), ...tags],
  { cwd: repo, env: { ...process.env, DSH_RELEASE_SIGNERS_FILE: signersFile }, encoding: "utf8" }
);
const prePush = (repo, signersFile, stdinText) => spawnSync(
  "node", [join(ROOT, "scripts", "hooks", "check.mjs"), "--stage=pre-push"],
  { cwd: repo, env: { ...process.env, DSH_RELEASE_SIGNERS_FILE: signersFile, CHECK_WORKTREE: repo }, input: stdinText, encoding: "utf8" }
);

if (fixture) {
  const { dir, signersFile } = fixture;

  // ---- verify-tag.mjs CLI ----
  check("verify-tag 已签名 tag → exit 0", verifyTag(dir, signersFile, "v9.9.9").status, 0);
  const unsigned = verifyTag(dir, signersFile, "v9.9.8");
  check("verify-tag 未签名 annotated tag → exit 1", unsigned.status, 1);
  check("verify-tag 未签名输出含 unsigned", /unsigned|签名/.test(unsigned.stdout + unsigned.stderr), true);
  check("verify-tag lightweight tag → exit 1", verifyTag(dir, signersFile, "v9.9.7").status, 1);
  check("verify-tag 非白名单 key → exit 1", verifyTag(dir, signersFile, "v9.9.6").status, 1);
  check("verify-tag 多 tag 混合（一坏即拒）", verifyTag(dir, signersFile, "v9.9.9", "v9.9.8").status, 1);
  check("verify-tag 不存在的 tag → exit 1", verifyTag(dir, signersFile, "v0.0.0").status, 1);

  // ---- check.mjs --stage=pre-push ----
  const pushRef = (name, sha = "a".repeat(40)) => `refs/tags/${name} ${sha} refs/tags/${name} ${"0".repeat(40)}\n`;
  check("pre-push 已签名 v* tag → exit 0", prePush(dir, signersFile, pushRef("v9.9.9")).status, 0);
  check("pre-push 未签名 v* tag → exit 1", prePush(dir, signersFile, pushRef("v9.9.8")).status, 1);
  check("pre-push lightweight v* tag → exit 1", prePush(dir, signersFile, pushRef("v9.9.7")).status, 1);
  check("pre-push 非白名单 v* tag → exit 1", prePush(dir, signersFile, pushRef("v9.9.6")).status, 1);
  check("pre-push v* tag 删除 → exit 1",
    prePush(dir, signersFile, `refs/tags/v9.9.9 ${"0".repeat(40)} refs/tags/v9.9.9 ${"a".repeat(40)}\n`).status, 1);
  check("pre-push 非 v* tag 不拦截", prePush(dir, signersFile, pushRef("nightly-2026")).status, 0);
  check("pre-push 分支推送不拦截",
    prePush(dir, signersFile, `refs/heads/x ${"a".repeat(40)} refs/heads/x ${"0".repeat(40)}\n`).status, 0);
  check("pre-push 空 stdin 放行", prePush(dir, signersFile, "").status, 0);

  rmSync(dir, { recursive: true, force: true });
}

if (skip > 0) console.log(`\n(${skip} 组因缺少 git/ssh-keygen 跳过)`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
