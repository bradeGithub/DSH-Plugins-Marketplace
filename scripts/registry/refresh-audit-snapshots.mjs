#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function run({
  auditFile = join(ROOT, "audit-expected.json"),
  registryFile = join(ROOT, "registry.json"),
  log = console.log,
} = {}) {
  const audit = JSON.parse(readFileSync(auditFile, "utf8"));
  const registry = JSON.parse(readFileSync(registryFile, "utf8"));
  const byName = new Map(registry.repos.map((r) => [r.full_name, r]));

  const out = {};
  let withSnapshot = 0;
  let without = 0;
  for (const [fullName, entry] of Object.entries(audit)) {
    const expected = typeof entry === "string" ? entry : entry.expected;
    const repo = byName.get(fullName);
    if (repo && repo.description != null && Array.isArray(repo.topics)) {
      out[fullName] = { expected, desc: repo.description, topics: [...repo.topics].sort() };
      withSnapshot++;
    } else {
      out[fullName] = { expected };
      without++;
    }
  }

  writeFileSync(auditFile, JSON.stringify(out, null, 2) + "\n", "utf8");
  log(`快照已刷新：${withSnapshot} 条带快照，${without} 条无快照（不在当前索引 / desc 为 null）`);
  return 0;
}

export function main() {
  return run();
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) process.exitCode = main();
