// infra/store.js 直接导入测试（分层重构契约：readStateJson）。
import { readStateJson } from "../../../lib/infra/store.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const DIR = mkdtempSync(join(tmpdir(), "dsh-store-"));

// 行为：正常 JSON 返回解析结果
const okFile = join(DIR, "ok.json");
writeFileSync(okFile, JSON.stringify({ a: 1 }), "utf8");
check("正常 JSON 解析", await readStateJson(okFile), { a: 1 });

// 行为：文件不存在返回 null（不抛错）
check("文件不存在返回 null", await readStateJson(join(DIR, "missing.json")), null);

// 行为：非 ENOENT 读取失败返回 null 且发出警告
const directoryPath = join(DIR, "directory-state");
mkdirSync(directoryPath);
let warningCount = 0;
const originalWarn = console.warn;
console.warn = () => { warningCount++; };
let directoryResult;
try {
  directoryResult = await readStateJson(directoryPath);
} finally {
  console.warn = originalWarn;
}
check("非 ENOENT 读取失败返回 null", directoryResult, null);
check("非 ENOENT 读取失败发出警告", warningCount > 0, true);

// 行为：JSON 损坏返回 null + 生成备份
const corruptFile = join(DIR, "corrupt.json");
writeFileSync(corruptFile, "{ bad json!", "utf8");
const corruptResult = await readStateJson(corruptFile);
check("损坏 JSON 返回 null", corruptResult, null);

// 行为：备份文件包含原始损坏内容
import { readdirSync, readFileSync } from "node:fs";
const backups = readdirSync(DIR).filter((f) => f.startsWith("corrupt.json.corrupt-"));
check("生成了备份文件", backups.length > 0, true);
if (backups.length > 0) {
  check("备份内容为原始损坏文本", readFileSync(join(DIR, backups[0]), "utf8"), "{ bad json!");
}

// 行为：空对象正常解析
const emptyObjFile = join(DIR, "empty-obj.json");
writeFileSync(emptyObjFile, "{}", "utf8");
check("空对象解析", await readStateJson(emptyObjFile), {});

// 行为：数组正常解析
const arrayFile = join(DIR, "array.json");
writeFileSync(arrayFile, "[1,2,3]", "utf8");
check("数组解析", await readStateJson(arrayFile), [1, 2, 3]);

// 行为：嵌套结构正常解析
const nestedFile = join(DIR, "nested.json");
writeFileSync(nestedFile, JSON.stringify({ pending: [{ repo: "a/b" }], token: "abc" }), "utf8");
check("嵌套结构解析", await readStateJson(nestedFile), { pending: [{ repo: "a/b" }], token: "abc" });

rmSync(DIR, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
