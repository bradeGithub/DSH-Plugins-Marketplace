# 安装反馈系统规范

> 本文固化安装反馈系统的模板结构、诊断字段、脱敏机制与隐私边界。
> 实现：`lib/index.js`（queueFeedback / buildFeedbackLogSnapshot / submitFeedbackToGitHub）+ `lib/redact.js`（脱敏模块）。

<!-- TOC -->
- [反馈链路](#反馈链路)
- [issue 模板结构](#issue-模板结构)
- [安装反馈 / Install Feedback](#安装反馈-install-feedback)
- [诊断字段字典](#诊断字段字典)
- [脱敏机制](#脱敏机制)
- [隐私边界](#隐私边界)
  - [密钥规则维护参考（官方文档站）](#密钥规则维护参考官方文档站)
- [维护者处理流程](#维护者处理流程)
<!-- /TOC -->

## 反馈链路

```
安装成功 → queueFeedback 入队（元数据 + 环境画像 + 日志快照，feedback.json 持久化）
  → 用户下次打开市场，客户端弹窗「插件是否正常」
    → 用户点「正常 / 不正常」（可附备注）
      → submitFeedbackToGitHub：
          有 token → 自动创建 issue（label: install-feedback；异常加 install-failed）
          无 token → 预填 issue 新建链接（手动提交；不带日志——URL 长度受限）
```

- 同 repo 只保留最新一条待反馈（重装覆盖旧条目）
- 反馈队列持久化失败不影响安装结果（queueFeedbackSafe 容错，日志提示）

## issue 模板结构

双语表格（中文 / English 并列，不做语言分支）：

```markdown
<!-- dsh-plugin-marketplace auto-feedback -->

## 安装反馈 / Install Feedback

| | |
|---|---|
| 插件 / Plugin | name |
| 仓库 / Repo | owner/repo |
| 类型 / Type | cordis-plugin |
| 版本 / Version | 1.2.3 |
| 安装方式 / Method | market-direct |
| 重装 / Reinstall | yes（仅重装时出现）|
| 时间 / Time | 2026-08-21 03:12 UTC |
| 结果 / Result | 异常 / Broken |

**环境 / Environment**: win32 · Node 22 · DSH 0.1.0-rc.8 · 市场 / Marketplace v1.5.5 · pnpm 9.15 · git 2.45

**用户描述 / User notes**
> (用户备注原文)

<details><summary>安装日志（尾部 40 行，已脱敏）/ Install log (sanitized)</summary>
...（仅异常反馈附带）
</details>
```

要点：
- 首行 HTML 注释是自动化锚点（可脚本批量统计/关闭正常项）
- **正常反馈零日志**——90% 反馈是正常，噪音源头掐掉；异常才带 details 折叠日志
- details 折叠让 issue 流里异常反馈也只占 1 行摘要

## 诊断字段字典

| 字段 | 来源 | 诊断价值 |
|---|---|---|
| type | detectType 判定 | 安装形态（cordis-plugin/skill/bundle/cli…）|
| version | 安装结果 | 插件版本 |
| method | 安装流状态 | market-direct / cli / cli-npm-fallback——cli 型失败第一排查点 |
| reinstall | installed.json 旧记录 | 「更新后坏」（重装场景）关键信号 |
| envProfile.platform/node | process | 运行环境 |
| envProfile.dsh | profile node_modules 的 @deepseek-ai/dsh 版本 | rc.7/rc.8 行为分叉点 |
| envProfile.pnpm / git | 安装期 spawn --version 探测（进程内缓存一次）| cli/bundle 失败头号嫌疑 |
| logSnapshot | 安装日志锚点行（类型判定）+ 尾 40 行，≤2000 字符 | pnpm 报错/clone 失败/类型误判 |
| 用户备注 | 客户端弹窗输入 | 用户主观描述 |

## 脱敏机制

日志快照在入队时经**两套规则串行**（`redactLog` + `sanitizeLog` 双保险）：

1. **注入净化**：CR/LF 统一、控制字符剔除、markdown 围栏 ``` → ''' （防击穿 details 折叠块）
2. **已知密钥掩码**：云厂商（AWS 含临时凭证 ASIA 系、阿里云 LTAI、腾讯云 AKID、百度 bce-auth-v1）、sk 系（OpenAI/Anthropic）、GitHub（ghp_/PAT）、GitLab、Slack、npm、HuggingFace、Google（AIza/GOCSPX-）、LLM 聚合商（Groq/xAI/Perplexity/Fireworks/Cerebras，前缀取 secret-scanner 社区共识——官方不披露格式）、Cloudflare（cfut_/cfat_/cfk_）、Vercel（vcp_ 系）、Stripe（含 sk_org_）、Telegram bot、Discord bot 三段式、JWT 三段式、PEM 私钥块、DB 连接串（user:pass@）、Slack/Discord webhook、Bearer/Basic 头
3. **用户路径**：`C:\Users\<name>\...` → `~\<user>\...`（保留深层结构，只隐藏用户名段）
4. **上下文邻近**：`password:/token=/api_key=` 等关键词 + 分隔符 + 值 → 掩码（宽松策略：公开渠道默认拒绝，误掩码代价低漏报代价高）；**弱凭据值级检测**（admin/12345678/admin123 等 8+ 位默认密码，DeepSec L1 ai_pattern_default_password 同族）不因「纯小写无数字」放行
5. **allowlist 压误报**：~30 停用词（example/placeholder/changeme…）+ 纯小写标识符（`error-module-not-found` 是包名不是密钥）不掩码

掩码形态：`[AWS-REDACTED]` / `[JWT-REDACTED]` / `[REDACTED]`（上下文邻近）。

## 隐私边界

**收集**：插件元数据、安装方式、环境版本号（platform/Node/DSH/pnpm/git）、脱敏后的安装日志尾部。
**永不收集**：环境变量值（安装材料只作 env 传入从不持久化）、完整用户路径、密钥明文。
**已知限制**：日志为第三方插件 stderr 输出，脱敏规则为形态匹配——理论上存在未知形态泄漏可能；
无公开固定前缀的密钥（Mistral/Cohere/Together/火山方舟/Ollama Cloud/智谱等）靠上下文邻近与高熵兜底。
维护者发现泄漏应立即编辑 issue 移除并补充 redact 规则（`lib/redact.js` + `scripts/tests/unit/redact.test.mjs`）。
用户可在备注中要求删除其反馈 issue（维护者手工处理）。

### 密钥规则维护参考（官方文档站）

| 厂商 | 文档 |
|---|---|
| GitHub | https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github |
| Stripe | https://docs.stripe.com/keys |
| Supabase | https://supabase.com/docs/guides/api/api-keys |
| Telegram | https://core.telegram.org/bots/api |
| Cloudflare | https://developers.cloudflare.com/fundamentals/api/get-started/token-formats/ |
| Vercel | https://vercel.com/docs/accounts/access-tokens |
| Airtable | https://airtable.com/developers/web/guides/personal-access-tokens |
| Docker | https://docs.docker.com/security/access-tokens/ |
| Figma | https://developers.figma.com/docs/rest-api/personal-access-tokens/ |
| 腾讯云 | https://cloud.tencent.com/document/api/213/30654 |
| 交叉验证源 | gitleaks 规则库 https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml |

AI 推理厂商（Groq/xAI/Perplexity/Fireworks/Cerebras/Mistral/Ollama）官方文档一律不披露密钥格式，前缀依赖 secret-scanner 社区共识；每季度对照上表与 gitleaks 更新复核。

## 维护者处理流程

1. **正常反馈**（Result: 正常）：确认无附带问题后批量关闭（首行注释可脚本识别）
2. **异常反馈**（Result: 异常，label `install-failed`）：
   - 先看 details 日志——pnpm 报错/clone 失败/类型误判通常已可见
   - 需要更多信息时在 issue 里请用户「市场设置页 → 导出日志」（导出日志走独立的 sanitizeLog 全量脱敏）
3. **规则维护**：新增密钥形态 → `lib/redact.js` KNOWN_KEY_RULES 加规则 + redact.test.mjs 加泄漏断言
