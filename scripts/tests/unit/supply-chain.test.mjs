// 供应链治理契约测试：验证 provenance 脚本输出形态与 CI 供应链步骤。
// 覆盖：provenance 含 git revision 与关键文件哈希、不写仓库、不覆盖 drift-report；
// CI 对 browser lockfile 执行高严重度 npm audit 并生成 SBOM，且不引入外部工具。

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const provenanceSource = readFileSync(join(ROOT, "scripts", "provenance.mjs"), "utf8");
const workflowPath = join(ROOT, ".github", "workflows", "quality.yml");
const workflow = existsSync(workflowPath) ? readFileSync(workflowPath, "utf8") : "";

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

// provenance 输出契约
check("provenance 含 git revision", /git_revision/.test(provenanceSource), true);
check("provenance 含关键文件哈希", /lib\/index\.js/.test(provenanceSource) && /registry\.json\.gz/.test(provenanceSource) && /skills\.json\.gz/.test(provenanceSource), true);
check("provenance 含 browser lockfile 哈希", /scripts\/tests\/browser\/package-lock\.json/.test(provenanceSource), true);
check("provenance 使用 SHA-256", /createHash\("sha256"\)/.test(provenanceSource), true);
check("provenance 不写仓库（仅 --json 显式写）", /jsonOut/.test(provenanceSource) && !/writeFileSync\(join\(ROOT, "provenance/.test(provenanceSource), true);
check("provenance 不覆盖 drift-report", !/writeFileSync\([^)]*drift-report/.test(provenanceSource), true);
check("provenance 不引入外部工具", !/(docker|trivy|osv|syft|grype)/i.test(provenanceSource), true);

// CI 供应链步骤
check("CI 对 browser lockfile 执行高严重度 npm audit", /npm audit --audit-level=high/.test(workflow), true);
check("CI 生成 browser SBOM", /npm sbom --sbom-format=cyclonedx/.test(workflow), true);
check("CI 生成 provenance 并上传", /scripts\/provenance\.mjs --json=provenance\.json/.test(workflow) && /supply-chain/.test(workflow), true);
check("CI 供应链步骤不引入外部工具", !/(docker|trivy|osv|syft|grype)/i.test(workflow), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
