# Pi Packages 安装机制与 HiAgent 的 Agent 级分配模型

> 日期：2026-07-05
> 来源：https://pi.dev/docs/latest/packages + 设计推导
> 状态：调研存档

## 一、Pi 原生安装机制（完整）

### 1.1 安装命令

```bash
# 三种来源
pi install npm:@foo/bar@1.0.0                    # npm（带版本=锁定，不带=最新）
pi install git:github.com/user/repo@v1           # git 简写
pi install https://github.com/user/repo           # raw URL
pi install /absolute/path/to/package              # 本地绝对路径
pi install ./relative/path/to/package             # 本地相对路径

# 管理
pi remove npm:@foo/bar                            # 卸载
pi list                                           # 查看已装包
pi update --all                                   # 更新 pi + 所有包
pi update --extensions                            # 只更新包
pi update npm:@foo/bar                            # 更新单个包

# 临时试用（不写配置）
pi -e npm:@foo/bar
pi -e git:github.com/user/repo

# 交互式启用/禁用资源
pi config
```

### 1.2 三种来源对比

| 来源 | 语法 | 存储位置 | 版本控制 |
|------|------|---------|---------|
| **npm** | `npm:@scope/pkg@1.2.3` | `~/.pi/agent/npm/<pkg>` 或 `.pi/npm/<pkg>` | 带 `@version` 锁定，`pi update --extensions` 跳过 |
| **git** | `git:host/user/repo@ref` | `~/.pi/agent/git/<host>/<path>` 或 `.pi/git/<host>/<path>` | ref 锁定到 tag/commit，不自动升级 |
| **local** | `/abs/path` 或 `./rel/path` | 不复制，原地加载 | 无（跟随源文件变化） |

### 1.3 作用域

```bash
pi install npm:foo          # 全局：~/.pi/agent/settings.json
pi install -l npm:foo       # 项目：.pi/settings.json（可共享给团队）
```

- 项目配置可提交 git，团队 clone 后 Pi 自动安装缺失包（项目被信任后）
- 同包同时在全局和项目 → **项目级覆盖全局**
- 身份判定：npm 看包名 / git 看仓库 URL（不含 ref）/ local 看绝对路径

### 1.4 包结构

**声明式**（`package.json` 的 `pi` 字段）：

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

**约定式**（无 `pi` 字段时自动发现）：

| 目录 | 加载规则 |
|------|---------|
| `extensions/` | `.ts` 和 `.js` 文件 |
| `skills/` | 递归找 `SKILL.md` 文件夹；顶层 `.md` 作为单个 skill |
| `prompts/` | `.md` 文件 |
| `themes/` | `.json` 文件 |

### 1.5 Pi 原生的资源过滤（包级）

在 `settings.json` 里用对象形式过滤：

```json
{
  "packages": [
    "npm:simple-pkg",
    {
      "source": "npm:my-package",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"],
      "themes": ["+themes/legacy.json"]
    }
  ]
}
```

过滤语义：
- 省略 key → 加载全部
- `[]` → 加载零个
- `!pattern` → 排除
- `+path` → 强制包含
- `-path` → 强制排除

---

## 二、HiAgent 的 Agent 级分配模型（关键差异）

### 2.1 问题：Pi 原生过滤是"包级"的

Pi 的过滤语法只控制**某个包的哪些资源被加载**，但加载后这些资源对**所有 agent 可见**（全局共享）。无法表达：

> "装了 pi-web-access，但只让产品和研发能用 web_search，PM 和测试不能用"

### 2.2 HiAgent 的方案：Agent 级分配

HiAgent 把分配粒度从"包"下沉到"agent"。每个 agent 独立配置自己的：

- **工具**（tools 字段）—— 来自内置 / 插件 / MCP 三类来源
- **技能**（skills 字段）—— 显式分配列表
- **MCP server**（mcpServers 字段）—— 启用哪些 MCP server

### 2.3 两层模型对比

```
┌─────────────────────────────────────────────────────┐
│ Pi 原生（包级过滤）                                   │
│                                                     │
│  settings.json packages: [                          │
│    { source: "npm:bigpowers", skills: [...] }       │
│  ]                                                  │
│                                                     │
│  → 加载的资源对所有 agent 共享                        │
│  → 无法按 agent 区分                                 │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ HiAgent（agent 级分配）                              │
│                                                     │
│  插件市场（资源池）                                   │
│    ├── 装/卸包（调 pi install/remove）               │
│    └── 装了 = 资源进入"可用池"                        │
│         ↓                                           │
│  Agent 配置（分配入口）                              │
│    ├── 产品.md: tools=[read,web_search] skills=[…]  │
│    ├── 研发.md: tools=[read,bash,edit] skills=[…]   │
│    ├── PM.md:    tools=[read,grep]                  │
│    └── 测试.md:  tools=[read,bash] mcpServers=[…]   │
│                                                     │
│  → 每个 agent 只能用分配给它的资源                    │
└─────────────────────────────────────────────────────┘
```

### 2.4 数据落地

每个 agent 的分配写入其 `.md` 文件的 frontmatter：

