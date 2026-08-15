#!/usr/bin/env node
// Skin Manifest 校验 CLI（阶段 0 基座）——皮肤作者开发期校验工具。
//
// 用法：node scripts/validate-manifest.mjs <manifest.json>
// 退出码：0 = 通过（warnings 允许）；1 = 有 errors；2 = 用法错误。
// 规范：docs/skin-manifest-spec.md（工作区根）。
//
// CLI 入口（isMain 内）无法被测试触发，覆盖率豁免——与 toc.mjs 同模式。

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { validateSkinManifest } from "../lib/skin-manifest.js";

/** 读文件 + JSON 解析 + 校验。返回 { ok, errors, warnings }。 */
export function validateManifestFile(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (e) {
    return { ok: false, errors: [`无法读取文件: ${e.message}`], warnings: [] };
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (e) {
    return { ok: false, errors: [`JSON 解析失败: ${e.message}`], warnings: [] };
  }
  return validateSkinManifest(manifest);
}

function isMain(meta) {
  if (!process.argv[1]) return false;
  try {
    const a = pathToFileURL(process.argv[1]).href.replace(/^file:\/\/\//i, "file:///");
    const b = meta.url.replace(/^file:\/\/\//i, "file:///");
    if (a.toLowerCase() === b.toLowerCase()) return true;
  } catch {
    // argv[1] 不是路径（如测试 import 时）——非 CLI 运行
  }
  return false;
}

if (isMain(import.meta)) {
  const file = process.argv[2];
  if (!file) {
    console.error("用法: node scripts/validate-manifest.mjs <manifest.json>");
    process.exit(2);
  }
  const result = validateManifestFile(file);
  for (const e of result.errors) console.error(`[FAIL] ${e}`);
  for (const w of result.warnings) console.warn(`[warn] ${w}`);
  console.log(result.ok ? `OK（${result.warnings.length} warnings）` : `FAIL（${result.errors.length} errors）`);
  process.exit(result.ok ? 0 : 1);
}
