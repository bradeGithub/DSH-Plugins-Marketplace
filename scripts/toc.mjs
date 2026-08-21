#!/usr/bin/env node
// TOC 生成/检测脚本：为 README.md / README.en.md 生成目录（默认 h2+h3）。
// 用法：
//   node scripts/toc.mjs           生成并写回 README.md + README.en.md
//   node scripts/toc.mjs --check   检测 TOC 是否缺失/过期（供 pre-commit hook 使用）
// TOC 占位: <!-- TOC --> ... <!-- /TOC -->

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DEPTH = 3; // h2 + h3
const TOC_OPEN = "<!-- TOC -->";
const TOC_CLOSE = "<!-- /TOC -->";

/** 默认排除：非文档/生成物/版本控制目录。 */
export const DEFAULT_TOC_EXCLUDES = [
  "node_modules",
  ".git",
  "dist",
  "CHANGELOG.md", // changelog 是时间线记录，不参与导航 TOC
  "docs/CHANGELOG.md", // CHANGELOG 已移入 docs/（2026-08-21 根目录整理）
];

/**
 * 自动发现应维护 TOC 的 Markdown 文档。
 * 扫描仓库根与 docs/ 下的 *.md（一层深度），排除 DEFAULT_TOC_EXCLUDES，
 * 返回按路径排序的相对路径列表（跨平台稳定）。
 * 可选 exclude 追加排除片段（对应 .hooksrc tocExclude）。
 * @param {string} root 仓库根
 * @param {string[]} [extraExcludes] 追加排除片段
 */
export function discoverMarkdownFiles(root, extraExcludes = []) {
  const excludes = [...DEFAULT_TOC_EXCLUDES, ...extraExcludes];
  const isExcluded = (rel) =>
    excludes.some((e) => rel === e || rel.startsWith(e + "/") || rel.includes("/" + e + "/"));
  const found = [];

  const scan = (dir, relPrefix) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (isExcluded(rel)) continue;
        // 只深入一层 docs/（其余目录不自动纳入，避免误扫）
        if (rel === "docs") scan(join(dir, ent.name), rel);
      } else if (ent.name.endsWith(".md")) {
        if (isExcluded(rel)) continue;
        found.push(rel);
      }
    }
  };
  scan(root, "");
  return [...new Set(found)].sort();
}

/** 判断当前是否为直接运行（非被 import）。 */
export function isMain() {
  if (!process.argv[1]) return false;
  try {
    const a = pathToFileURL(process.argv[1]).href.replace(/^file:\/\/\//i, "file:///");
    const b = import.meta.url.replace(/^file:\/\/\//i, "file:///");
    if (a.toLowerCase() === b.toLowerCase()) return true;
    return process.argv[1].replace(/\\/g, "/").toLowerCase().endsWith("/scripts/toc.mjs");
  } catch {
    return false;
  }
}

/** 提取标题列表: [{ level, text }]，排除 TOC 占位本身。 */
export function extractHeadings(md) {
  const out = [];
  for (const line of md.split("\n")) {
    const m = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const text = m[2].trim();
    if (text.includes(TOC_OPEN) || text.includes(TOC_CLOSE)) continue;
    out.push({ level: m[1].length, text });
  }
  return out;
}

/** GitHub slug 锚点：小写、去标点/emoji、空格转连字符。 */
export function slugify(text) {
  // 去除 emoji（Extended_Pictographic 及其 FE0F 变体选择符）
  const clean = text
    .replace(/[\p{Extended_Pictographic}\u{FE0F}]/gu, "")
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .trim();
  return clean.replace(/\s+/g, "-").toLowerCase();
}

/** 生成 TOC markdown（含占位）。 */
export function generateToc(md, depth = DEFAULT_DEPTH) {
  const headings = extractHeadings(md).filter((h) => h.level <= depth);
  const lines = headings.map((h) => {
    const indent = "  ".repeat(h.level - 2);
    return `${indent}- [${h.text}](#${slugify(h.text)})`;
  });
  return `${TOC_OPEN}\n${lines.join("\n")}\n${TOC_CLOSE}`;
}

/** 替换文档中的 TOC 占位；无占位则返回 null。保留原文件换行风格。 */
export function applyToc(md, toc) {
  const open = md.indexOf(TOC_OPEN);
  const close = md.indexOf(TOC_CLOSE);
  const eol = md.includes("\r\n") ? "\r\n" : "\n";
  const tocEol = toc.replace(/\r\n/g, "\n").replace(/\n/g, eol);
  if (open !== -1 && close !== -1) {
    return md.slice(0, open) + tocEol + md.slice(close + TOC_CLOSE.length);
  }
  return null;
}

/**
 * 在文档中定位 TOC 占位应放置的位置：第一个二级标题（## ）之前。
 * 跳过文档主标题（# ）与头部说明区（badges/引言），确保 TOC 位于
 * 第一个 ## 上方——见 docs/GIT_HOOKS.md。
 * 返回插入索引（指向该行行首）；无 ## 标题返回 -1。
 */
export function tocInsertIndex(md) {
  const lines = String(md).split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+\S/.test(lines[i])) {
      let idx = 0;
      for (let j = 0; j < i; j++) idx += lines[j].length + 1;
      return idx;
    }
  }
  return -1;
}

