#!/usr/bin/env node
// 皮肤 palette 自动提取（阶段 1 迁移的自动化原料）：
// 从皮肤包 bundle 提取 body[data-dsh-xxx] 规则内的 --dsw-alias-* 变量覆盖
// （亮色组 = 无 dark-theme 限定的规则；暗色组 = [data-ds-dark-theme] 限定的规则）。
//
// 用法：node scripts/extract-skin-palette.mjs <skin-bundle.js>
// 输出：JSON { light: {token: value}, dark: {token: value} }（去重，暗色覆盖亮色同键时保留暗色组独立）
//
// 纯提取：不改 bundle、不执行 bundle（正则解析 CSS 文本）。

import { readFileSync } from "node:fs";

/** 提取 bundle 中指定 bodyAttr 前缀规则内的 --dsw-alias-* 变量。 */
export function extractSkinPalette(bundleSrc, bodyAttr) {
  const light = {};
  const dark = {};

  const collect = (ruleText, target) => {
    for (const m of ruleText.matchAll(/--dsw-alias-([\w-]+)\s*:\s*([^;}{]+)/g)) {
      target[m[1]] = m[2].trim();
    }
  };

  // 暗色组：body[data-dsh-xxx][data-ds-dark-theme]{...}（先匹配，避免被亮色正则吞掉）
  const darkRe = new RegExp(`body\\[data-dsh-${bodyAttr.replace(/^data-dsh-/, "")}\\]\\[data-ds-dark-theme\\]\\{[^}]*\\}`, "g");
  for (const m of bundleSrc.matchAll(darkRe)) collect(m[0], dark);

  // 亮暗共用组：body[data-dsh-xxx],body[data-dsh-xxx][data-ds-dark-theme]{...}
  // （harbor 形态：两个选择器共享同一组 token 值——暗色块被 darkRe 收集到暗色组，
  //   共用块整体同时归属亮色组与暗色组，值相同）
  const sharedRe = new RegExp(`body\\[data-dsh-${bodyAttr.replace(/^data-dsh-/, "")}\\],\\s*body\\[data-dsh-${bodyAttr.replace(/^data-dsh-/, "")}\\]\\[data-ds-dark-theme\\]\\{[^}]*\\}`, "g");
  for (const m of bundleSrc.matchAll(sharedRe)) {
    collect(m[0], light);
    collect(m[0], dark);
  }

  // 亮色组：body[data-dsh-xxx]{...}（排除已匹配的暗色块——正则不回溯，直接匹配无 dark-theme 的）
  const lightRe = new RegExp(`body\\[data-dsh-${bodyAttr.replace(/^data-dsh-/, "")}\\](?![^\\{]*dark-theme)\\{[^}]*\\}`, "g");
  for (const m of bundleSrc.matchAll(lightRe)) collect(m[0], light);

  return { light, dark };
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href.replace(/^file:\/\/\//, "file:///")) {
  const file = process.argv[2];
  const bodyAttr = process.argv[3] || "data-dsh-retro";
  if (!file) {
    console.error("用法: node scripts/extract-skin-palette.mjs <skin-bundle.js> [bodyAttr]");
    process.exit(2);
  }
  const src = readFileSync(file, "utf8");
  const result = extractSkinPalette(src, bodyAttr);
  console.log(JSON.stringify(result, null, 2));
}
