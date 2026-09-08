#!/usr/bin/env node
// 零依赖供应链 provenance：对关键生成物与源码计算 SHA-256，连同 git revision
// 与构建命令写入 JSON。不修改仓库、不覆盖 drift-report.json、不引入外部工具。
//
// 用法：
//   node scripts/provenance.mjs [--json=provenance.json]
// 默认把 JSON 打到 stdout；--json 额外写文件。

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(`--${name}=`.length) : fallback;
};
const jsonOut = arg("json", null);

function sha256(file) {
  const path = join(ROOT, file);
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function gitRevision() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const FILES = [
  "lib/index.js",
  "lib/client.js",
  "lib/http/marketplace-contract.js",
  "lib/app/diagnostics.js",
  "registry.json",
  "registry.json.gz",
  "skills.json",
  "skills.json.gz",
  "scripts/tests/browser/package-lock.json"
];

const report = {
  provenance: "dsh-plugin-marketplace",
  generated_at: new Date().toISOString(),
  git_revision: gitRevision(),
  node: process.version,
  files: Object.fromEntries(FILES.map((file) => [file, sha256(file)]))
};

const text = JSON.stringify(report, null, 2);
console.log(text);
if (jsonOut) writeFileSync(jsonOut, text + "\n", "utf8");