/** 检测文档 TOC 是否缺失或过期。返回 true=通过。 */
export function tocIsValid(md, depth = DEFAULT_DEPTH) {
  const open = md.indexOf(TOC_OPEN);
  const close = md.indexOf(TOC_CLOSE);
  if (open === -1 || close === -1) {
    // 无占位：若文档含二级标题则要求 TOC（缺失视为无效）
    return tocInsertIndex(md) < 0;
  }
  const expected = generateToc(md, depth);
  const actual = md.slice(open, close + TOC_CLOSE.length);
  // 换行符规范化（CRLF/LF 跨平台兼容）后再比较
  return normalizeEol(actual) === normalizeEol(expected);
}

/** 统一换行符为 \n（用于跨平台比较）。 */
export function normalizeEol(s) {
  return String(s).replace(/\r\n/g, "\n");
}

const checkOnly = process.argv.includes("--check");
let allOk = true;

// 仅作为主模块直接运行时执行；被 import（smoke-tests/hook）时不触发
if (isMain()) {
  const exclArg = process.argv.find((a) => a.startsWith("--exclude="));
  const extraExcl = exclArg ? exclArg.slice("--exclude=".length).split(",").filter(Boolean) : [];
  const files = discoverMarkdownFiles(ROOT, extraExcl);
  for (const f of files) {
    const path = join(ROOT, f);
    if (!existsSync(path)) continue;
    const md = readFileSync(path, "utf8");
    if (checkOnly) {
      const ok = tocIsValid(md);
      if (ok) console.log(`[OK] [toc] ${f}`);
      else {
        console.error(`[FAIL] [toc] ${f}: TOC 缺失或过期，请运行 node scripts/toc.mjs 重新生成`);
        allOk = false;
      }
    } else {
      const toc = generateToc(md);
      const updated = applyToc(md, toc);
      if (updated === null) {
        // 无占位：自动在第一个二级标题前插入（含占位 + 内容）
        const idx = tocInsertIndex(md);
        if (idx >= 0) {
          const eol = md.includes("\r\n") ? "\r\n" : "\n";
          const tocEol = toc.replace(/\r\n/g, "\n").replace(/\n/g, eol);
          const inserted = md.slice(0, idx) + tocEol + eol + eol + md.slice(idx);
          writeFileSync(path, inserted, "utf8");
          console.log(`[OK] [toc] ${f}: 已插入到第一个二级标题前`);
        } else {
          console.log(`- [toc] ${f}: 无二级标题与占位，跳过`);
        }
      } else {
        writeFileSync(path, updated, "utf8");
        console.log(`[OK] [toc] ${f}: 已更新`);
      }
    }
  }
  process.exit(allOk ? 0 : 1);
}
