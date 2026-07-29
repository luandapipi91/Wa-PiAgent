# 多智能体矩阵（Agent Matrix）重写设计

日期：2026-07-17
状态：已确认（UI 已经视觉伴侣逐屏对齐，等待 spec 评审）

## 背景

现状：agent 是 4 值硬编码枚举（product/pm/dev/test），定义在 `shared/src/types.ts:28`，配置以 Markdown+frontmatter 存于 `~/.wa-pi/agents/<name>.md`。侧边栏 `AgentListSection.tsx` 固定展示 4 个 agent，点击是打开配置弹窗而非建会话。`AgentConfig` 的 tools/skills/avatar/partners 字段已定义但前端/运行时未消费。会话与 agent 1:1 绑定（`SessionEntity.primaryAgent`），无 subagent 调起机制；pi-intercom 已内置但只能向已运行会话发消息。

目标：重写为"多智能体矩阵"——智能体成为可增删改查的动态实体，侧边栏新增智能体管理区，支持详情配置（提示词/触发条件/工具/技能/关系网）、对话中切换智能体、智能体间通过 subagent 调起协作并在消息流中显示委托卡片。

## 已确认的决策

| 决策点 | 结论 |
|---|---|
| 触发条件 | @提及 + 关系网自动委派（subagent）+ 关键词；关键词语义 = **主智能体自动调起子智能体的判定提示**（随关系网注入提示词），不做建议条、不切换主智能体 |
| 详情页形态 | 弹窗，**4 个 tab**：基本（身份/模型/提示词/触发条件合并）/ 工具 / 技能 / 关系网（带搜索） |
| 存量 4 个 agent | 放开为动态实体，`AgentName` 改为 string，可编辑可删除，可新建任意数量 |
| 名称字段 | 名称即标识，**无简称字段**；保存时直接以名称作为文件名，重名自动加 `-2`/`-3` 后缀 |
| 思考档位 | 复用现有 `ThinkingSelector`：`off / mid / high / max`；`AgentConfig.thinking` 类型对齐为 `ThinkingLevel` |
| 前 3 排序 | 最近使用（由会话 primaryAgent + updatedAt 推导，无新存储） |
| 删除智能体 | 会话保留；发送消息时要求重选智能体 |
| 调起机制 | 引入 `@gotgenes/pi-subagents`，**替换 pi-intercom** 作为内置扩展；宿主 `delegate` customTool 经其 service API 调起，allowlist 强制生效 |
| 提及符号 | **@ = 智能体，# = 文件（原 @ 文件能力迁移），$ = 技能（不变）** |
| 对话中切换 | 会话顶部 pill 下拉切换（**带搜索**），切换前弹确认框"切换后所有缓存都会失效，是否继续"；确认后 SDK session 换体重建保留历史 |
| 委托显示 | 复用 DelegateCard 橙色视觉，扩展 执行中/完成/可展开子过程 三态 |
| 侧边栏样式 | 紧凑行（头像+名称+状态点），>3 个显示「更多智能体 (n)」 |
| 宫格弹窗 | 3 列卡片：头像+名称+简介+状态点；右上新建；左键建会话、右键编辑/删除 |

## 1. 数据模型（packages/shared）

- `types.ts:28`：`AgentName` 从字面量联合改为 `type AgentName = string`。
- `AgentConfig`（types.ts:40-56）扩展：
  - 新增 `triggerKeywords: string[]` — 触发关键词：其他智能体自动调起本智能体时的判定提示（随关系网段注入提示词，见 2.3）
  - 复用 `partners.askTo: AgentName[]` — 关系网（可调起的智能体），作为 subagent allowlist
  - `thinking` 类型从 `"low"|"medium"|"high"` 改为 `ThinkingLevel`（`"disabled"|"medium"|"high"|"max"`，types.ts:33），修掉现有不一致；存量 md 中的 `low` 值迁移映射为 `medium`
  - 其余字段不变（avatar/avatarColor/description/model/systemPromptMode/systemPromptBody/inheritProjectContext/inheritSkills/tools/skills/mcpServers）
