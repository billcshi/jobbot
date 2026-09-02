# JobBot

**Web-UI 个人求职助手。** AI 原生，质量优先，而非数量。

JobBot 是一个本地 Web 应用（Express + EJS），帮助你发现和评估职位，并生成定制的 LaTeX 简历与求职信。它支持 Claude Code、Codex、Cursor、Copilot 等 AI 编码助手：与 AI 对话，它会帮你填写个人资料、给职位打分并定制申请材料。实际投递完全由用户手动完成。

**启动 Web UI：**

```bash
pnpm jobbot ui
# 打开 http://localhost:3000
```

Web UI 提供仪表板分析图表、流水线管理、批量添加链接、职位搜索发现、本地候选人资料编辑、AI 辅助偏好编辑、经过事实校验的求职信生成、AI 调用日志等功能。CLI 命令保留用于脚本和自动化。

## 快速开始

安装前需要 Node.js 20 或更高版本、可用网络，以及安装系统软件的权限。Linux 自动安装目前支持 Debian/Ubuntu；Windows 使用 WinGet。

```bash
git clone <this-repo> jobbot
cd jobbot
bash scripts/setup.sh
```

Windows PowerShell 请使用：

```powershell
git clone <this-repo> jobbot
cd jobbot
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

一行命令安装 LaTeX、Poppler 和 pnpm 依赖，初始化数据库，并运行类型检查与自动化测试。脚本还会使用 JobBot 简历模板的真实宏包编译一次临时 PDF，因此安装成功就代表 PDF 生成功能确实可用。Windows 脚本会自动修复当前 PowerShell 会话中的 MiKTeX/Poppler 路径，并预装模板需要的 MiKTeX 宏包。

然后在你常用的 AI 编码助手中打开项目，并告诉它“开始填写我的个人资料”。如果已经安装 Claude Code，可以运行：

```bash
claude
```

如果你已经在当前项目中使用 Codex 或其他兼容的 AI 助手，无需再运行任何命令，直接继续对话即可。

## 依赖

### 一键安装

Debian/Ubuntu Linux：

```bash
bash scripts/setup.sh
```

Windows PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

如果暂时只使用 Web UI、不安装 LaTeX 和 Poppler：

```powershell
.\scripts\setup.ps1 -SkipSystemDependencies
```

### 手动安装

Windows 用户通常应直接运行 `scripts/setup.ps1`。如果手动安装 Windows 依赖，请通过 WinGet 安装 `MiKTeX.MiKTeX` 和 `oschwartz10612.Poppler`。安装脚本还会准备 `resumes/master.tex` 使用的 MiKTeX 宏包：`titlesec`、`marvosym`、`enumitem`、`hyperref`、`fancyhdr`、`tabularx`、`lato` 和 `fontawesome5`。

```bash
# 系统依赖：LaTeX（用于简历/求职信 PDF 生成）
sudo apt update && sudo apt install -y \
  texlive-latex-base \
  texlive-latex-recommended \
  texlive-latex-extra \
  texlive-fonts-recommended \
  texlive-fonts-extra

# 系统依赖：poppler-utils（用于 PDF 转图片，视觉审核）
sudo apt install -y poppler-utils

# Node.js 依赖
pnpm install

