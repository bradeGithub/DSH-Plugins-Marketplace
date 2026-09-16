// 中英镜像文档一致性守卫：配对文档（中文源 ↔ .en 镜像）的二级节区数与
// 层级序列必须同构——防止「只改一边」造成的双语漂移。文本各自翻译不比对；
// 只断言结构骨架一致（一、二级标题计数与层级序列）。
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

function headingProfile(md) {
  return String(md).split("\n")
    .filter((l) => /^#{1,2}\s+\S/.test(l))
    .map((l) => (l.startsWith("## ") ? 2 : 1));
}

// 已存在的镜像对 + 约定：凡根/docs 下存在 <name>.en.md 的文件都必须与中文源同构
const PAIRS = [
  ["README.md", "README.en.md"],
  ["STANDARD.md", "STANDARD.en.md"],
];

for (const [zh, en] of PAIRS) {
  const zhPath = join(ROOT, zh);
  const enPath = join(ROOT, en);
  check(`${zh} 存在`, existsSync(zhPath), true);
  check(`${en} 存在`, existsSync(enPath), true);
  if (!existsSync(zhPath) || !existsSync(enPath)) continue;
  const zhProfile = headingProfile(readFileSync(zhPath, "utf8"));
  const enProfile = headingProfile(readFileSync(enPath, "utf8"));
  check(`${zh} ↔ ${en} 标题层级序列同构`, enProfile, zhProfile);
}

// 约定断言：新增镜像对必须登记进 PAIRS——发现未登记的 .en.md 即失败
const registered = new Set(PAIRS.map(([, en]) => en));
const stray = [];
for (const [dir, prefix] of [[ROOT, ""], [join(ROOT, "docs"), "docs/"]]) {
  for (const f of readdirSync(dir)) {
    if (/\.en\.md$/.test(f) && !registered.has(prefix + f)) stray.push(prefix + f);
  }
}
check("无未登记的双语镜像文件", stray, []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