- `agent-md.ts`：
  - `validateAgentConfig` 去掉 4 值枚举校验；name 仅要求非空且为合法文件名字符（禁止 `/\\:*?"<>|`）
  - frontmatter 序列化/解析新增 `triggerKeywords`；`thinking: low` 读取时归一为 `medium`
  - `makeDefaultAgentConfig` 支持任意 name
- 存量 4 个 md 文件原样加载；目录为空时 seed 这 4 个默认 agent（保持新用户体验一致）。
- `constants.ts`：`AGENT_DEFS`/`ALL_AGENT_NAMES` 改为"默认 seed 数据"角色，不再作为运行时白名单。

## 2. Kernel 改动

### 2.1 Agent CRUD（config-store.ts）
- 新增 `createAgent(input): AgentConfig`（生成默认配置 md；重名自动加 `-2`/`-3` 后缀）
- 新增 `deleteAgent(name)`（删除 md 文件；不触碰会话数据）
- 重命名（名称变化）= 旧文件删除 + 新文件写入，同步更新引用它的会话 `primaryAgent` 和其他 agent 的 `partners.askTo`

### 2.2 内置扩展替换（extensions.ts / agent-manager.ts / package.json）
- `extensions.ts:70-74` 内置扩展列表：移除 `pi-intercom`，加入 `@gotgenes/pi-subagents`
- `kernel/package.json`：删除 pi-intercom 依赖，新增 `@gotgenes/pi-subagents`
- `agent-manager.ts` 删除 intercom 会话名设置与 `bindExtensions` intercom 逻辑（约 L390-397）；subagents 扩展随 loader 内置加载

### 2.3 关系网注入与校验（自动委派）
- **delegate customTool**：kernel 注册宿主控制工具 `delegate`（与 memory 工具同机制，经 `createAgentSession customTools` 注入），参数 `{ agent: string, task: string }`。执行时校验 `agent ∈ partners.askTo`，越权直接返回错误文本（不中断会话）；合法时经 `@gotgenes/pi-subagents` 的 typed service API（`getSubagentsService().spawn(agent, task)`）同步调起并返回结果
- 扩展自带的 `subagent` 工具**不放入** SDK 工具 allowlist（`resolveAgentTools` 输出中剔除），LLM 只能走 delegate，allowlist 强制生效
- 构建 SDK session 时（`_createSession`），把 `partners.askTo` 中每个智能体的 名称 + description + triggerKeywords 追加进系统提示词段：
  "你可以通过 delegate 工具调起以下智能体：…；当用户消息涉及某智能体的触发关键词或其简介描述的话题时，优先调起对应智能体。"
- askTo 为空 = 不注册 delegate 工具
- 关键词的命中判断由 LLM 基于提示词自行完成，kernel 不做关键词匹配逻辑

### 2.4 全局工具/技能清单
- 新增 `agent:tools:list`：聚合 DEFAULT_AGENT_TOOLS + 启用扩展工具（extractRuntimeToolNames）+ MCP 工具，返回 `{ name, source }[]`
- 技能清单复用现有 `skill:list`
- 详情弹窗勾选结果写入 `AgentConfig.tools/skills`；`resolveAgentTools` 改为：若 agent.tools 非空则作为 allowlist 过滤全局清单，为空则维持现状（全量默认）

### 2.5 对话中切换智能体
- 新事件 `session:set-agent { sessionId, agentName }`：
  1. 运行中则先 abort
  2. 更新 ProjectStore 的 `primaryAgent`
  3. dispose 当前 AgentSession，用同一 `piSessionFile` + 新 agent 配置 `_createSession`（jsonl 历史自然保留）
  4. 广播 `session:updated { sessionId, primaryAgent }`
- agent 被删除后的会话：打开正常；`agent:prompt` 检测到 primaryAgent 不存在 → 返回错误 `agent_missing`，前端弹出智能体选择器，选定后走 `session:set-agent` 再重发

## 3. WS 协议新增（shared/types.ts）