```yaml
# ~/.pi/agent/agents/dev.md
---
name: dev
displayName: 研发
avatar: ⚙️
description: 后端研发
model: anthropic/claude-sonnet-4
thinking: high

# 工具分配（三类来源混在一起，spawn 时转成 --tools 参数）
tools: read, bash, edit, write, grep, find, ls, web_search, fetch_url

# 技能分配（显式列表，不继承全局）
inheritSkills: false
skills: architecture-review, debug-methodically, write-tests-first

# MCP server 分配（HiAgent 扩展字段）
mcpServers: []   # 研发不启用 MCP；测试 agent 可能 mcpServers: [chrome-devtools]
---
```

### 2.5 spawn 时的资源解析

HiAgent 编排内核在 spawn 每个 Pi 进程时，按 agent 配置合成启动参数：

```
pi --mode rpc \
    --tools read,bash,edit,write,grep,find,ls,web_search,fetch_url \  # 来自 tools 字段
    --skill ~/.pi/agent/skills/architecture-review/SKILL.md \          # 来自 skills 字段
    --skill ~/.pi/agent/skills/debug-methodically/SKILL.md \
    --no-skills                                                        # 禁用全局技能继承
```

**关键**：
- `--tools` 控制工具白名单（未列出的工具即使包加载了也调不了）
- `--skill` 显式注入技能（配合 `--no-skills` 禁用全局自动发现）
- `mcpServers` 通过 `.mcp.json` 配置文件控制（pi-mcp-adapter 读取）

### 2.6 为什么这行得通

Pi 的 `--tools` flag 本来就是 allowlist 语义：
- 包加载的资源进入"进程可见集"
- `--tools` 进一步过滤成"agent 实际能调用的"
- 没列在 `--tools` 里的工具，LLM 看不到也调不了

所以 HiAgent 不需要改 Pi 的加载逻辑，只需要：
1. 在 GUI 层管理每个 agent 的 tools/skills/mcpServers 配置
2. spawn 时把这些配置翻译成 `--tools` / `--skill` 参数

### 2.7 双向追溯

HiAgent 维护两套索引，支持双向查询：

```
按 agent 查 → "研发用了哪些资源？"
  tools: read, bash, edit, web_search（来自 pi-web-access）
  skills: architecture-review（来自 bigpowers）

按资源查 → "web_search 被哪些 agent 用了？"
  产品 ✓ / 研发 ✓ / PM ✗ / 测试 ✗
```

这让"能力对比表"（agent 配置里的 4 列对比）和"资源被谁用"（插件市场里的分配追溯）成为同一份数据的两个视图。

---

## 三、HiAgent PackageManager 组件的职责

基于上述模型，HiAgent 的 PackageManager 组件做这些事：

| 操作 | 实现 | 对应 Pi 命令 |
|------|------|-------------|
| 安装包 | 调 `pi install npm:xxx` | `pi install` |
| 卸载包 | 调 `pi remove npm:xxx` | `pi remove` |
| 列出已装 | 读 `~/.pi/agent/settings.json` 的 packages | `pi list` |
| 更新包 | 调 `pi update npm:xxx` | `pi update` |
| 分配资源给 agent | 改 agent.md 的 tools/skills 字段 | 无（HiAgent 扩展） |
| 查询资源被谁用 | 扫描所有 agent.md，反向索引 | 无（HiAgent 扩展） |
| 配置 MCP server | 读写 `.mcp.json` | 无（pi-mcp-adapter 读取） |

**关键**：HiAgent **不重造包管理器**。装/卸/更新全部调 Pi 的 CLI，HiAgent 只在上一层做"分配给哪个 agent"的管理 + GUI。

---

## 四、内置核心（不可删除）

以下两个包是 HiAgent 的核心基础设施，预装且锁定：

| 包 | 作用 | 不可删的原因 |
|----|------|-------------|
| `pi-intercom` | agent 间通信（ask/send/reply） | 没有 it，动态委派无法发生 |
| `pi-mcp-adapter` | MCP 工具桥接 | 没有 it，MCP 工具整个来源消失 |

它们提供的能力（`intercom` / `contact_supervisor` 工具）始终对所有 agent 启用，不显示在 agent 配置的"能力" tab 里（用户改不了，也不需要看到）。

在插件市场 UI 里，它们标记为 🔒 内置核心，不显示删除按钮。

---

## 五、与设计文档的对应关系

本文档细化了设计文档（`2026-07-05-hiagent-design.md`）的：
- **5.2 资源三层模型** —— 补充了"为什么 agent 级分配可行"的技术依据
- **7.1 PackageManager 组件** —— 补充了具体操作与 Pi CLI 的映射
- **8.3 装包到分配** 数据流 —— 补充了 spawn 参数合成的细节

## 六、参考

- [Pi Packages 官方文档](https://pi.dev/docs/latest/packages)
- [Pi Package Catalog](https://pi.dev/packages)
- [Pi Extensions 文档](https://pi.dev/docs/latest/extensions)（工具注册机制）
- [Pi SDK 文档](https://pi.dev/docs/latest/sdk)（`--tools` / `--skill` 参数）
