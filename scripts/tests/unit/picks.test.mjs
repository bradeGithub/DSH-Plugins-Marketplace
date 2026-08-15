// 社区精选链接提取回归测试：extractCommunityPickLinks 纯函数。
// 覆盖 markdown 链接 / 裸 URL / .git 后缀 / 尾部斜杠 / 子路径 / 去重 / 域名过滤 / 边界输入。
// 用法：node scripts/tests/unit/picks.test.mjs

import { extractCommunityPickLinks } from "../../build-registry.mjs";

let pass = 0;
let failed = 0;

function check(name, text, expected) {
  const got = [...extractCommunityPickLinks(text)].sort();
  const want = [...expected].sort();
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass++;
    console.log(`PASS ${name}: got [${got.join(", ")}]`);
  } else {
    failed++;
    console.error(`FAIL ${name}: got [${got.join(", ")}], want [${want.join(", ")}]`);
  }
}

// markdown 链接
check("markdown 链接", "[foo](https://github.com/owner/repo)", ["owner/repo"]);
// 裸 URL
check("裸 URL", "https://github.com/Owner/Repo 大小写归一", ["owner/repo"]);
// .git 后缀
check(".git 后缀", "https://github.com/owner/repo.git", ["owner/repo"]);
// 尾部斜杠
check("尾部斜杠", "https://github.com/owner/repo/", ["owner/repo"]);
// 子路径（tree/blob）只取前两段
check("子路径", "https://github.com/owner/repo/tree/main", ["owner/repo"]);
// 去重
check("去重", "https://github.com/a/b\nhttps://github.com/a/b", ["a/b"]);
// 同一仓库不同形态归一
check("形态归一", "[x](https://github.com/A/B) https://github.com/a/b.git", ["a/b"]);
// 非 github 域名忽略
check("非 github 域名", "https://gitlab.com/owner/repo", []);
// 多仓库提取
check("多仓库", "https://github.com/a/one\nhttps://github.com/b/two", ["a/one", "b/two"]);
// 空文本
check("空文本", "", []);
// 非字符串
check("非字符串", null, []);
check("非字符串 undefined", undefined, []);

if (failed > 0) {
  console.error(`\n社区精选提取: ${pass} 通过, ${failed} 失败`);
  process.exit(1);
}
console.log(`\nPASS 社区精选提取: ${pass}/${pass} 通过`);