| 方向 | 消息 | 载荷 |
|---|---|---|
| 前→后 | `agent:list` | → `agents: AgentConfig[]` |
| 前→后 | `agent:create { displayName }` | → `agent: AgentConfig`；非法名报错，重名自动加后缀 |
| 前→后 | `agent:delete { name }` | → `{ ok: true }`；不存在报错 |
| 前→后 | `agent:tools:list` | → `tools: { name, source }[]` |
| 前→后 | `session:set-agent { sessionId, agentName }` | 广播 `session:updated` |
| 后→前 | `session:updated { sessionId, primaryAgent }` | 切换/重选广播 |
| 双向 | `agent:config:get` / `agent:config:save` | 复用现有 |

## 4. 前端 UI

### 4.1 侧边栏智能体区（重构 AgentListSection.tsx，紧凑行）
- 数据源：`agent:list` + 会话数据推导"最近使用"（各 agent 名下会话最大 updatedAt 倒序）取前 3
- 每项（紧凑行）：头像（emoji/渐变，读 `AgentConfig.avatar/avatarColor`，缺省回退默认渐变）+ 名称 + 状态点（沿用 aggregateAgentState）
- 左键 → 当前项目下以该 agent 新建会话（乐观 UI + `agent:prompt` 懒创建，同 NewSessionPane 流程）
- 右键 → 菜单【编辑智能体】【删除】（复用 ProjectItem 右键菜单模式；删除二次确认）
- agent 总数 > 3 时底部显示【更多智能体 (n)】

### 4.2 更多智能体弹窗（新 AgentGalleryModal.tsx）
- 3 列卡片宫格：头像 + 名称 + 两行简介 + 状态点
- 左键卡片 → 新建会话；右键卡片 → 【编辑智能体】【删除】（删除二次确认）
- 右上角【新建智能体】→ 调 `agent:create` 后直接进入详情弹窗；底部操作提示条

### 4.3 智能体详情弹窗（重构 AgentConfig.tsx，4 个 tab）
1. **基本**（单栏滚动，分四段）：
   - 身份：名称（即标识）/ 简介 / 头像 emoji + 渐变选择
   - 模型：模型（默认跟随全局）/ 思考档位（复用 ThinkingSelector：off/mid/high/max）
   - 提示词：systemPromptMode（追加/替换）+ 正文 + inheritProjectContext/inheritSkills
   - 触发条件：关键词 chip 编辑（回车添加、✕ 删除）+ 说明文案（关键词用于其他智能体自动调起本智能体的判定提示；@提及为内置能力）
2. **工具**：从 `agent:tools:list` 勾选（消费 AgentConfig.tools）
3. **技能**：从 `skill:list` 勾选（消费 AgentConfig.skills）
4. **关系网**：顶部搜索框（按名称/简介过滤）+ 勾选列表（头像+名称+简介），自身置灰不可选，写 `partners.askTo`
- 保存走现有 `agent:config:save`

### 4.4 会话视图：切换智能体（SessionView header）
- 顶部 pill 显示当前智能体头像+名称，点击展开下拉：**顶部搜索框**（按名称/简介实时过滤）+ 列表（当前项 ✓）
- 切换前弹确认框："切换智能体后所有缓存都会失效，是否继续？"【取消】【继续切换】；确认后发送 `session:set-agent` → header 即时更新 + 消息列表追加系统分隔行"已切换为 xxx"
- primaryAgent 已删除的会话：顶部 pill 变为警示条"原智能体已删除，点击重选"（重选同样走确认框）

### 4.5 提及符号重定义（ComposerInput.tsx）
- **@ = 智能体**：补全列表（头像+名称+简介），输入即过滤；选中生成 `@[名称]` chip（蓝色）。发送时剥离该 token：新会话 → 设定 primaryAgent；已有会话 → 与顶部切换一致先弹缓存失效确认框，确认后触发 `session:set-agent`；其余文本正常发送。取第一个 @智能体 token 生效
- **# = 文件**：原 `@` 的文件/文件夹搜索迁移到 `#`，token 改为 `#[path]`（绿色 chip）；发送展开为 `#path`
- **$ = 技能**：保持不变
- 兼容：存量消息文本中的 `@path` 不再作为 token 解析（仅纯文本），不迁移历史内容

