import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL("../../..", import.meta.url)));
const workflowPath = join(ROOT, ".github", "workflows", "quality.yml");
const workflow = existsSync(workflowPath) ? readFileSync(workflowPath, "utf8") : "";

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

check("quality workflow 存在", workflow.length > 0, true);
check("quality workflow 只读 contents 权限", /permissions:\n  contents: read/.test(workflow), true);
check("quality workflow 不声明 contents write", /contents:\s*write/.test(workflow), false);
check("checkout 使用 immutable SHA", /actions\/checkout@[0-9a-f]{40}/.test(workflow), true);
check("setup-node 使用 immutable SHA", /actions\/setup-node@[0-9a-f]{40}/.test(workflow), true);
check("upload-artifact 使用 immutable SHA", /actions\/upload-artifact@[0-9a-f]{40}/.test(workflow), true);
check("CI bootstrap 固定 pnpm 版本", /pnpm@9\.15\.9/.test(workflow), true);
check("CI bootstrap 固定 DSH 版本", /@deepseek-ai\/dsh@0\.1\.2-rc\.1/.test(workflow), true);
check("CI 执行严格 Node E2E", /--only=e2e/.test(workflow) && /DSH_REQUIRE_E2E: "1"/.test(workflow), true);
check("CI 安装锁定 browser 依赖", /working-directory: scripts\/tests\/browser/.test(workflow) && /npm ci/.test(workflow), true);
check("CI 安装 Playwright Chromium", /playwright install --with-deps chromium/.test(workflow), true);
check("CI 执行 browser E2E", /scripts\/tests\/frontend-e2e\.mjs/.test(workflow), true);
check("CI 执行 coverage 与 mutation", /--only=coverage/.test(workflow) && /scripts\/mutation-test\.mjs/.test(workflow), true);
check("CI 执行性能基准并上传趋势", /scripts\/benchmarks\/marketplace\.mjs --json=benchmark-results\.json/.test(workflow) && /benchmark-trend/.test(workflow), true);
check("CI 上传 browser 诊断产物", /actions\/upload-artifact@[0-9a-f]{40}/.test(workflow) && /test-results/.test(workflow), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
