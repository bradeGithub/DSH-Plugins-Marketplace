import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createMarketplaceMetadataAdapter } from "../../../lib/infra/marketplace-metadata.js";

let passed = 0;
let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else {
    failed++;
    console.log(`FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

const root = await mkdtemp(join(tmpdir(), "dsh-marketplace-metadata-"));
try {
  const scopeDir = join(root, "node_modules", "@deepseek-ai");
  const cordisFile = join(scopeDir, "cordis", "index.js");
  const ownPackagePath = join(root, "package.json");
  await mkdir(dirname(cordisFile), { recursive: true });
  await mkdir(join(scopeDir, "dsh-web"), { recursive: true });
  await writeFile(join(scopeDir, "not-a-file"), "not a package\n", "utf8");
  await writeFile(cordisFile, "export {}\n", "utf8");
  await writeFile(ownPackagePath, JSON.stringify({
    repository: { url: "https://github.com/Owner/Marketplace.git" },
  }), "utf8");

  const adapter = createMarketplaceMetadataAdapter({
    fs: { readFile, readdir },
    path: { dirnamePath: dirname, joinPath: join },
    resolveCorePackage: () => cordisFile,
    ownPackagePath,
    officialFallback: ["@deepseek-ai/fallback"],
  });

  const official = await adapter.loadOfficialPackages();
  check("真实 scope 枚举补入官方包", official.has("@deepseek-ai/dsh-web"), true);
  check("真实 scope 非目录不补入", official.has("@deepseek-ai/not-a-file"), false);
  check("真实 fallback 保留并小写", official.has("@deepseek-ai/fallback"), true);
  check("真实 package repository 归一化", await adapter.loadOwnRepo(), "owner/marketplace");
  check("真实 profile 外目录未被读取", official.has("@deepseek-ai/cordis"), true);

  const failedResolve = createMarketplaceMetadataAdapter({
    fs: { readFile, readdir },
    path: { dirnamePath: dirname, joinPath: join },
    resolveCorePackage: () => { throw new Error("missing core"); },
    ownPackagePath: join(root, "missing-package.json"),
    officialFallback: ["@deepseek-ai/fallback"],
  });
  check("真实解析失败回退官方基线", [...await failedResolve.loadOfficialPackages()], ["@deepseek-ai/fallback"]);
  check("真实 package 缺失回退 null", await failedResolve.loadOwnRepo(), null);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
