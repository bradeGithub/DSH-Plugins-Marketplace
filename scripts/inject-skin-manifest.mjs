#!/usr/bin/env node
// Skin Manifest 注入器（方案 1：生成器输出 → 静态进皮肤包 bundle）：
// 在皮肤包 bundle 末尾注入 `exports.manifest = <manifest>`（幂等——
// 已存在则整段替换，保持 bundle 其余内容不变）。
//
// 协议（spec §4）：皮肤 bundle 导出 { apply, manifest }——manifest 是 bundle 内
// 静态常量，校验器/注册流程无需执行 bundle 即可读。生成器（build-skin-manifest.mjs）
// 是 manifest 唯一权威源；本注入器把生成结果写进 bundle。
//
// 用法：node scripts/inject-skin-manifest.mjs <bundle.js> <manifest.json>

import { readFileSync, writeFileSync } from "node:fs";

const MARKER = "exports.manifest =";

/** 注入 manifest 到 bundle（幂等：已存在则替换整段）。返回是否变更。 */
export function injectManifestIntoBundle(bundleSrc, manifestJson) {
  const injection = `${MARKER} ${JSON.stringify(JSON.parse(manifestJson))};`;
  const idx = bundleSrc.indexOf(MARKER);
  if (idx !== -1) {
    // 替换旧 manifest 段（到下一个分号结束）
    const end = bundleSrc.indexOf(";", idx);
    if (end === -1) return null; // 结构异常，拒绝动
    return bundleSrc.slice(0, idx) + injection + bundleSrc.slice(end + 1);
  }
  // 在 apply 导出后插入
  const anchor = "exports.apply = apply;";
  const anchorIdx = bundleSrc.indexOf(anchor);
  if (anchorIdx === -1) return null; // 找不到锚点（bundle 结构异常）
  return bundleSrc.slice(0, anchorIdx + anchor.length) + "\n\t" + injection + bundleSrc.slice(anchorIdx + anchor.length);
}

/** 从 bundle 提取已注入的 manifest（无则 null）。 */
export function extractInjectedManifest(bundleSrc) {
  const idx = bundleSrc.indexOf(MARKER);
  if (idx === -1) return null;
  const start = bundleSrc.indexOf("{", idx);
  if (start === -1) return null;
  // 从 { 起做括号配平（manifest 无嵌套字符串花括号——JSON 值里不会出现裸 {）
  let depth = 0, i = start;
  for (; i < bundleSrc.length; i++) {
    const ch = bundleSrc[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return null;
  const jsonText = bundleSrc.slice(start, i + 1);
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href.replace(/^file:\/\/\//, "file:///")) {
  const [bundlePath, manifestPath] = process.argv.slice(2);
  if (!bundlePath || !manifestPath) {
    console.error("用法: node scripts/inject-skin-manifest.mjs <bundle.js> <manifest.json>");
    process.exit(2);
  }
  const bundleSrc = readFileSync(bundlePath, "utf8");
  const manifestJson = readFileSync(manifestPath, "utf8");
  const out = injectManifestIntoBundle(bundleSrc, manifestJson);
  if (out === null) {
    console.error("[FAIL] bundle 结构异常（找不到锚点）");
    process.exit(1);
  }
  writeFileSync(bundlePath, out);
  const extracted = extractInjectedManifest(out);
  console.log(extracted ? `[OK] 已注入 ${extracted.id}（${extracted.name}）` : "[warn] 注入后回读失败");
}
