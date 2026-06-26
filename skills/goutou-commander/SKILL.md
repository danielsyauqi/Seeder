---
name: goutou-commander
description: 狗头军师 — 多仓库协同指挥官。输入一句话业务诉求，自动在 Seeder 协同中枢创建任务、打 repo:* 路由标签、写首条分工评论，输出任务链接。在 goutou 主控仓库使用。触发词：/goutou-commander、"军师帮我协调"、"分发任务"、"多仓库联动"。
---

# 狗头军师 / Goutou Commander

多仓库协同指挥中枢。解析业务诉求 → 拆解仓库分工 → 在 Seeder 创建协同任务 → 打路由标签 → 写首条分工评论。

## 激活时机

- 用户输入 `/goutou-commander <需求描述>`
- 用户说"军师帮我协调…" / "需要多仓库联动…" / "分发任务给…"
- 在 goutou 仓库目录下工作时，有跨仓库协作需求

## 前置条件

- Seeder MCP server 已配置（`~/.claude.json` 中 `mcpServers.seeder`，PAT scope = `readwrite`）
- Seeder 里存在「协同中枢」项目（或 `.goutou.json` 中有 `coordProjectId`）
- 当前工作目录是 goutou 仓库

## 工作流

### Step 0：读本地配置

```bash
cat .goutou.json 2>/dev/null || echo "{}"
```

解析结果：
- `coordProjectId`：协同中枢项目 ID（若有则直接用，跳过 Step 1 的搜索）
- `seederUrl`：Seeder 实例地址（仅供展示用）

### Step 1：定位协同中枢项目

调用 `list-projects`（Seeder MCP）。

在返回的项目列表中查找名称含以下关键词的项目（不区分大小写）：
`协同`、`coord`、`goutou`、`军师`、`hub`

- 找到 → 记录 `coordProjectId`
- 未找到 → 告知用户：「请先在 Seeder 里创建一个协同中枢项目，然后在 .goutou.json 里设置 coordProjectId，或将项目命名为包含"协同/coord/goutou"。」停止执行。

### Step 2：分析诉求，拆解仓库分工

从用户输入提取：

**需求摘要**（≤ 50 字，作为 Task 标题）

**涉及仓库列表**（推断或从用户说明读取）。常见仓库 ID 参考：
- `contract` — 智能合约（上游，其他仓库的依赖方）
- `kms` — 密钥管理服务
- `dvt` — 后端服务
- `sdk` — 汇聚合约 ABI + 后端 API（下游 App 的依赖）
- `app`（或具体名）— 前端/客户端 App

**各仓库分工**（每个仓库 2–3 句：做什么、输出什么、依赖什么）

**执行顺序建议**（若有上下游依赖关系）

若无法推断涉及哪些仓库，先问用户确认，再继续。

### Step 3：创建协同任务

调用 `create-task`（Seeder MCP）：
```
projectId   = coordProjectId
title       = <需求摘要>
description = "repo:<仓库1> repo:<仓库2> repo:<仓库3>"
```

**description 格式严格**：每个涉及仓库用 `repo:` 前缀、空格分隔（如 `repo:contract repo:sdk repo:dvt`）。这是工兵 P0 阶段 `search("repo:<ID>")` 能找到此任务的唯一依据——Seeder 只索引任务标题和描述，不索引评论。

记录返回的 `taskId`。

### Step 4：确保 repo:* 标签存在

对每个涉及仓库，执行：

1. 调用 `list-task-labels`（projectId = coordProjectId）
2. 检查是否已有名为 `repo:<仓库ID>` 的标签（精确匹配）
3. 若无 → 调用 `create-task-label`：
   - `name` = `repo:<仓库ID>`
   - `color` = 按下表分配（固定颜色，方便视觉识别）：
     - `repo:contract` → `#e74c3c`（红）
     - `repo:kms`      → `#9b59b6`（紫）
     - `repo:dvt`      → `#2980b9`（蓝）
     - `repo:sdk`      → `#27ae60`（绿）
     - 其他            → `#f39c12`（橙）

可并行处理多个仓库的标签检查+创建。

### Step 5：给任务打路由标签

调用 `add-task-label`：
```
taskIds  = [taskId]
labelIds = [所有涉及仓库对应的 labelId]
```

### Step 6：写首条分工评论

调用 `add-task-comment`（taskId = Step 3 的 taskId），内容如下：

```markdown
## 需求背景

<1–2 句背景说明>

## 各仓库分工

### repo:contract
<合约需要做的事，输出什么>

### repo:sdk
<SDK 需要封装什么，依赖 contract 的哪些输出>

### repo:dvt
<后端需要提供什么接口>

（其他涉及仓库同上格式）

## 执行顺序建议

<有依赖关系时说明推荐顺序，如：contract → sdk → app>

---
*🧠 军师创建 · 等待各仓库工兵响应*
```

> **注意**：搜索路由标记已写入 Step 3 的 task description（`repo:xxx` 格式），评论无需重复写。

### Step 7：更新本地配置（若 coordProjectId 是新发现的）

若本次是通过搜索项目名找到协同中枢，且 `.goutou.json` 里没有 `coordProjectId`：

1. 用 Read 工具读取 `.goutou.json`（若不存在则视为 `{}`）
2. 合并 `coordProjectId` 字段
3. 用 Write 工具写回（保留已有字段，不覆盖 `repoId`/`seederUrl` 等）

### Step 8：输出结果

向用户展示：

```
✅ 协同任务已创建

任务：<title>（<code>）
项目：<协同中枢项目名>
已分配仓库：repo:contract、repo:sdk、repo:dvt

各仓库工兵启动命令：
  cd /path/to/sdk && /goutou        # 单次响应
  cd /path/to/sdk && /loop 5m /goutou   # 定时轮询

在 Seeder 查看完整进展：<seederUrl>/projects/<coordProjectId>（若 .goutou.json 未配置 seederUrl 则省略此行）
```

## 错误处理

- Seeder MCP 未配置 → 告知用户按 docs/goutou/README.md 配置 MCP
- PAT 为 read 只读 → 告知需要 readwrite scope 的 PAT
- 协同项目未找到 → 见 Step 1 的处理
- 标签创建失败（非 owner/leader）→ 告知用户需要在协同项目中有 owner 或 leader 权限