# 初始化
pnpm jobbot init-db
```

### 各系统包的作用

| 包名 | 用途 |
|---|---|
| `texlive-latex-base` | pdflatex、article 文档类、基础格式 |
| `texlive-latex-recommended` | fullpage、fancyhdr、tabularx、enumitem、titlesec |
| `texlive-latex-extra` | marvosym、fontaxes、更多布局包 |
| `texlive-fonts-recommended` | 核心字体、Latin Modern |
| `texlive-fonts-extra` | **fontawesome5**（图标）、**lato**（正文字体） |
| `poppler-utils` | **pdftoppm** — PDF → PNG 用于视觉审核 |

### API 密钥与 PDF 审核方式

API 密钥只能保存在 `local/config.yaml` 中；`local/` 已被 gitignore。不要把真实密钥写入 `local.example/`、README、源代码或准备分享的命令中。

- DeepSeek 用于职位提取、评分、简历定制、内容审核和 AI 辅助资料编辑。要运行完整流水线，需要配置 `api_keys.deepseek`。
- Anthropic 和 OpenAI 是可选的视觉审核提供方。如果二者都没有配置，JobBot 会默认拒绝通过，除非人工或 AI Agent 明确检查渲染后的 PDF，并记录到 `local/resumes/<job-id>/visual-review.json`。
- 本地视觉审核会绑定准确的职位 ID、简历版本 ID 和 PDF SHA-256；重新生成或修改 PDF 后，旧审核自动失效。
- 上述 AI 阶段会把候选人资料事实和职位描述发送给 DeepSeek；渲染后的简历页面图片会发送给配置的 Anthropic 或 OpenAI 视觉服务。Prompt/调试日志以明文保存在已被 gitignore 的 `local/` 目录中，请把该目录视为敏感数据。

## 重要：个人数据与项目代码分离

本仓库设计为**可以安全地分享到 GitHub**。你的个人数据存放在 `local/` 目录中——该目录**已被 gitignore，永远不会被提交**。

```
local/              ← 你的个人数据（gitignored——绝不提交）
  data/               你的 SQLite 数据库
  resumes/            生成的 LaTeX 简历及 PDF

