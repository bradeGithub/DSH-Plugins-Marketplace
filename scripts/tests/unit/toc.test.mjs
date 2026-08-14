import { extractHeadings, slugify, generateToc, applyToc, tocIsValid, normalizeEol, isMain, tocInsertIndex, discoverMarkdownFiles, DEFAULT_TOC_EXCLUDES } from "../../toc.mjs";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ---- TOC: extractHeadings ----
const TOC_MD = [
  "# Title",
  "",
  "## A 标题",
  "### A.1 子节",
  "#### A.1.1 太深",
  "## B 标题",
  "",
  "<!-- TOC -->",
  "<!-- /TOC -->",
].join("\n");
const hs = extractHeadings(TOC_MD);
check("extractHeadings 数 h2+h3", hs.length, 3);
check("extractHeadings level", hs[0].level, 2);
check("extractHeadings 排除 h4", hs.some((h) => h.level === 4), false);
check("extractHeadings 排除 TOC 占位", hs.some((h) => h.text.includes("TOC -->")), false);

// ---- TOC: slugify ----
check("slugify 英文", slugify("Quick install"), "quick-install");
check("slugify 中文去空格", slugify("一键安装（复制即用）"), "一键安装复制即用");
check("slugify 去 emoji", slugify("⚡ 一键安装"), "一键安装");
check("slugify 标点去除", slugify("A.B, C!"), "ab-c");
check("slugify 连字符保留", slugify("a-b c"), "a-b-c");

// ---- TOC: generateToc ----
const toc = generateToc(TOC_MD);
check("generateToc 含占位开始", toc.startsWith("<!-- TOC -->\n"), true);
check("generateToc 含链接", toc.includes("(#a-标题)"), true);
check("generateToc 子节缩进", toc.includes("  - [A.1 子节]"), true);
check("generateToc 排除 h4", toc.includes("a11"), false);

// ---- TOC: applyToc ----
const applied = applyToc(TOC_MD, toc);
check("applyToc 替换占位", applied.includes("- [A 标题](#a-标题)"), true);
check("applyToc 无占位返回 null", applyToc("# No toc", "<!-- TOC -->\nx\n<!-- /TOC -->"), null);
const crlfMd = "<!-- TOC -->\r\n<!-- /TOC -->\r\n## A 标题";
const crlfApplied = applyToc(crlfMd, "<!-- TOC -->\n- [A](#a)\n<!-- /TOC -->");
check("applyToc 保留 CRLF", crlfApplied.includes("<!-- TOC -->\r\n"), true);

// ---- TOC: tocIsValid ----
check("tocIsValid 正常通过", tocIsValid(applyToc(TOC_MD, toc)), true);
check("tocIsValid 无 h2 无占位 true(无需 TOC)", tocIsValid("# No placeholder"), true);
check("tocIsValid 无占位但有 h2 false", tocIsValid("# T\n\n## A 标题"), false);
check("tocIsValid 内容过期 false", tocIsValid("<!-- TOC -->\n- [旧](#旧)\n<!-- /TOC -->\n## 新 标题"), false);
check("tocIsValid CRLF 兼容", tocIsValid("<!-- TOC -->\r\n- [A 标题](#a-标题)\r\n<!-- /TOC -->\r\n## A 标题"), true);

// ---- TOC: tocInsertIndex ----
const idxMd = "# 主标题\n\n引言\n\n## 第一节\n内容\n## 第二节";
check("tocInsertIndex 定位第一个 h2 前", (() => {
  const idx = tocInsertIndex(idxMd);
  return idxMd.slice(idx, idx + 2) === "##";
})(), true);
check("tocInsertIndex 无 h2 返回 -1", tocInsertIndex("# 只有标题"), -1);
check("tocInsertIndex 空文档 -1", tocInsertIndex(""), -1);

// ---- TOC: discoverMarkdownFiles 自动扫描 ----
check("DEFAULT_TOC_EXCLUDES 含 CHANGELOG", DEFAULT_TOC_EXCLUDES.includes("CHANGELOG.md"), true);
// 用 fileURLToPath 取仓库根（跨平台：Windows 反斜杠 / Linux 正斜杠），
// 此前手写 pathname 替换会把 Linux 路径也转成反斜杠导致 CI 扫描失败。
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const mdFiles = discoverMarkdownFiles(REPO_ROOT);
check("自动发现含 README.md", mdFiles.includes("README.md"), true);
check("自动发现含 docs/DEVELOPMENT.md", mdFiles.includes("docs/DEVELOPMENT.md"), true);
check("排除 CHANGELOG.md", mdFiles.includes("CHANGELOG.md"), false);
check("排除 node_modules", mdFiles.some((f) => f.startsWith("node_modules/")), false);
check("路径排序稳定", JSON.stringify(mdFiles) === JSON.stringify([...mdFiles].sort()), true);
const excl = discoverMarkdownFiles(REPO_ROOT, ["docs/README.md"]);
check("extraExcludes 追加排除", excl.includes("docs/README.md"), false);

// ---- TOC: normalizeEol ----
check("normalizeEol CRLF→LF", normalizeEol("a\r\nb"), "a\nb");
check("normalizeEol LF 不变", normalizeEol("a\nb"), "a\nb");

// ---- TOC: isMain ----
check("isMain 无 argv1 false", (() => {
  const orig = process.argv[1];
  delete process.argv[1];
  const r = isMain();
  process.argv[1] = orig;
  return r;
})(), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
process.exit(fail === 0 ? 0 : 1);
