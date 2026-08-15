// 每皮肤契约测试（数据驱动，阶段 1 测试规范化）：
// 遍历 scripts/tests/fixtures/<id>.manifest.json（生成器输出），断言：
//   1) 校验通过（generate 后自动覆盖新内容）
//   2) name 与皮肤中心 UI 显示名一致（基准 = 用户实测 UI 文本，见 UI_NAMES）
//   3) tagline 与 UI 一致
//   4) palette 模式声明合法 + 必选 token 双模式齐全（单模式皮肤除外）
// 新增皮肤 = fixtures 加文件 + UI_NAMES 加一行（数据驱动，测试代码不变）。

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSkinManifest } from "../../../lib/skin-manifest.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

/** 基准：皮肤中心 UI 实际显示（用户实测文本，2026-08-15）——name + tagline。 */
const UI_NAMES = {
  qq98: ["QQ2008 Retro", "水晶蓝桌面 · 玻璃深蓝标题栏 · 戴围巾企鹅"],
  ths: ["Tonghuashun Trading", "品牌红标题栏 · 实时行情状态栏 · 灰蓝数据终端"],
  xp: ["Windows XP Luna", "Luna 蓝窗口条 · 绿色开始按钮 · Bliss 蓝天桌面"],
  "blue-fantasy": ["Blue Fantasy", "鲸鱼插画背景 · periwinkle 靛蓝调色板 · 半透明面板"],
  "dragon-heir": ["Dragon Heir", "不屈龙魂 · 万里长城双主题 · 朱砂龙印"],
  minecraft: ["Minecraft Voxel", "动态全景天空盒 · 方块按钮 · 告示牌输入框"],
  "whale-song": ["Whale Song", "深海鲸语女神背景 · 冰蓝海洋调色板 · 金色细线点缀"],
  trading: ["Trading Terminal", "实时行情跑马灯 · 长桥港美股行情 · 红涨绿跌交易终端"],
  miku: ["Hatsune Miku", "蓝紫双马尾 · 01 编号 · 音符波形 · 电子歌姬主题"],
  harbor: ["Harbor", "暮光蓝港 · 日落橙辉 · 半透明夜色面板"],
};

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

// 收集 fixture（bad.manifest.json 除外——那是 CLI 测试的错误样例）
const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".manifest.json") && f !== "bad.manifest.json");
check("fixture 数量 = 10 皮肤", files.length, 10);

for (const file of files) {
  const id = file.replace(".manifest.json", "");
  const manifest = JSON.parse(readFileSync(join(FIXTURES, file), "utf8"));

  // 1) 校验通过（warn 允许——渐变组件/单模式是已知合理项）
  const result = validateSkinManifest(manifest);
  check(`${id} 校验通过`, result.ok, true);
  check(`${id} 无 errors`, result.errors.length, 0);

  // 2) name / 3) tagline 与 UI 基准一致
  const [uiName, uiTagline] = UI_NAMES[id];
  check(`${id} name = UI 显示名`, manifest.name, uiName);
  check(`${id} tagline = UI 原文`, manifest.tagline, uiTagline);

  // 4) palette 模式合法 + 必选 token 齐全
  check(`${id} palette.modes 数组`, Array.isArray(manifest.palette.modes), true);
  for (const mode of manifest.palette.modes) {
    check(`${id} palette.${mode} 存在`, manifest.palette[mode] != null, true);
  }
  // 元数据必填字段
  for (const f of ["id", "name", "author", "accent", "bodyAttr", "package"]) {
    check(`${id} 元数据字段 ${f}`, manifest[f] != null && manifest[f] !== "", true);
  }
  // wiringId（skin.json wiring.id 原文 + 交叉校验）
  check(`${id} wiringId 格式`, /^ui-skin-[a-z0-9-]+$/.test(manifest.wiringId), true);
  check(`${id} wiringId 与 id 对应`, manifest.wiringId, `ui-skin-${id}`);
  // description 必填（上游 skin.json 原文，生成器对齐）
  check(`${id} description 非空`, typeof manifest.description === "string" && manifest.description.length > 10, true);
  // tags 非空（上游全量对齐）
  check(`${id} tags 非空`, Array.isArray(manifest.tags) && manifest.tags.length > 0, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
