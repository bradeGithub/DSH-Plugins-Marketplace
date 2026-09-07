import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run as validateCategories } from "../../registry/validate-categories.mjs";
import { run as refreshSnapshots } from "../../registry/refresh-audit-snapshots.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const temp = mkdtempSync(join(tmpdir(), "dsh-registry-entrypoints-"));
const expectedFile = join(temp, "audit-expected.json");
const registryFile = join(temp, "registry.json");
const audit = { "a/b": "other" };
const registry = {
  repos: [{
    full_name: "a/b",
    name: "b",
    description: "",
    topics: [],
    stargazers_count: 0,
    html_url: "https://github.com/a/b",
    updated_at: "2026-01-01"
  }]
};
writeFileSync(expectedFile, JSON.stringify(audit), "utf8");
writeFileSync(registryFile, JSON.stringify(registry), "utf8");

const logs = [];
assert.equal(validateCategories({ expectedFile, registryFile, log: (line) => logs.push(line) }), 0);
assert.match(logs[0], /^准确率: 1\/1 = 100\.0%$/);
assert.equal(logs.some((line) => line.includes("错分明细")), true);

refreshSnapshots({ auditFile: expectedFile, registryFile, log: () => {} });
const refreshed = JSON.parse(readFileSync(expectedFile, "utf8"));
assert.deepEqual(refreshed, {
  "a/b": { expected: "other", desc: "", topics: [] }
});

const wrapperOutput = execFileSync(process.execPath, [
  join(ROOT, "scripts", "validate-categories.mjs"),
  expectedFile
], { cwd: temp, encoding: "utf8" });
assert.match(wrapperOutput, /^缺失: a\/b\r?\n准确率: 0\/1 = 0\.0%/);

console.log("registry entrypoint contract: 9 passed, 0 failed");