### 4.6 委托调用卡片（重构 DelegateCard.tsx，接入 delegate 工具）
- 复用现有橙色视觉（`rgba(250,179,135,…)`），数据源从 intercom 参数改为 `delegate` 工具调用（`{ agent, task }`）：
  - **执行中**：↪ 委派给 {头像+名称} + 转圈 + 任务摘要
  - **完成**：结果摘要以绿色左边线展示 + 耗时
  - **可展开**：展开显示子智能体完整回复文本（v1 不含子过程步骤列表——child 会话事件不在父会话消息流中，无数据通道）
- `MessageList.tsx` 为 delegate 工具调用注册专属渲染（不再走普通 ToolCallBlock）
- `DelegateReceived.tsx`（intercom 收信卡片）删除

### 4.7 头像统一
- 渲染统一改用 `AgentConfig.avatar/avatarColor`；`theme/agents.ts` 的 AGENT_DEFS emoji 映射改为按 name 的缺省回退表

## 5. 测试策略（四层）

1. **单元（bun:test）**：
   - agent-md：新字段序列化/解析、枚举放开后的校验、非法文件名字符拒绝、`thinking: low` → `medium` 归一
   - 最近使用排序纯函数（sessions → top3 agent）
   - subagent allowlist 过滤（askTo 越权）
   - 关系网提示词注入内容（名称/简介/triggerKeywords 完整出现在注入段）
   - resolveAgentTools 按 AgentConfig.tools 过滤
   - createAgent 重名加后缀；重命名联动更新会话与 askTo
2. **组件（Vitest + testing-library）**：
   - AgentListSection：前 3 渲染、>3 显示更多入口、右键菜单两项、左键建会话回调
   - AgentGalleryModal：宫格渲染、左右键行为、新建入口
   - AgentConfig 弹窗：4 tab 渲染、关键词 chip 增删、关系网搜索过滤与自身置灰、保存事件载荷、ThinkingSelector 档位
   - SessionView header 切换器：搜索过滤、缓存失效确认框（取消不切换/确认才发 session:set-agent）、删除警示条
   - ComposerInput：@ 智能体补全与 token 剥离、# 文件搜索、$ 技能回归
   - DelegateCard：执行中/完成/展开三态
3. **API 集成**：bun 脚本直连 ws 9776 验证 `agent:list/create/delete/config:save/tools:list/session:set-agent` 正常路径 + 错误路径（非法名 create、delete 不存在、set-agent 到不存在的 agent）
4. **E2E（Playwright）**：新建智能体 → 列表/宫格出现 → 左键建会话发消息 → 编辑关系网与关键词 → 会话中切换智能体（搜索 + 确认框）→ @ 切换 → 删除智能体后会话保留且重选流程可用；finally 清理测试数据与截图

## 6. 影响范围（主要文件）

- shared：`types.ts`、`constants.ts`
- kernel：`agent-md.ts`、`config-store.ts`、`agent-manager.ts`、`extensions.ts`、`ws-server.ts`、`package.json`、新增 agent CRUD 处理
- frontend：`AgentListSection.tsx`、`AgentConfig.tsx`、`SessionView.tsx`、`ComposerInput.tsx`、`Composer.tsx`、`MessageList.tsx`、`DelegateCard.tsx`、`App.tsx`、新增 `AgentGalleryModal.tsx`、store/agents.ts 扩展、删除 `DelegateReceived.tsx`
- 测试：kernel/tests、frontend/tests、frontend/e2e
- CHANGELOG.md 记录

## 7. 不做的事（YAGNI）

- 不做智能体拖拽排序/手动置顶
- 不做跨常驻会话协作（intercom 场景），subagent 调起已覆盖核心需求
- 不做智能体导入导出/市场
- 不做关键词自动切换主智能体（用户明确否决）
- 不做 @多智能体 同条消息同时生效（仅第一个 token 生效）
