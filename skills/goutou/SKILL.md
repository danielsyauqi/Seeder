---
name: goutou
description: 狗头工兵 — 多仓库协同响应者。轮询 Seeder 协同中枢，找到分配给本仓库的任务，结合本仓库代码上下文做分析并回复评论。配合 /loop 5m /goutou 实现定时轮询。每个子仓库安装一个。触发词：/goutou、"查协同任务"、"看看有没有我的任务"。
---

# 狗头工兵 / Goutou Soldier

在当前仓库作为协同工兵运行：检测本仓库身份 → 搜索分配给本仓库的协同任务 → 结合代码上下文分析 → 回复评论。

## 激活时机

- 用户输入 `/goutou`（单次手动触发）
- 配合 `/loop 5m /goutou` 每 5 分钟自动轮询
- 用户说"查一下协同任务"/"看看有没有我的任务"

## 前置条件

- `seeder` MCP server 已在本仓库配置（`.claude/settings.json` 或全局 `~/.claude.json`）
- PAT scope = `readwrite`（需要能发评论）
- 当前目录是 git 仓库

## 工作流

### Step 0：确定本仓库身份（REPO_ID）

按优先级顺序：

```bash
# 1. 读本地配置
cat .goutou.json 2>/dev/null || echo "{}"

# 2. 从 git remote 提取仓库名
git remote get-url origin 2>/dev/null | sed 's/.*[:/]//' | sed 's/\.git$//'

# 3. 兜底：用当前目录名
basename "$(pwd)"
```

- `.goutou.json` 有 `repoId` → 直接用
- 否则用 git remote 提取的仓库名（如 `sdk`、`contract`）
- 记录为 `REPO_ID`

同时读取 `.goutou.json` 中的 `coordProjectId`（若有）。

### Step 1：定位协同中枢项目

若已有 `coordProjectId`（从配置读取），直接使用。

否则调用 `list-projects`，找名称含 `协同`/`coord`/`goutou`/`军师`/`hub` 的项目。

未找到 → 输出提示：「未找到协同中枢项目。请确认 Seeder 里已创建协同项目，或在 .goutou.json 里设置 coordProjectId。」停止。

### Step 2：搜索分配给本仓库的任务

调用 `search`（Seeder MCP）：
```
query = "repo:<REPO_ID>"
```

从结果中筛选出 `type = "task"` 且 `projectId = coordProjectId` 的 hit。

若无结果 → 输出：「本仓库（<REPO_ID>）暂无待处理的协同任务。」结束。

### Step 3：逐个读取任务详情，判断是否需要响应

对每个 hit，并行执行两个调用：
- `read-task`（projectId = coordProjectId，taskId = hit.id）→ 获取状态和描述
- `list-task-comments`（projectId = coordProjectId，taskId = hit.id）→ 获取评论列表

**跳过条件**（满足任一则跳过此任务）：
1. `isTerminal = true`（任务已完结）
2. 评论列表中已存在包含 `[repo:<REPO_ID>] 工兵回复` 的评论（避免重复响应）

**待响应任务**：所有未被跳过的任务及其评论列表，记录到待响应列表。

### Step 4：分析并回复

对每个待响应任务：

**Step 4a：理解分工**

在 Step 3 已获取的评论列表中，找到军师的首条分工评论（通常包含 `## 各仓库分工` 标题），提取 `### repo:<REPO_ID>` 段落下的分工说明。

**Step 4b：结合本仓库代码上下文分析**

根据分工说明，在本仓库代码中查找相关文件/模块/接口：
- 若需实现新接口 → 找相关代码位置，给出具体文件路径和方案
- 若需读取上游输出 → 确认依赖接口定义，提出问题（若上游未回复）
- 若有阻塞 → 明确说明阻塞原因和等待内容

**Step 4c：发布工兵回复**

调用 `add-task-comment`，内容格式：

```markdown
[repo:<REPO_ID>] 工兵回复

## 分析结果

<对分工要求的理解 + 本仓库当前状态>

## 技术方案

<具体实现思路，含关键文件路径（file:line 格式）>

## 对外输出

<本仓库将提供的接口/类型定义/ABI，供下游仓库参考>
（若无对外输出则省略此节）

## 工期估算

<乐观/悲观估算>

## 阻塞 / 依赖

<等待上游 repo:xxx 提供：具体内容>
（若无阻塞则写「无阻塞，可独立启动」）

---
*<REPO_ID> 工兵已接收任务*
```

### Step 5：汇报本轮执行结果

```
🐾 工兵巡逻完毕（repo:<REPO_ID>）

扫描协同任务：<n> 个
└─ 已响应：<m> 个（列出标题）
└─ 跳过（已回复）：<k> 个
└─ 跳过（已完结）：<j> 个

下次运行：/goutou  或  /loop 5m /goutou（自动轮询）
```

## 与 /loop 配合使用

在需要持续响应的仓库，启动后台轮询：

```
/loop 5m /goutou
```

工兵每 5 分钟自动检查一次，有新任务时立即回复，无任务时静默跳过（只输出一行摘要）。

## 错误处理

- Seeder MCP 未配置 → 告知用户配置 MCP（见 docs/goutou/README.md）
- REPO_ID 无法确定 → 提示用户在 `.goutou.json` 里设置 `repoId`
- `read-task` 返回 null → 跳过该任务（可能已被删除或无权访问）
- 评论发布失败 → 告知用户，不重试
