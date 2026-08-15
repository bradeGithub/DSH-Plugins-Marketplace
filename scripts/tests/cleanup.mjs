#!/usr/bin/env node
// 测试残留清理：删除 %TEMP% 下测试/验证产生的临时目录与文件（C 盘）。
// 只删模式明确匹配的条目，绝不触碰：
//   - dsh-spill-*/dsh-subprocess-*/dsh-acl-locks（DSH harness 运行期临时文件，可能正被使用）
//   - 裸 dsh-XXXXXXXX 目录（同上）
//   - npm/pnpm 缓存、真实 ~/.dsh profile
// 用法：node scripts/tests/cleanup.mjs [--dry-run]
// run.mjs 在每层测试结束后自动调用（失败不阻塞测试结果）。

import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dryRun = process.argv.includes("--dry-run");
const temp = tmpdir();

// 目录匹配：测试/验证 mkdtemp 前缀或后缀（后缀-verify 是「考考你」仓库克隆目录）
const DIR_PATTERNS = [
  (n) => n.startsWith("dsh-e2e-"),       // e2e mkdtemp（install.e2e.mjs）
  (n) => n.startsWith("dsh-libtest-"),   // 集成测试 mkdtemp（lib.test.mjs）
  (n) => n.endsWith("-verify"),          // 仓库验证克隆（archify/dshmarket/dshwebui/... -verify）
  (n) => n === "dsh-verify-home",        // 检测验证临时 DSH_HOME
  (n) => /^dsh-cli-iso\d*$/.test(n),     // install 脚本 iso 验证残留
  (n) => n === "archify-pkg-x",          // npm pack 解包目录
];
// 文件匹配：npm pack 产物
const FILE_PATTERNS = [
  (n) => /^tt-a1i-archify-dsh-.*\.tgz$/.test(n),
  (n) => n === "archify-pkg.tgz",
];
// 过期运行期残留：DSH harness 每次调用产生的 spill/subprocess 目录，
// 仅清 7 天前的（当时的会话早已结束；近 7 天的可能正被使用，保留）。
const STALE_DIR_PATTERNS = [
  (n) => n.startsWith("dsh-spill-"),
  (n) => n.startsWith("dsh-subprocess-"),
];
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

let removed = 0, skipped = 0;
try {
  const now = Date.now();
  for (const entry of readdirSync(temp)) {
    const full = join(temp, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    const isDir = stat.isDirectory();
    const match = isDir
      ? DIR_PATTERNS.some((p) => p(entry))
          || (STALE_DIR_PATTERNS.some((p) => p(entry)) && now - stat.mtimeMs > STALE_MS)
      : FILE_PATTERNS.some((p) => p(entry));
    if (!match) continue;
    if (dryRun) {
      console.log(`[dry-run] 将删除 ${isDir ? "目录" : "文件"}: ${full}`);
      skipped++;
      continue;
    }
    try {
      rmSync(full, { recursive: true, force: true });
      console.log(`[clean] 已删除 ${isDir ? "目录" : "文件"}: ${full}`);
      removed++;
    } catch (error) {
      console.error(`[clean] 删除失败（可能正被占用）: ${full} — ${error.message}`);
    }
  }
} catch (error) {
  console.error(`[clean] 扫描 ${temp} 失败: ${error.message}`);
  process.exit(1);
}

console.log(`清理完成: 删除 ${removed} 项${dryRun ? `（dry-run 预览 ${skipped} 项）` : ""} — ${temp}`);
process.exit(0);
