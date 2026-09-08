// 状态文件 IO 抽象（分层重构：infra 层，封装文件系统读写边界）。
// readStateJson — installed.json / feedback.json / envs.json 共用的损坏容错读取。

import { readFile, writeFile } from "node:fs/promises";

/**
 * 读取并解析本地 JSON 状态文件：
 * - 文件不存在（ENOENT）→ 返回 null（首次运行，正常）
 * - JSON 损坏 → WARN + 备份 .corrupt-<ts> 原文件（不覆盖、不删除）供人工恢复，返回 null
 *
 * 静默当空会让存量数据丢失且不可恢复：installed.json 误判未安装导致重复安装、
 * feedback.json 丢反馈队列与 GitHub token、envs.json 丢已保存键。
 */
async function readStateJson(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`[dsh-plugin-marketplace] ${file} 读取失败（按空处理）：${error?.message ?? error}`);
    }
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    console.warn(`[dsh-plugin-marketplace] ${file} 解析失败，已备份损坏文件（按空处理）：${error?.message ?? error}`);
    const backup = `${file}.corrupt-${Date.now()}`;
    await writeFile(backup, text, "utf8").catch((e) =>
      console.warn(`[dsh-plugin-marketplace] 备份损坏的 ${file} 失败：${e?.message ?? e}`)
    );
    return null;
  }
}

export { readStateJson };
