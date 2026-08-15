// validate-manifest CLI 模块测试（CLI 入口 isMain 分支豁免，同 toc 模式）。
// fixtures 供 CLI 手动使用 + 测试复用（单一来源）。

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateManifestFile } from "../../validate-manifest.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

const good = validateManifestFile(join(FIXTURES, "qq98.manifest.json"));
check("qq98 fixture ok", good.ok, true);
check("qq98 fixture 无 errors", good.errors.length, 0);
// 渐变组件（titlebar/sidebar-header）无法解析 → 2 个跳过 warn
check("qq98 fixture 渐变跳过 warn", good.warnings.length, 2);

const bad = validateManifestFile(join(FIXTURES, "bad.manifest.json"));
check("bad fixture fail", bad.ok, false);
check("bad fixture 缺 token", bad.errors.some((e) => e.includes("label-tertiary")), true);
check("bad fixture 组件选择器混入", bad.errors.some((e) => e.includes("选择器")), true);
check("bad fixture 声明 modes 缺 dark 组", bad.errors.some((e) => e.includes("缺 dark 组")), true);
check("bad fixture target 缺 var", bad.errors.some((e) => e.includes("var")), true);
check("bad fixture 对比度不达标 warn", bad.warnings.some((w) => w.includes("对比度")), true);
check("bad fixture 未知字段 warn", bad.warnings.some((w) => w.includes("unknownField")), true);
check("bad fixture 目录外 token 无（bad 未用目录外键）", bad.warnings.some((w) => w.includes("目录外")), false);

// 文件不存在 / 非法 JSON
const missing = validateManifestFile(join(FIXTURES, "nope.json"));
check("文件不存在 fail", missing.ok, false);
check("文件不存在错误信息", missing.errors.some((e) => e.includes("无法读取")), true);

// 非法 JSON fixture（临时写文件）
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
const tmp = mkdtempSync(join(tmpdir(), "dsh-manifest-"));
const badJson = join(tmp, "bad.json");
writeFileSync(badJson, "{ not json");
const r = validateManifestFile(badJson);
check("非法 JSON fail", r.ok, false);
check("非法 JSON 错误信息", r.errors.some((e) => e.includes("JSON 解析失败")), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
