# JobBot

**Web-UI 个人求职助手。** AI 原生，质量优先，而非数量。

JobBot 是一个本地 Web 应用（Express + EJS），帮助你发现和评估职位，并生成定制的 LaTeX 简历与求职信。专为 Claude Code 而设计：与 AI 对话，它会帮你填写个人资料、给职位打分并定制申请材料。实际投递完全由用户手动完成。

**启动 Web UI：**

```bash
pnpm jobbot ui
# 打开 http://localhost:3000
```

Web UI 提供仪表板分析图表、流水线管理、批量添加链接、职位搜索发现、本地候选人资料编辑、AI 辅助偏好编辑、经过事实校验的求职信生成、AI 调用日志等功能。CLI 命令保留用于脚本和自动化。

## 快速开始

```bash
git clone <this-repo> jobbot
cd jobbot
bash scripts/setup.sh
```

一行命令完成所有安装（LaTeX + pnpm 依赖 + 初始化）。

然后打开 Claude Code 开始填写个人资料：

```bash
claude
```

## 依赖

### 一键安装

```bash
bash scripts/setup.sh
```

### 手动安装

```bash
# 系统依赖：LaTeX（用于简历/求职信 PDF 生成）
sudo apt update && sudo apt install -y \
  texlive-latex-base \
  texlive-latex-recommended \
  texlive-latex-extra \
  texlive-fonts-recommended \
  texlive-fonts-extra

# 系统依赖：poppler-utils（用于 PDF 转图片，视觉审核）
sudo apt install -y poppler-utils python3-pip
pip3 install PyMuPDF --quiet --break-system-packages

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
| `python3-pip` + `PyMuPDF` | Python PDF 转图片备选方案 |

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

### 第 1 步：打开 Claude Code

```bash
cd jobbot
claude
```

Claude 启动时会读取 `CLAUDE.md`，并知道应该与你进行入职面谈。

### 第 2 步：与 Claude 对话

告诉 Claude 关于你自己的情况。它会提出问题并填写文件：

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

Claude 所写的所有内容都基于你提供的信息。不会编造任何东西。你可以随时查看和调整。

## 命令

### Web UI（主要界面）

| 命令 | 说明 |
|---|---|
| `pnpm jobbot ui` | **启动 Web 面板** http://localhost:3000 |

Web UI 提供：带分析图表的仪表板、流水线管理、批量添加链接、职位搜索发现、带薪资/技能展示和交互式流水线追踪的职位详情、本地候选人资料编辑、AI 辅助偏好编辑、经过 evidence/provenance 校验的求职信生成、AI 调用日志和事件时间线。

### CLI 命令

| 命令 | 说明 |
|---|---|
| `bash scripts/setup.sh` | 一键完整安装（LaTeX + poppler + pnpm + 初始化） |
| `pnpm jobbot init-db` | 创建 `local/`（从模板）+ 初始化 SQLite 数据库结构 |
| `pnpm jobbot add-url <url> [url2 ...]` | 添加一个或多个职位链接（自动检测 ATS 类型） |
| `pnpm jobbot discover --query <关键词> [--location <城市>] [--source <平台>] [--ingest]` | 搜索招聘网站上的新职位 |
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
| `pnpm jobbot audit --job <id>` | 内容 + 视觉审核已渲染 PDF |
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

专为 **Claude Code** 及其他 AI 编程助手设计，运行于 **WSL2**。
