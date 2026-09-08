#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyRepo, categoryText } from "../build-registry.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function run({
  expectedFile = join(ROOT, "audit-expected.json"),
  registryFile = join(ROOT, "registry.json"),
  debug = process.env.DEBUG,
  log = console.log,
} = {}) {
  const expected = JSON.parse(readFileSync(expectedFile, "utf8"));
  const registry = JSON.parse(readFileSync(registryFile, "utf8")).repos;
  const byName = new Map(registry.map((r) => [r.full_name, r]));

  let correct = 0;
  const mismatches = [];
  for (const [full, want] of Object.entries(expected)) {
    const repo = byName.get(full);
    if (!repo) {
      log(`缺失: ${full}`);
      continue;
    }
    const got = classifyRepo(repo);
    if (got === want) correct++;
    else mismatches.push({ full, got, want, desc: String(repo.description ?? "").slice(0, 50) });
  }
  const total = Object.keys(expected).length;
  log(`准确率: ${correct}/${total} = ${(correct / total * 100).toFixed(1)}%`);
  log("\n错分明细:");
  for (const mismatch of mismatches) {
    const repo = byName.get(mismatch.full);
    log(`  ${mismatch.full}: 实际=${mismatch.got} 期望=${mismatch.want}`);
    if (debug) log(`    文本: ${categoryText(repo).slice(0, 400)}`);
  }
  return mismatches.length > 0 ? 1 : 0;
}

export function main(argv = process.argv.slice(2)) {
  const expectedFile = argv[0] ? resolve(process.cwd(), argv[0]) : join(ROOT, "audit-expected.json");
  return run({ expectedFile });
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) process.exitCode = main();