local.example/      ← 公开模板（已提交——展示目录结构）
```

首次运行时，`pnpm jobbot init-db` 将 `local.example/` 复制为 `local/`。在那里填写你的真实数据。仓库中的其他所有内容都可以安全地推送到公开的 GitHub。

## 理念

- **AI 原生。** 你不需要手动编辑 YAML。向 AI 描述你的背景、偏好和不接受的条件，它会通过 profile store 保存到本地数据库。
- **质量优先，而非数量。** 这不是批量投递机器人。目标是筛选出最佳匹配，认真对待每一个机会。
- **手动投递。** JobBot 只准备材料和记录结果，不会填写或提交申请表。
- **永不编造数据。** 简历定制可以对**真实经历**重新排序、筛选或轻量改写——但绝不会编造公司、日期、技能或任何声明。
- **你掌控一切。** 你需要审核生成的材料，并亲自完成每一次投递。

## 创建你的个人资料（AI 原生）

你**不需要**手动编辑 YAML 文件。相反，在项目目录中打开 AI 编码助手，与它对话即可。它会通过询问来了解你，并创建版本化 profile。

### 第 1 步：打开 AI 编码助手

```bash
cd jobbot
# 如果已安装 Claude Code：
claude
```

Claude Code 会读取 `CLAUDE.md`；Codex 及其他兼容的 AI 助手会读取 `AGENTS.md`。如果你已经在当前项目中与 AI 助手对话，可以跳过 `claude` 命令。

### 第 2 步：与 AI 助手对话

告诉 AI 助手关于你自己的情况。它会提出问题，并在本地数据库中创建不可变的个人资料版本：

**Candidate profile** — 本地数据库中的真实背景：
- 工作经历（公司、职位、时间、亮点、使用过的技术）
- 教育背景（学校、学位、年份）
- 技能（语言、框架、基础设施、数据库）
- 链接（GitHub、LinkedIn、个人网站）

**Preferences profile** — 本地数据库中的求职偏好：
- 偏好的职位名称（"高级软件工程师"、"Staff 工程师"……）
- 地点偏好（远程？哪些城市？）
- 偏好的公司和行业
- 绝不接受的条件（关键词或行业）
- 薪资期望

### 第 3 步：检查

运行 `pnpm jobbot ui`，在 Profile 页面检查 candidate 和 preferences。

AI 助手写入的所有内容都必须基于你提供的信息，不会编造任何东西。你可以随时查看和调整。

## 命令

### Web UI（主要界面）

| 命令 | 说明 |
|---|---|
| `pnpm jobbot ui` | **启动 Web 面板** http://localhost:3000 |

Web UI 提供：带分析图表的仪表板、流水线管理、批量添加链接、职位搜索发现、带薪资/技能展示和交互式流水线追踪的职位详情、本地候选人资料编辑、AI 辅助偏好编辑、经过 evidence/provenance 校验的求职信生成、AI 调用日志和事件时间线。

### CLI 命令

| 命令 | 说明 |
|---|---|
| `bash scripts/setup.sh` | Linux 一键完整安装（LaTeX + poppler + pnpm + 初始化） |
| `powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1` | Windows 一键完整安装（MiKTeX + Poppler + pnpm + 初始化） |
| `pnpm jobbot init-db` | 创建 `local/`（从模板）+ 初始化 SQLite 数据库结构 |
| `pnpm jobbot add-url <url> [url2 ...]` | 添加一个或多个职位链接（自动检测 ATS 类型） |
| `pnpm jobbot discover --query <英文关键词> [--location <英文城市>] [--source <平台>] [--company <ATS slug>] [--work-mode any\|remote\|onsite] [--depth quick\|deep] [--ingest]` | 搜索招聘网站上的新职位；CLI 与 UI 都会拒绝中文搜索输入 |
| `pnpm jobbot extract [--job <id>]` | 抓取 + LLM 提取职位详情 |
| `pnpm jobbot score` | LLM 打分（对照偏好设置） |
| `pnpm jobbot list [--tier <tier>]` | 以表格形式列出所有职位 |
| `pnpm jobbot market-data [--key <前缀>]` | 查看提取的市场情报 |
| `pnpm jobbot delete --job <id> [--force]` | 删除单个职位 |
| `pnpm jobbot delete --tier <tier> [--force]` | 按等级批量删除 |
| `pnpm jobbot delete --status <status> [--force]` | 按状态批量删除 |
| `pnpm jobbot run [--step extract\|score\|compose\|audit]` | 运行流水线（全部或单步） |
| `pnpm jobbot run --job <id>` | 对单个职位运行完整流水线 |
| `pnpm jobbot tailor --job <id>` | LLM 简历定制（内部） |
| `pnpm jobbot render --job <id>` | LaTeX → PDF 渲染（内部） |
| `pnpm jobbot compose --job <id>` | 定制 + 渲染一步完成 |
| `pnpm jobbot cover-letter --job <id>` | 通过 LLM 生成求职信 |
| `pnpm jobbot audit --job <id>` | DeepSeek 内容审核 + 视觉模型或与哈希绑定的本地视觉审核 |
| `pnpm jobbot schedule --once` | 运行一次流水线 |
| `pnpm jobbot schedule --interval <分钟>` | 按间隔定时运行流水线 |
| `pnpm test` | 运行测试套件 |
| `pnpm typecheck` | TypeScript 类型检查 |

## 项目结构

```
jobbot/
  scripts/
    setup.sh             一键安装脚本

  local.example/         公开模板（已提交到 git）
    config.yaml            安全的配置模板

  local/                 你的个人数据（gitignored，绝不提交）
    data/                  SQLite 数据库（资料、职位、运行记录）
    resumes/               生成的 LaTeX 简历及 PDF

  src/                    TypeScript 源码（公开，已提交）
    cli.ts                 命令行入口
    db/                    数据库结构、客户端、初始化
    jobs/                  添加、提取、打分、列表、ATS 检测
    resume/                定制、渲染（LaTeX → PDF）、校验
    utils/                 配置、日志、资料和路径工具

  resumes/
    master.tex             LaTeX 简历模板（公开）
  prompts/                 LLM Prompt 模板（公开）
  tests/                   Vitest 测试（公开）
  docs/                    架构与流水线指南
```

## 已实现能力

- 带登录与用户隔离的 Web 工作区，以及版本化 SQLite Profile
- 职位发现、提取、评分、筛选和定时流水线
- 受证据约束的简历定制、LaTeX 渲染和 PDF 产物校验
- 委员会内容审核和视觉质量门禁
- 带 provenance 的求职信生成
- 手动投递与申请结果跟踪

## 技术栈

TypeScript · pnpm · SQLite (better-sqlite3) · Express · EJS · YAML 配置 · LaTeX · DeepSeek API · Vitest

支持 **Claude Code、Codex 及其他 AI 编码助手**，可运行于 Windows PowerShell 或 WSL2/Linux。
