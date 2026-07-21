# 变更日志

记录所有业务和代码版本修改。新条目始终添加在顶部（时间倒序）。

---

## 2026-07-21

### 重构
- **系统提示词可配置化组装框架**：把原本硬编码在 `HIAGENT_DEFAULT_SYSTEM_PROMPT` 里的提示词拆成 6 个独立段落（base / delegate-syntax / subagent-clarify / delegate-network / env-constraints / memory-snapshot），新增 `packages/kernel/src/system-prompt.ts` 提供 `composePrompt(segments, ctx)` 纯函数 + `PromptSegment` 类型 + 默认段落常量。**配置来源为 `~/.hiagent/prompts.json`**：用户可调整段落顺序、改写段落内容、删除段落（删掉即关闭）；动态段（base / delegate-network / env-constraints / memory-snapshot）的 content 留空时由运行时 context 填充，写了则覆盖代码默认值。kernel 启动时 `ensurePromptsConfig` 幂等初始化默认配置。所有默认段落文案**改为英文**（原中文委托规则、子智能体澄清等）。`agent-manager._createSession` 的 `systemPromptOverride` 闭包改为调 `composePrompt`，行为与原拼装完全等价（base → delegate → env → memory 顺序不变）。新增 19 个单元测试覆盖组装逻辑、文件 I/O、幂等初始化。影响范围：shared/constants.ts（新增 `PROMPTS_FILE`）、kernel/system-prompt.ts（新）、kernel/index.ts（启动集成）、kernel/agent-manager.ts（拆常量 + 替换 systemPromptOverride）、kernel/tests/system-prompt.test.ts（新）、kernel/tests/agent-manager.test.ts（适配新常量）。

### 新增功能
- **默认工作区虚拟项目**：会话列表新增常驻的「🏠 默认工作区」虚拟项目（`id="__system__"`，`cwd=~/.hiagent/workdir/`），作为"没有具体工程目录时的默认聊天空间"。该项目不可删除/不可改名，与普通项目操作完全一致（新建会话、选智能体、发送）。默认工作区下的每个会话有独立隔离的 pwd（`~/.hiagent/workdir/<session.createdAt>/`），互不干扰；skill/mcp 继承全局配置（无需独立管理）。删除会话保留 `<createdAt>/` 子目录 7 天后由后台 `workdir-cleaner` 自动清理（三重防护：目录名纯数字 + 不被现存 session 引用 + mtime 超 7 天）。UI 上默认工作区显示为侧栏独立"默认"区，会话右键菜单额外有"打开工作目录"，header 显示友好文案而非内部路径。**完全不动数据模型**（不加任何字段，靠 `project.id === SYSTEM_PROJECT_ID` 识别、靠 `session.createdAt` 推导 cwd）。影响范围：shared/constants.ts、shared/pure.ts、shared/types.ts、kernel/index.ts、kernel/project-store.ts、kernel/ws-server.ts、kernel/agent-manager.ts、kernel/workdir-cleaner.ts（新）、kernel/ensure-system-project.ts（新）、frontend/Sidebar.tsx、frontend/ProjectItem.tsx、frontend/ProjectList.tsx、frontend/NewSessionPane.tsx、frontend/SessionView.tsx、frontend/fs-client.ts、frontend/recording/recorder.ts。

### 设计
- **知识库检索功能技术方案调研**：完成 HiAgent 基于知识库检索（RAG）的技术方案文档。分析了五种集成架构（MCP 服务器 / 内核内置 customTools / Pi 扩展 / SaaS 向量数据库 / 混合方案），从内核改动量、用户体验、离线可用性、技术自由度、运维复杂度、数据隐私、开发周期 8 个维度进行对比。**推荐混合方案**（MCP 协议 + 可插拔后端）：第一阶段直接复用 HiAgent 现有 MCP 集成对接现成 RAG 服务器（内核零改动）；第二阶段开发官方 `hiagent-kb-mcp`（Bun + LanceDB + OpenAI Embedding + 本地模型降级），提供 kb_search / kb_index / kb_list_sources / kb_remove 四个 MCP 工具。含完整的嵌入模型对比、向量数据库对比、文档处理流程设计和实施路线图。文档：`docs/research/knowledge-base-retrieval-proposal.md`。
- **Pi 生态知识库插件调研（补充）**：深入调查 Pi 官方扩展市场（pi.dev, 5343 个包），发现 **`pi-knowledge-search`（v1.3.5）已完美覆盖需求**——混合向量+BM25搜索、SQLite FTS5、knowledge_search+kb_read 工具、支持 OpenAI/Ollama/Bedrock 嵌入。另发现 `pi-code-graph`（代码知识图谱 RAG）、`@cad0p/pi-napkin`（知识库集成）、`pi-vault-mind`（LanceDB 向量+FTS）等 6+ 个相关插件。关键发现：HiAgent 已安装的 `@amaster.ai/pi-memory` 底层依赖 `mem0ai`（v3.1.0），支持 20+ 向量数据库但尚未激活。Pi 官方 GitHub Issue #1255 讨论了采纳 OpenClaw Memory/RAG 架构。**推荐方案更新**：从自研 MCP 调整为直接集成 `pi-knowledge-search` 作为 HiAgent 内置 Pi 扩展（1-3天上线），Bun SQLite 不兼容时 MCP 兜底。文档同步更新至 v2。
- **国内 Embeddings 与本地小模型调研**：补充嵌入模型 5.2 节，分为国内 API（智谱 embedding-3 ¥0.5/百万Token、阿里 Qwen3-Embedding-8B MTEB#1 等）和本地小模型（bge-small-zh-v1.5 仅 90MB、bge-m3 2.2GB 等 11 款）。含硬件适配决策树、Ollama 一条命令部署和多级降级推荐策略。
- **知识库检索效果研究报告**：编写详细效果研究报告（`docs/research/knowledge-base-retrieval-effect-report.md`，约 1.3 万字），含端到端体验模拟（agent 对话示例）、三种搜索方式能力矩阵、混合搜索量化提升数据（较纯向量召回率 +17.4%、MRR +41.7%）、RRF 融合算法图解、官方性能 benchmark（500文件搜索 ~250ms）、本地/远程模型性能对比、规模扩展预期、四大使用场景效果预测、与 Cursor/Claude Code 对比矩阵、用户体验量化指标和局限分析。

## 2026-07-20

### 修复
- **历史用户消息中 @[智能体] 渲染为 chip（去 @ 触发符）**：之前 CHANGELOG 声称「MessageList.tsx 用户消息用 textToHtml 渲染 chip（含头像）」实际**未落地**——`MessageList` 用户消息分支只走纯文本 `<p>{displayText}</p>`，`@[项目管理]` 显示为字面字符串。补全：`MessageList` 组件 render 阶段同步调用 `ensureChipStyles()` + 从 `useAgentsStore` 读取并 `registerAgentMeta`（必须在 render 阶段同步注册，确保首次 `textToHtml` 调用时 meta 已就绪）；用户消息用 `textToHtml(text, { hideTrigger: true }) + dangerouslySetInnerHTML` 渲染。新增 `hideTrigger` 选项：展示场景（MessageList）不显示 `@` 触发符（仅显示头像+名称，更干净），输入框场景（ComposerTextarea）保留 `@` 让用户看到触发符——`@` 是输入触发符、不是名称一部分，展示时去掉更符合"像技能一样"（技能 chip 在展示时也不带 `$`）。TDD 红→绿：tokens.test.ts 加 `hideTrigger` 选项测试 + MessageList.test.tsx 加 3 个 chip 渲染测试（含头像/正文共存/自动注册）。影响：frontend(src/quick-invoke/tokens + src/components/MessageList + tests/tokens + tests/MessageList)。
- **委托智能体执行任务后刷新出现空气泡**：截图现象是委托「质量验收」后刷新页面，主智能体下方出现一条只有时间戳没有正文的空气泡。**根因**：`MessageList.tsx` 用 `m.type === "custom"` 判断 custom 消息，但 Pi SDK 内存消息字段是 `m.role === "custom"`（顶层无 type）。委托完成时 `pi-subagents` 注入的 `subagent-notification` 消息（`role:"custom"` + `content:"<task-notification>..."` 字符串）进不去 custom 分支，掉到 assistant 分支；又因 `Array.isArray(string)` 为 false 使 `blocks=[]`，渲染出空气泡。**误导根源**：`shared/types.ts:113` 旧注释「Pi 真实数据里这类消息的区分字段是顶层 type，不是 role」把 JSONL 持久化格式（`type:"custom_message"`）与 SDK 内存格式（`role:"custom"`）混淆了。**修复（TDD 红→绿）**：先在 `MessageList.test.tsx` 加 3 个失败测试（基于真实 session 文件样本：`role:"custom"` + `customType:"subagent-notification"` + content 字符串），确认失败原因正确；再改 `MessageList.tsx` custom 判断兼容 `m.role === "custom"`，并对 `subagent-notification` 直接 return null（内容与 DelegateCard 信息重复）。同步修正 `shared/types.ts` 注释，说明字段来源三种情况（SDK 内存 / 前端构造 / JSONL 持久化）。**调试教训**：第一轮基于代码推理认定「空 assistant 消息过滤不严」，加了 `hasMeaningfulAssistantContent` 共享函数修复——方向错误，已回退。第二轮加诊断日志拿到真实 ws 流量才定位到 `role:"custom"` 字段错位。影响：frontend(src/components/MessageList + tests/MessageList) + shared(src/types 注释修正)。

### 新增
- **消息列表中 @[智能体] chip 渲染 + 按钮选择器自适应 + 输入框 chip 样式优化**：
  - `tokents.ts` 新增 `registerAgentMeta` 全局注册表 + `ensureChipStyles` 导出，`textToHtml` 渲染时查找智能体头像/颜色信息
  - `ComposerTextarea.tsx` 从 `tokens.ts` 导入 `ensureChipStyles`，移除本地重复定义；chip 样式使用 CSS 变量替代硬编码、`padding` 从 `1px 6px` 调为 `2px 7px`、新增 `.chip-agent-avatar` 头像样式
  - `ComposerInput.tsx` `handleSelect` 选中智能体时调用 `registerAgentMeta` 注册头像信息
  - `AgentDropdown.tsx` 按钮加 `min-w-0` 防止换行，智能体名称加 `max-w-[180px] truncate` 截断
  - `MessageList.tsx` 用户消息用 `textToHtml` + `dangerouslySetInnerHTML` 渲染 chip（含头像）；助手 markdown 消息新增 `TokenizedMarkdown` 组件按 segment 拆分渲染 chip；加载时注册全部智能体头像信息
  - 影响：frontend(lib/quick-invoke/tokens + components/ui/{ComposerInput,ComposerTextarea,AgentDropdown} + components/MessageList)
- **askTo 非空时同时注册 fleet 工具 + buildDelegatePrompt 补充 fleet 使用说明（Task 2.3）**：`agent-manager.ts:27` import 加 `makeFleetTool`；`delegateTools` 数组在 askToConfigs 非空时除 `makeDelegateTool` 外再追加 `makeFleetTool`（同样绑定 askToConfigs + spawnViaSubagentsService）。`delegate-tool.ts:buildDelegatePrompt` 末尾追加一行 fleet 使用说明（参数 tasks、并发上限 6、适用场景、task 仍按任务合约范式）。Phase 2（B3 并行委托）收口。TDD：扩展现有两个测试——`agent-manager.test.ts` 的 askTo 非空用例断言 `names` 同时含 delegate 和 fleet、askTo 为空用例断言两者都不注册；`delegate-tool.test.ts` 的 buildDelegatePrompt 用例追加 `toContain("fleet")` 和 `toContain("并行")` 断言。影响：kernel(src/agent-manager + src/delegate-tool + tests/agent-manager + tests/delegate-tool)。

### 重构
- **Composer 发送路径不剥离 @[xxx] + 删除切换确认框 + 删除 extractAgentToken（Task 1.4）**：`Composer.tsx` `handleSend` 改为直接 `expandTokens(text)` 原样发送（不再调用 `extractAgentToken` 剥离 `@[xxx]`），由 Task 1.2 加的 `HIAGENT_DEFAULT_SYSTEM_PROMPT` 规则触发主智能体 delegate。同步删除 `pendingMention` state、`handleMentionConfirm` 函数、整段确认框 `<Modal data-testid="mention-confirm">` 及 `Modal` import（Composer 内已无其他消费者）。`tokens.ts` 删除 `extractAgentToken` 函数定义（改造后 Composer 无引用），同步更新 line 4/25 注释为「原样保留给主智能体识别」。TDD：Composer.test.tsx 原「@提及其他智能体」测试断言改为「不弹确认框、不发 set-agent、agent:prompt text 原样保留 @[pm]」；删除「取消确认框」「@提及当前智能体」两个不再适用的测试。tokens.test.ts 删除 3 个 `extractAgentToken` 测试 + 移除 import；line 23 测试描述更新。**已知衔接问题**：`NewSessionPane.tsx:9,96` 仍 import+调用 `extractAgentToken`（Task 1.5 范围），导致 frontend 全量 build/test 出现 `SyntaxError: Export named 'extractAgentToken' not found`——Task 1.5 完成后即恢复 green。影响：frontend(src/components/Composer + src/quick-invoke/tokens + tests/Composer.test + tests/tokens.test)。

### 新增
- **前端 @ 候选菜单只显示当前主智能体 partners.askTo 名单内（Task 1.3）**：`ComposerInput` 新增 `currentAgentName?: string` prop，`agentItems` 过滤逻辑从「显示 allAgents」收紧为「只显示 currentAgentName 对应 AgentConfig.partners.askTo 名单内、且排除自身」。`Composer.tsx` 传 `currentAgentName={agentName}`，`NewSessionPane.tsx` 传 `currentAgentName={agentName ?? undefined}`（agentName state 可能为 null）。从源头杜绝 @ 越权（用户无法在菜单里选到主智能体未授权 askTo 的智能体）。TDD：新增 `ComposerInput @ 候选菜单过滤` describe（2 用例：askTo 名单过滤 + askTo 为空），同步适配 2 个既有 ComposerInput 测试为新契约。影响：frontend(src/components/ui/ComposerInput + Composer + NewSessionPane + tests/ComposerInput.test)。

- **HIAGENT_DEFAULT_SYSTEM_PROMPT 加 @[agentName] 委托规则 + 拼装顺序重组（Task 1.2）**：默认系统提示词常量 export 并追加「## 智能体显式委托语法（@[agentName]）」段（硬规则：必须调 delegate、task 按 Context/Request/Output format/Constraints/Pause policy 任务合约范式组织、列表外询问用户、结果重新组织回复）。`systemPromptOverride` 拼装顺序从 `base+env+memory+delegatePrompt` 重组为 `base+delegatePrompt+env+memory`（delegatePrompt 紧跟 base、记忆快照放最后贴近用户消息）。影响：kernel(`agent-manager.ts` 导出常量 + 拼装顺序 + tests 加 2 个新用例 + 1 个既有用例断言收紧为 buildDelegatePrompt 段特有 marker「你可以通过 delegate 工具」)。

### 重构
- **彻底移除 AgentConfig.name 字段，displayName 成为唯一标识符**：原 `name`（如 "dev"）是内部主键（文件名、session.primaryAgent、partners 引用、WS 协议），`displayName`（如 "技术实现"）仅作展示——两者语义重叠且 name 对用户无意义。现合并为单一 `displayName`：文件名 `${displayName}.md`、session 外键、partners 引用、AGENT_DEFS 索引全部用 displayName。编辑智能体弹窗改为编辑 displayName（原编辑的是 name）。kernel 启动时一次性迁移旧数据（`migrateNameToDisplayName`）：把旧格式 .md（含 name 字段、文件名用内部 name）重命名为 displayName.md、清理 frontmatter、同步 projects.json。影响：shared(types/constants) + kernel(agent-md/config-store/ws-server/agent-manager/index) + frontend(store + 全组件) + 测试/E2E。

### 设计
- **@ 智能体语义改造 spec 立项**：把 `@其他智能体` 从「切换当前会话主智能体」改为「软触发主智能体调 delegate 工具委托子智能体」，主智能体不再被永久改写。核心决策：① 规则加到 `HIAGENT_DEFAULT_SYSTEM_PROMPT`；② `@[xxx]` 原样发给主智能体识别（不剥离）；③ @ 候选菜单只显示 `partners.askTo` 名单内；④ 系统提示词拼装顺序重组为 `base(含@[agentName]规则) + delegatePrompt + 环境约束 + 记忆快照`；⑤ task 参数按 Task Contract 范式总结（参考 DeepSeek-Reasonix）。同期纳入 B3 并行委托 fleet + C5 进度租约 + A2 final answer 语义验证三项优化。spec 文档：`docs/superpowers/specs/2026-07-20-at-mention-delegate-design.md`。
- **pi-dynamic-workflows 评估 + Pi 扩展复用原则确立**：补登记前期调研遗漏（pi-dynamic-workflows 不在 2026-07-08 委托扩展对照表内）。结论：它是「交互类」扩展（slash command + TUI + keyword trigger + `~/.pi/workflows/` 状态），HiAgent UI 不暴露 Pi CLI 交互层，**不可直接用**。与「底层服务类」@gotgenes/pi-subagents 本质不同（后者有 typed service API 可借）。确立复用原则：**HiAgent 只复用工具类/底层服务类 Pi 扩展，不复用交互类**。后期多智能体编排走自研路线（基于 delegate + B3 fleet + partners 关系网，借鉴 pi-dynamic-workflows 的 parallel/pipeline/verify/resume 设计但不依赖）。调研文档：`docs/research/pi-dynamic-workflows-evaluation.md`。

### 变更
- **新建会话页智能体选择改用带搜索的下拉组件，默认选中最近使用的智能体**：原 NewSessionPane 用原生 `<select>` 选智能体、默认取列表第一项；现改为复用聊天顶部同款 pill + 搜索下拉（抽取共享组件 `AgentDropdown`），并默认选中"名下会话 lastActivity 最大"的智能体（复用 `topAgentsByRecency`，无历史时回退列表第一项）。同时抽取 `AgentMenuItem`，让 `AgentDropdown` 列表项与 `@ 智能体` 弹窗（QuickInvokeMenu agent 分支）共用同一行渲染，视觉完全一致。AgentSwitcher 改为内部复用 `AgentDropdown`（外层包缓存失效确认框），行为不变。TDD：AgentDropdown/AgentMenuItem 各新增组件测试先行（红→绿），NewSessionPane 新增 recency 默认值测试，App/NewSessionPane/ComposerInput 等既有测试同步更新为 pill 按钮 UI 契约（textContent 取代 select.value），E2E 同步改 toContainText。影响：frontend(components/ui/AgentDropdown + AgentMenuItem 新建；AgentSwitcher + NewSessionPane + ui/QuickInvokeMenu 重构；tests/ + e2e/ 同步)。

## 2026-07-19

### 新增
- **多智能体矩阵重写（Task 1-18 汇总）**：
  - 智能体放开为可增删改查的动态实体：名称即标识，存于 `~/.hiagent/agents/*.md`；空目录自动 seed 4 个默认智能体；侧边栏空态提供内联【新增智能体】入口。
  - 侧边栏智能体管理区：最近使用前 3 + 右键编辑/删除（二次确认）+【更多智能体】宫格弹窗（支持新建智能体）。
  - 智能体详情弹窗 4 tab：基本（身份/模型/提示词/触发条件）、工具、技能、关系网（带搜索）。
  - 对话中切换智能体：顶部 pill 带搜索、缓存失效确认框、「已切换为」分隔行；agent_missing 时弹重选弹窗（AgentMissingModal）恢复。
  - 提及符号：`@` 智能体 / `#` 文件 / `$` 技能。
  - 关系网调起：delegate 工具（allowlist 由宿主强制）经 `@gotgenes/pi-subagents` 调起子智能体，消息流内联委托卡片（DelegateCard）展示执行中/完成/失败三态。
  - 内置扩展 pi-intercom 替换为 `@gotgenes/pi-subagents`。
  - 配套 Playwright E2E（`e2e/agents.spec.ts` 7 条串行连贯用例覆盖关键链路）与 WS 端口偏移基建（`HIAGENT_E2E_WS_PORT`，默认 9776 零回归，隔离 E2E kernel 防污染真实数据）。

### 修复
- **agent:config:save 非改名路径补 `agent:list` 广播**（原仅改名路径广播，列表不即时刷新）；**session:set-agent 校验智能体存在性**（不存在返回 agent_missing）。

影响范围：shared（类型/常量）、kernel（agent-md/config-store/ws-server/agent-manager/delegate-tool/extensions）、frontend（侧边栏/宫格/详情弹窗/切换器/Composer/DelegateCard/AgentMissingModal）、desktop、e2e。

---

## 2026-07-17

### 修复
- **动态插件升级点击后无反馈（卡一下直接成功）**：升级流程前后端均缺反馈机制——前端 `upgradePackage` 只发消息无 loading 状态，kernel `extension:upgrade` 不传 `onProgress`，升级期间 `applyProgress` 因无对应占位条目而丢弃进度、按钮无任何变化，直到 `extension:changed` 刷新版本号才「突然成功」。修复：(1) 前端 extensions store 新增 `upgrading` 状态，`upgradePackage` 标记升级中、`applyProgress` 更新升级进度、`setAll`(changed)/`setError` 清除标记；(2) `ExtensionSection` 升级中按钮变「⟳ 升级中…」并禁用防重复点击，卡片显示流式进度行；(3) kernel `npm-package-service.upgrade`/`extension-manager.upgrade` 增加 `onProgress` 透传，`ws-server` 升级期间流式推 `extension:progress`、成功后 reply `extension:changed`（与安装链路一致）。TDD 全程红绿：9 个新测试先行（前端 store 4 + 组件 2 + kernel npm-pkg/manager/ws 3），全绿；stash 基线对比确认未引入新 fail（frontend 9/kernel 4 均为既有）。影响：frontend(store/extensions.ts + components/settings/ExtensionSection.tsx + tests)；kernel(npm-package-service.ts + extension-manager.ts + ws-server.ts + tests)。
- **未配置任何模型也能发出消息**：根因是发送闸门的判定依据错误——"当前模型"是 IndexedDB 持久化的快照（`composer-prefs`），provider 被删除后残留的过期 model 字符串仍非 null，而所有闸门只查 `model !== null`：`ComposerInput.canSend`、`Composer.handleSend`、`NewSessionPane.handleSend`、`MessageList` 重发全部放行 → 乐观 UI 上屏、kernel 创建会话后 `resolveModel` 才报错。修复：shared 新增纯函数 `isModelAvailable(model, providers)`（与 ModelSelector/kernel `slugifyProviders` 同一 slug 派生规则，类型谓词收窄 model 为 string），四处闸门统一改为"model 必须真实存在于当前 providers"；重发拦截点放在裁剪消息之前，避免消息被裁却发不出去。TDD：7 个 shared 单测 + 2 个 ComposerInput 组件测试先行（红→绿），新增 Composer/MessageList 回归测试各 1 例；既有夹具中编码旧语义的 bare model 全部补全 slug/id + provider；全量 859 pass（fail 数与基线一致）；Playwright E2E 闭环：残留 model + 空 providers 按钮禁用 → 添加 provider 按钮恢复可用 → 删除 provider 重新禁用。影响：shared(providers.ts)、frontend(ComposerInput.tsx + Composer.tsx + NewSessionPane.tsx + MessageList.tsx + 4 个测试文件)。

### 新增
- **@ 文件选择支持文件夹**：`@` 快速唤起菜单现在同时展示文件和文件夹，并以 📁/📄 图标区分类型。后端 `searchFiles` 本已返回 `isDir` 字段，前端此前未使用该字段统一显示 📄 图标；现已将 `isDir` 传递至 `MenuItem`，由 `QuickInvokeMenu` 按类型切换图标。选中文件夹后生成 `@[文件夹路径]` chip token，与文件行为一致。影响：frontend(`QuickInvokeMenu.tsx` + `ComposerInput.tsx` + tests)。

### 修复
- **agent 启动失败（如 No API key）后会话永远卡「思考中」且无法停止**：根因是前端 `optimisticSend` 把会话置 thinking 后，kernel `agent:prompt` 失败只广播 `{type:"error"}`，App.tsx 的 error 分支仅追加红色错误消息、从不复位状态；agent 从未启动也就永远不会有 `agent_end`，status 卡 thinking → 停止按钮发 `agent:abort` 对未 streaming 的会话是 no-op，死循环。修复：session store 新增 `failTurn(sessionId)`（status→idle、清 streaming 占位/thinkingSince/optimisticEcho），App.tsx 收到可路由到会话的 error 时先调用再注入错误消息。验证：store 单测 2 例 + App error 事件测试 1 例（23/23 通过）；集成测试（隔离 kernel + WS 客户端发 deepseek/deepseek-v4-pro 无 key 的 prompt，断言广播带 sessionId 的 error）；Playwright 真实浏览器 E2E——修复前复现「思考中」卡死，修复后错误 banner 显示、状态归「空闲」、停止按钮消失。影响：frontend(store/session.ts + App.tsx + tests/store-session.test.ts + tests/App-error-prefix.test.tsx)。

### 修复
- **打包后发送消息报「agent 启动失败: undefined is not an object (evaluating 'modelRuntime.getModels')」**：根因是 `resolveModel()` 用 `import.meta.resolve` 深层 import SDK 的 `dist/core/model-resolver.js`——bundle 内 SDK 为 0.80.6（工作区 lock），而打包后该 hack 在运行时解析到首启安装的外部 node_modules 版本（`^0.80.0` 实际装了 0.80.10）；0.80.10 已将 `resolveCliModel` 入参从 `modelRegistry` 改为 `modelRuntime`，版本错配导致 `undefined.getModels()`。修复：`resolveModel` 改为从包根动态 import（0.80.6 起包根已导出 `resolveCliModel`），bun build 会将其 bundle 进 kernel.js，与 `ModelRegistry` 同源同版本，彻底消除 bundle 内外 ABI 混用。验证：0.80.10 model-resolver + 旧入参复现原报错；typecheck 通过；agent-manager 43/43、kernel 全量 328 pass（1 fail 为改动前既有 ws-server abort 用例）；bundle 产物确认 model-resolver 已内联、无 `resolverUrl` 运行时文件系统解析。影响：kernel(agent-manager.ts)。

### 修复
- **Quick Invoke 菜单（@附件 / $技能选择器）过窄 + 键盘导航不自动滚动**：菜单固定 `w-[400px]` 过窄，且键盘上下移动高亮项超出可视区时不跟随滚动。修复：`QuickInvokeMenu` 加宽至 `w-[560px]`（`max-w-[calc(100vw-2rem)]` 防小屏溢出），最大高度 320px，列表项改为圆角卡片 + 图标徽标 + 内边距美化，来源标签改小号胶囊；新增 `highlightedRef` + `useEffect`，高亮变化时 `scrollIntoView({ block: "nearest" })` 自动滚入视野。TDD：2 个组件测试先行（宽度断言 + scrollIntoView 调用），E2E 新增「30 文件列表 ArrowDown×20 高亮项始终在可视区 + 菜单宽度 ≥540px」用例。影响：frontend(QuickInvokeMenu.tsx + tests/QuickInvokeMenu.test.tsx + e2e/quick-invoke.spec.ts)。
- **quick-invoke E2E 整体不可用（4 个既有缺陷，自 d4f0482 起从未全绿）**：(1) `wsSend` 辅助函数 `await new Promise` 写在 `ws.send` 之前，等待响应型调用死锁必超时（send 永远执行不到）——改为先 send 再 await；(2) `enterSession` 不选项目，新会话默认挂到 seed 项目 e2e-proj-1，@ 文件搜索搜错目录——进入新建页先 `project-select` 选中 beforeEach 创建的项目；(3) `$` 技能断言过期：期望展开为 `$技能名`，但 `expandTokens` 既定行为是 `/skill:技能名`（SDK _expandSkillCommand 识别）——按实现修正断言；(4) Esc 用例过滤词 `brain` 依赖内置技能 brainstorming，E2E 隔离 HIAGENT_DIR 无内置技能导致列表为空、Esc 拦截前提（menuItems>0）不成立——改用动态添加的 e2e-esc-skill 并等列表出现再按 Esc；(5) Backspace 用例光标在尾随空格后，一次 Backspace 只删空格——显式把光标移到 chip 节点正后方再删。修复后 5/5 全绿。影响：frontend(e2e/quick-invoke.spec.ts)。

### 修复
- **记忆页「自动学习」「注入提示」开关失效（摆设）**：MemoryPage 两个 toggle 只写 `hermes-memory-config.json`，kernel 注入链路无任何消费点——`buildMemorySnapshot` 与 `createAgentMemoryTools` 均不读配置，关闭后照样注入快照、照样注册记忆工具。修复：`AgentManagerOpts` 新增可选 `memoryStore`（结构化 `getConfig` 依赖，可空=全开兼容测试），`_createSession` 建会话前读配置：`memoryPolicyStyle=none` → 不拼接记忆快照，`reviewEnabled=false` → 不注册 memory_add/replace/remove/read 工具；生产链路 index.ts 注入真实 MemoryStore。TDD：2 个失败测试先行（关自动学习无记忆工具、关注入提示词不追加快照），实现后 43/43 通过。影响：kernel(agent-manager.ts + index.ts + tests/agent-manager.test.ts)。

### 修复
- **Plugin 技能描述显示为 "|"（看似无描述）**：`parseSkillFrontmatter` 用单行正则提取 `description`，遇 SKILL.md 使用 YAML 块标量（`description: |` / `>-`，如 context-mode 扩展包的 ctx-index 等 8 个技能）时把指示符 `|` 误当描述值。现支持块标量解析：收集后续缩进行拼成单行描述。影响：kernel(skill-utils.ts + tests/skill-utils.test.ts)。
- **大文件上传超时（>12MB 文件必失败）**：两个缺陷叠加 — (1) kernel WebSocket 配置用错了参数名 `maxPayloadSize`（Bun 正确参数为 `maxPayloadLength`），导致默认 16MB 限制未放宽，base64 编码后 >16MB 的消息被 Bun 静默丢弃，后端收不到；(2) 前端 `getWs()` 创建 WebSocket 后永不重建，连接断开后所有消息排队等待永不到来的 `open` 事件。修复：`maxPayloadSize` → `maxPayloadLength` 并设为 80MB（覆盖 50MB 文件上传上限 + base64 膨胀）；`getWs()` 检测 `CLOSED`/`CLOSING` 状态时自动创建新连接。影响：kernel(ws-server.ts) + frontend(ws-instance.ts)。
- **会话页顶部状态 + 侧边栏 agent 状态点永远显示「空闲/idle」**：两处状态均取自 agents store 全局聚合（`getGlobalState`），但 WS 协议无 agent 状态推送事件、kernel 从不推送、前端从不写入，`states` 永远为空导致恒为 `idle`（死路径，自该功能上线即存在）。修复：会话页 header 改用活的会话级状态 `statusBySession`（由 sdk:event 流真实驱动）并加 `AGENT_STATE_LABEL` 中文映射（空闲/思考中/等待回复），不再暴露英文枚举；header 圆点从硬编码 `bg-success` 改为 `STATUS_COLORS[状态]` 内联样式随状态变色；侧边栏 `AgentListSection` 状态点改为按「名下所有会话的活状态」派生（任一会话有待回答提问 → blocked 橙，否则任一会话运行中 → thinking 靛蓝，否则 idle），复用 shared `aggregateAgentState` 聚合。**调色板调整**：`STATUS_COLORS.idle` 由次要灰 `#A1A1A6` 改为成功绿 `#34A853`（空闲=正常在线语义，header 与侧边栏全局统一）。清理孤立的 `states`/`setState`/`getGlobalState`（agents store 仅保留活的 `configs`）及其测试。新增 5 个组件测试锁定文案与状态点颜色。影响：frontend(SessionView.tsx + AgentListSection.tsx + store/agents.ts + theme/colors.ts + tests/SessionView/AgentListSection/AgentConfig/Sidebar/theme，删 store-agents.test.ts)。
- **业务校验错误崩掉整个 kernel 进程**：WS `message` 处理器 `await this.handle(event, reply)` 无 try/catch，任一 case 抛错（如同目录重复创建项目 `project-store.ts` 抛「相同目录的项目已存在」）即成为未捕获 rejection，Bun 直接退出进程。修复：dispatch 边界统一加 try/catch 兜底，捕获后广播 `{type:"error"}` 事件由前端 toast 展示，kernel 不再退出。新增回归测试「project:create 重复目录返回 error 事件且 kernel 不崩溃」。影响：kernel(ws-server.ts + tests/ws-server.test.ts)。

## 2026-07-16

### 新增
- **Quick Invoke 聊天栏快速调用**：输入 `@` 触发文件选择面板（选中文件以橙色 chip 内联插入，发送时展开为 `@相对路径`）；输入 `$` 触发技能选择面板（靛蓝 chip → `$技能名`）。新增 `ComposerTextarea`（原生 textarea → contenteditable，半受控光标）与 `QuickInvokeMenu` 组件；extension-manager 新增 `getEnabledExtensionSkillPaths()` 自动发现已启用扩展包中的 skills/；`SkillInfo` 加 `source`（builtin/user/extension）字段；提取 `skill-utils` 共享模块供 extension-manager 与 skill-manager 复用，`scan()` 支持 builtin + user + extension 三类来源。
  - 影响：shared(skills.ts)；kernel(skill-utils 新建 + skill-manager/extension-manager/ws-server/agent-manager)；frontend(quick-invoke/ 新建 + ComposerTextarea/QuickInvokeMenu 新建 + ComposerInput/Composer 改造)
- **模型供应商预设快捷选择**：feat: 模型供应商新增「快捷选择」预设下拉。添加 / 编辑供应商表单顶部内置 10 条主流供应商预设（智谱 GLM 标准 / GLM 编程计划 / DeepSeek / 月之暗面 Kimi / Anthropic Claude / OpenAI GPT / 阿里通义 Qwen / 火山豆包 / OpenRouter / 阿里云百炼编程计划）。选中后自动填入名称、Base URL、协议类型与模型列表（含上下文窗口 / 最大输出 / 是否视觉），apiKey 仍需手动填；所有字段填入后仍可编辑。计划类（独立端点）预设带 🏷 前缀并显示 Key 要求 / 合规提示。

### 修复
- **新会话发送后白屏 + 连续发送队列面板即时显示**：kernel 创建 session 后立即经 `reply({ type: "session:echo_user" })` 回传用户消息（不等耗时 5-10s 的 `ensureStarted`），前端 `App.tsx` 收到调 `optimisticSend` 秒显示（`NewSessionPane` 仅 `addSession` 导航，不重复调）。kernel `_promptLocks` session 级串行锁防并发竞态。**连续发送排队**：`Composer` 在 agent 运行中发送时调 `appendLocalFollowUp` 立即追加文本到本地 `queueBySession.followUp`，顶部队列面板秒显排队消息；后续 kernel `queue_update` 回声覆盖为权威列表。影响：frontend(session.ts appendLocalFollowUp + Composer.tsx)。
- **停止/队列按钮无响应 + 清空竞态**：① `ensureStarted` 期间 SDK session 未注册导致按钮静默失败 → `createFn()` 后立即注册到 map，提前可用。② session 未就绪时 `historyLoading=true`，清空按钮置灰禁用。③ 清空队列时先发 `agent:abort` 中断当前 agent，再 `steer:clear-queue` 清空，避免 agent 刚从队列取出下一条消息时清空操作无效导致前端与 kernel 状态不一致。影响：kernel(agent-manager.ts) + frontend(SessionView.tsx)。
- **会话列表时间不更新**：`lastActivity` 原仅在 `agent:prompt` 更新，agent 回复完成不更新。现 `message_end` 事件也调 `touchSession`，会话列表时间反映最后一次活动（含 agent 回复）。影响：kernel(index.ts)。

### 变更
- **思考过程合并 + 工具调用分组折叠**：同一 assistant 消息中多个连续 thinking block 合并为一个折叠面板；流式思考时按钮显示 spinner +「努力思考中…」，完成恢复「💭 思考过程 已完成」；同一消息工具调用合并为「🔧 工具调用记录 (N)」折叠面板（含成功/失败/待执行计数摘要），展开后单项可独立再展开。两层折叠：分组 → 单项详情。影响：frontend(MessageList.tsx 新增 ToolCallGroup + ThinkingBlock isStreaming prop)。

---

## 2026-07-15

### 重构
- **MCP 连接器改用直连 MCP SDK**：连接测试/查看工具/清除授权原拉起临时 Pi agent session 发 `/mcp reconnect` 等斜杠命令，但扩展命令经 `pi.sendMessage()` 自管理、`prompt()` 立即 resolve 且不产生事件 → 前端永远等不到结果（30s 超时「无反应」）。新增 `mcp-connector.ts` 用 `@modelcontextprotocol/sdk` 的 `Client` + Stdio/HTTP transport 直连，握手后列举工具（与 pi-mcp-adapter 内部 `McpServerManager.createConnection` 同逻辑，不深导入以免重依赖进内核 bundle）。`McpTestResult` 新增 `status`（connected/needs_auth/error/disconnected）与 `toolCount`；`mcp:listTools` 改为实时连接列举（原读 mcp-cache.json 几乎总空）。设计上：配置管理 + 连接测试归内核，MCP 工具运行时仍由 pi-mcp-adapter 在 agent 会话内承载。
  - 影响：kernel(mcp-connector.ts 新建 + ws-server/mcp-store/tsconfig)；shared(mcp.ts)；frontend(store/mcp + McpPage/McpCard)

### 修复
- **HTTP MCP 服务器连接测试报 Zod invalid_union**：`mcp-connector.ts` 的 url 分支 `new StreamableHTTPClientTransport(url)` 丢了 `config.headers` → 需鉴权 HTTP MCP（如智谱 web-reader/web-search-prime/zread）收不到 Authorization 头，返回非 JSON-RPC 错误信封 → SDK `JSONRPCMessageSchema.parse` 抛 Zod。修复：url 分支经 `requestInit.headers` 透传；新增 `isJsonRpcSchemaError` 识别校验失败返回可读提示替代原始 Zod JSON。
- **已连接 MCP 服务器保留「连接测试」按钮**：`McpCard` 原在 connected 时隐藏该按钮，现始终显示（测试中禁用），可随时重测。

### 新增
- **切换 MCP 项目作用域后自动连接测试**：作用域列表加载完成后自动对每个服务器逐个发起 `mcp:test`，卡片即时显示连通状态；用 `autoTestedProject` 记账避免重复自动测试；`testingServer`（单槽位）重构为 `testingServers`（Record）支持并行测试。
- **新增/编辑 MCP 服务器改为模态弹窗**：原页面内联常驻表单改为居中 `McpFormModal`（复用 Modal，支持遮罩/✕/ESC 关闭，编辑预填）。
- **查看工具加载过渡**：首次 `mcp:listTools` 时弹窗显示 loading 而非误导性的空态；新增 per-server `loadingTools` 标记。

---

## 2026-07-14

### 修复
- **动态插件工具自动发现**：`extractRuntimeToolNames` 读取 SDK 结构错误（`runtime.tools` 不存在；每个扩展独立持有 `.tools` Map），改为遍历 `getExtensions().extensions[].tools` + 兜底 `getAllTools()`；`resolveAgentTools` 新增 `harvestedTools` 参数合并动态发现的工具进 allowlist（去重）。解决「装了 pi-hypa 但 agent 看不到 hypa_* 工具」。
- **SDK 自动发现冲突**：SDK 的 `SettingsManager.getPackages()` 读 `settings.json.packages` 自动安装到 `~/.hiagent/npm/`，与 HiAgent 经 `additionalExtensionPaths` 注入产生双重加载 → 工具注册冲突。改用自有字段 `hiagent_packages`/`hiagent_disabledPackages`（SDK 不读），首次读取时自动迁移旧字段并删除。扩展加载改为单轨（仅 additionalExtensionPaths）。
- **包管理器鲁棒性**：`Bun.spawn(["bun",...])` 在 desktop 下 PATH 不含 bun → ENOENT，改用 `process.execPath`；`bun remove` 在无 package.json 时报错 → 构造函数自动创建；`uninstall` 检查 node_modules 存在性。
- **Dev 模式运行时包解析**：dev 模式下 `require.resolve` 从 repo 解析找不到 `~/.hiagent/runtime/node_modules/` 动态包，新增 `runtimeRequire` 兜底。
- 影响：shared(constants.ts)；kernel(extensions.ts/extension-manager.ts/agent-manager.ts/npm-package-service.ts)

---

## 2026-07-13

### 新增
- **动态插件系统**：设置面板支持安装/卸载/升级/启用/禁用 npm 插件；扩展加载双轨制（核心扩展走 additionalExtensionPaths，动态插件走 packages 字段）；移除 OPTIONAL_EXTENSIONS 硬编码与 migrateSettingsPackages()。新增 `npm-package-service.ts`。影响：kernel(extension-manager/extensions/index/ws-server)、shared、frontend(ExtensionSection/store/extensions)。

### 重构
- **桌面 shell 从 tray-binary 迁到 Electron**：为录音系统声音（spec B）铺基座。Electron main（单实例锁 + BrowserWindow + 生命周期 + 托盘）+ kernel 解释 sidecar（`bun.exe run kernel.js` + node_modules，放 resources/kernel/；编译 exe 已证伪——pi SDK jiti 撞 bun compile 虚拟 FS → agent 创建挂）+ electron-builder 打包。前端零改动（BrowserWindow load 9776）。**录音系统声音 Win 真机 POC 已过**（`setDisplayMediaRequestHandler` + `audio:'loopback'` 去框抓系统声音）。影响：packages/desktop 整体改写为 Electron。已知：Win 首启 Defender 扫未签名 exe 要数分钟（代码签名=后续）；macOS=phase 2。

---

## 2026-07-12

### 重构
- **桌面分发定为文件夹模型**：实测「编译单 exe」路线 agent 创建失败——pi SDK jiti 在编译二进制里把 `require("pi-intercom/package.json")` 解析到 bun compile 虚拟 FS 而非磁盘 node_modules（磁盘回退不覆盖 jiti 解析器）。改用文件夹模型：launcher exe + `bun.exe` + `kernel.js`（`bun build src/desktop-server.ts --target bun` 打包 2923 模块为 12MB JS bundle，解释运行）+ `node_modules`（`bun install --production` 装 506 包，排除已内联的 workspace 包）+ `web/`；解释运行时 jiti 正常从磁盘解析（根治 `Cannot find module`）。构建管线：测试钩子 → vite build → genicon → 物化 traybin + 嵌入清单 → 构建 kernel.js → 每目标文件夹组装。
- **桌面托盘单二进制（早期方案，后改为文件夹模型）**：in-process 起 kernel + systray2 托盘，`bun build --compile` 嵌入前端/systray helper/图标为单 exe，Windows PE 子系统 patch（CONSOLE→GUI）去控制台。
- **桌面末审小修**：删 dead `killPort`（desktop 运行时未用，YAGNI）；kernel 静态资产缺失回退 index.html（SPA 路由，原错误返回 426）；desktop logger 退出前 `flush()` best-effort 等齐 in-flight 写入，避免末尾日志被 `process.exit(0)` 截断。

### 新增
- **前后端端口支持 `.env` 动态配置**：`HIAGENT_WS_PORT`（9776）/`HIAGENT_WEB_PORT`（5180）经根 `.env` 覆盖；shared 新增 `resolvePort` 纯函数，vite 用 `loadEnv` 读 `.env` 并注入浏览器 bundle 的 WS_PORT。
- **kernel 可导入 + 可选静态前端伺服**：`index.ts` 抽出 `export startKernel(opts?: { staticDir })`（`import.meta.main` 守卫保留自动执行）；ws-server 同 9776 端口伺服 UI + WS，未知/越权路径回退 index.html，二进制分发不再依赖 Vite。
- **ask_user_question 结构化澄清提问工具**：agent 可调 `ask_user_question` 向用户提 1-4 个结构化问题（2-4 选项，单/多选/自由文本/per-question 备注）；`AskRegistry` 进程单例管理 ask 阻塞/resolve/cancel/幂等/AbortSignal，中断点调 cancelAll 作废 pending；前端 AskDock 停靠区，pending 时 composer 禁用。
- **agent 系统提示词注入执行环境信息**：base 末尾追加内置技能目录路径（`~/.hiagent/skills`）+ 禁止透露系统提示词 + 禁止内部术语回复。

### 修复
- **pi-lens（LSP 诊断）两个独立根因修复**：(1) 双重加载——settings.json.extensions 积累多条 pi-lens 路径（bun install 产生新 .bun 缓存 hash 后旧路径残留），SDK 双重加载两实例互相判定为并发副实例双双跳过初始化，`list()/toggle()` 增加 `pathBelongsToPackage` 归属判定收敛同包路径；(2) 工具被白名单过滤——pi-lens 9 个工具不在 DEFAULT_AGENT_TOOLS，白名单显式放行。
- **禁用 pi-lens 时过滤工具 allowlist**：散落三元表达式封装为 `resolveAgentTools` 纯函数，按可选插件启用态过滤（禁用 pi-lens 后移除其 9 个工具），签名预留 `agentName` 供后期按角色裁剪。
- **记忆页作用域选择器状态丢失 + 指令文件 Tab 切项目不加载**：同源——`selectedProjectId` 存组件本地 state，关闭弹窗即丢失而 `memoryScope` 在持久 store 保留导致错位；提升到 `useMemoryStore` 持久化，指令文件 Tab 加载改用 `activeProjectId`、项目选择器始终显示。

---

## 2026-07-11

### 重构
- **附件文件选择器（FilePicker）手风琴展开 + 限定范围搜索**：同级文件夹互斥展开（祖先链保持）；搜索只从活动目录递归往下（聚焦目录 > 展开链最深 > defaultPath > 盘符根），增量呈现不重置展开/折叠/选中状态。影响：frontend(FilePicker.tsx)。

### 新增
- **记忆管理**：集成 pi-hermes-memory，新增记忆管理页（查看/编辑/归档/恢复/删除 + 分类筛选 + 搜索 + 自动学习/注入提示双开关）；只读展示已加载 AGENTS.md/CLAUDE.md（全局/项目筛选）。影响：kernel(memory-store/ws-server/extensions)、frontend(MemoryPage/store/memory)、shared。

---

## 2026-07-10

### 修复
- **dev 脚本按 R 重启时前端端口漂移**：Vite 换端口但浏览器停留旧端口；`dev.ts` 用 `lastOpenedFrontendPort` 追踪端口变化自动重开，vite 加 `strictPort: true` 固守 5180，端口不变不重复开标签页。

### 新增
- **grep/find/ls 与网络搜索抓取工具**：`grep`/`find`/`ls` 为 Pi 内置工具直接加默认 fallback；`web_search`/`fetch_content`/`get_search_content` 由 pi-web-access 扩展提供，kernel 启动时 `ensureWebAccessInstalled()` 自动注册到 settings.json（幂等 + 支持从旧 `npm:pi-web-access` 格式迁移）；新增 `DEFAULT_AGENT_TOOLS` 常量统一默认工具集。

---

## 2026-07-09

### 新增
- **Composer 重构（Tasks 1-18 收尾）**：`Composer`/`NewSessionPane` 统一接入可复用 `ComposerInput` 胶囊输入组件与 `composer-prefs` Zustand store——模型切换、思考强度开关、附件（图片/文件/文本片段）选择与展示；per-session 偏好 + 全局默认值经 IndexedDB（`composer-db.ts` 封装 idb）持久化。供应商模型新增 `supportsVision`，kernel `agent:prompt` 支持按请求切换模型与 thinking level，图片附件按模型 vision 支持决定直接作为 images 发送或降级为文本引用；新增 `fs:readFile` WS 接口。配套子组件：ModelSelector/ThinkingToggle/AttachmentChip/AttachmentPathModal/ComposerTextarea。
  - 影响：frontend(Composer/NewSessionPane/composer-prefs/composer-db + ui/* 多组件)、kernel(agent-manager/ws-server/index)、shared(types.ts/providers.ts)
- **技能管理**：系统设置页新增「技能」菜单——管理技能加载目录（内置 `~/.hiagent/skills/` 不可删 + 用户自定义目录增删）、查看已加载技能列表、单独启用/禁用，同名去重（内置优先），配置变更后自动 reload 所有活跃会话热生效。
- **系统设置页 + 模型供应商管理**：新增「⚙ 系统设置」入口与全屏设置页，自定义 LLM 供应商管理（增删改查：名称/baseURL/apiKey/API 格式/模型列表，模型 ID 经 tag 录入，每模型可配上下文窗口与最大输出，支持连通测试）；供应商经 Pi extension 的 `pi.registerProvider()` 注册，会话用 `<slug>/<modelId>` 引用。
- **DirTreePicker 搜索过滤**：目录选择器新增搜索框，不区分大小写匹配目录名，保留匹配节点完整父级链并展开，清空恢复完整树，无匹配显示提示。

---

## 2026-07-08

### 新增
- **Steer 消息队列控制**：agent 运行中用户消息默认 followUp 排队，支持「引导」升级、「立即」执行、「取消」引导、「清空」排队；4 个 WS steer 事件 + queue_update SDKEvent + AgentManager 5 个队列方法。
- **项目列表右键菜单**：查看文件夹（`project:open-dir`，系统文件浏览器打开项目目录）+ 删除项目（确认框后 `project:delete` 删除项目及所有会话）。

### 重构
- **Pi SDK 模式重构**：kernel 从 spawn `pi --mode rpc` 子进程 + JSON-RPC 改为同进程 `createAgentSession` SDK 直连；AgentManager 用 `Map<sessionId, AgentSession>` 管理多会话，事件用 `sdk:event` 信封全量透传前端；删除 pi-rpc-client.ts 和 state-aggregator.ts。

### 修复
- **pi-intercom 打包为项目依赖**：从运行时 npm install（settings.json `npm:pi-intercom` 触发 DefaultResourceLoader）改为 `@hiagent/kernel` 本地依赖，经 `import.meta.resolve` 解析路径写入 settings.json，消除运行时 `npm install` 及 code 190 错误；支持旧格式自动迁移。
- **Composer/NewSessionPane 发送防抖**：React 批量更新导致 `setText("")` 与下次 Enter 间有竞态窗口 send 被调两次；加 `sendingRef` 标志位 500ms 复位 gate。
- **会话列表 UI 重复**：`agent:prompt` handler 每次广播 `session:created`（即使复用 session），前端 `addSession` 不去重 → 重复；kernel 仅新建时广播 + 前端去重兜底。
- **NewSessionPane 首条用户消息丢失**：`session:created` 触发切 SessionView，但 SessionView onMessage 订阅在 useEffect 注册时 `agent:message` 已到达被 App 丢弃；App onMessage 增加 `agent:message` 处理直接 append（靠 msgKey 去重）。
- **NewSessionPane 连发产生多个重复 session**：前端每次 `randomSessionId()` + kernel 忽略前端 sessionId；前端 sessionId 改 useState 生成一次复用，后端 `createSession` 加可选 id 参数。
- **首条消息用户/agent 顺序颠倒**：SessionView 挂载前 user message 被 App 丢弃，挂载后 assistant 先 append、`session:messages` 把 user 追到末尾；setMessages 合并后按 timestamp 排序。
- **新建会话显示相同聊天内容**：Pi RPC 不支持单进程多会话（prompt/get_messages 不接受 session 参数），AgentManager 以 `(projectId, agentName)` 为 key 让多会话共享一个 Pi 进程；进程管理粒度改为 `(projectId, agentName, sessionId)`，每会话独立 Pi 进程。
- **dev 启动端口清理增强**：`killPort` kill 后改轮询等待端口真正空闲（最多 3s，解决 TIME_WAIT 窗口期未释放）；`dev.ts` 从 Vite 输出解析实际端口；`killPort` PID 查不到时加 `isPortInUse` 二次确认 + 强制清理兜底。

### 配置变更
- **pi 环境本地化 + Windows 兼容**：`@earendil-works/pi-coding-agent` 从全局依赖改为 `@hiagent/kernel` 本地 dependency，`defaultSpawn` 用 `import.meta.resolveSync` 解析本地 dist/cli.js 由 bun 执行；`Bun.spawn` 加 `shell: true` 让 cmd.exe 解析 PATHEXT 找 npm 全局 pi.cmd shim（POSIX 无害）。

---

## 2026-07-07

（整体为 MVP 构建，跨 43 Task 三阶段交付）

### 架构重构
- **移除 Rust 窗口层 + bun 一键启动 + 全 bun:test + 目录树选择器**：移除 Tauri/Rust 窗口层，改用 `bun run dev` 一键启动前后端（并行 kernel 9776 WS + frontend 5180 Vite，自动开浏览器，SIGINT 清理）；测试工具链 vitest → bun:test（24 文件迁移，全仓库单一 runner）；新增本地目录树选择器（react-complex-tree + kernel `fs:listDir`/`fs:roots`/`fs:home`）替代 Tauri 原生目录选择器。
- **Pi 原生消息模型重构**（39 files, +659 / −1875，净减 1216 行）：消息流从 kernel 自管拍扁 ChatMessage + 多套旁路系统（broker-proxy / intercom-monitor / intercom store / AskCard）统一收敛到 **Pi 原生富消息模型**——kernel 透传 Pi 的 `AgentMessage`（含 thinking/text/toolCall/intercom 等内容块），历史会话改由 `getMessages()` 实时拉取 Pi session（不再读拍扁 sessions 文件），前端按内容块类型富渲染（react-markdown）；配置从 `~/.pi/agent` 隔离到 `~/.hiagent/agents`（HiAgent 与 Pi CLI 互不污染）。删除 broker-proxy.ts + intercom-monitor.ts 整套旁路系统 + 前端 useIntercomStore/AskCard。
- **Tauri 项目骨架（后随架构重构移除）**：Cargo + tauri.conf + 空壳窗口；Bun sidecar 编译（`bun build --compile` 产出 hiagent-kernel + Rust target triple 后缀副本）；Rust 主进程管理 kernel sidecar 生命周期（spawn + 窗口关闭 kill）；kernel 全自动热更新（fswatch 重编 + Rust notify 监听 dist 重启 sidecar，前端改动仍由 Vite HMR）。

### 新增
- **编排画布**：React Flow Canvas 组件（4 agent 节点四角布局，partners 灰色虚线连线，活跃 ask 橙色动画连线，resolved 不连线）；App 加 canvas 视图态 + 「← 返回会话」。
- **会话列表交互**：列表按 `lastActivity` 倒序 + 右键 popup 菜单（重命名/删除）+ 删除确认框（红色危险按钮）；新增公共 Modal/ConfirmDialog 组件。
- **新建项目原生目录选择器**：Tauri dialog 接入 + `pickDirectory()` 封装（非 Tauri 降级 prompt）+ basename 取名建项目 + 点项目名切换当前项目。
- **老数据迁移**：老用户首启无项目但有孤儿 session → 自动建「默认项目」并 reassign 归入。
- **多智能体委派（BrokerProxyManager，后随消息模型重构废弃）**：kernel 在 pi-intercom broker 为每个 agent 注册轻量代理 session，其他 agent 经 intercom 工具发消息时代理接收 → 按需启动真实 Pi 进程 → relay 转发，支持链式委派，200+ agent 可扩展（仅 socket 连接，无需预启动进程）。

### 修复
- **消息流全链路打通**：发送无回复——根因多重：①前端没处理 agent:message/agent:state/error 事件 ②PiRpcClient 不认 pi 0.80 的 response 协议 ③pi 的 `--cwd` 参数不存在 ④Bun.spawn stdout 是 Web Streams 非 Node EventEmitter ⑤bun 全局装残缺 pi（缺 proper-lockfile）被优先解析。逐层修复后错误（如 No API key）正确透传前端。
- **会话消息重复**：流式 message_start/update/end 三阶段均触发 appendMessage 持久化 → 同 id 多次 push；改为同 id 更新 + 前端 setMessages 加载历史按 id 去重。
- **start.sh broker 自愈**：kernel 启动无条件连 broker socket，broker 僵死（进程在 socket 删）→ ENOENT 崩溃；`ensure_broker` 检测 socket 不可用自动清理重启。
- **start.command 双击启动失败**：`start.sh` 在 `set -uo pipefail` 下 source ~/.zshrc，zsh 专用语法（autoload/setopt）静默 abort；改 grep+sed 只提取 `DEEPSEEK_API_KEY`。
- **E2E 暴露前端白屏**：shared `process.env` 访问加 `typeof process !== "undefined"` 守卫（浏览器无 process 全局，import 即崩白屏）+ `HIAGENT_DIR` env 覆盖；`randomSessionId` 去 node:crypto 改全局 `crypto.randomUUID()`；intercom-monitor broker 连接失败 `resolve(null)` 降级。
- **Agent Browser 真实业务测试修 4 bug**：ErrorEvent 缺 agentName（前端错误显示为 "dev"）、智能体配置缺失（~/.hiagent/agents/ 不存在）致设置页永久加载中、新建项目目录树第二次打开为空（root 懒加载竞态）、state-aggregator 错误未传结构化 agentName。
- **flaky 测试「点击空白处关闭 popup」**：`requestAnimationFrame` → `setTimeout(fn,0)`、`window.addEventListener` → `document.addEventListener`，测试加 `afterEach(cleanup)`。

### 测试
- **E2E 基础设施 + 7 spec**：Playwright globalSetup 启隔离 kernel（独立 HIAGENT_DIR 随机目录 + globalTeardown 杀进程清目录）+ 7 spec（4 串行主流程 passed，3 需 pi 环境 skip）。
- **MVP 四层测试全绿**：kernel + shared 47 passed、frontend 42 passed、E2E 4 passed + 3 skipped。

### 文档
- **pi-native-message-model 设计文档二次核查**：修正 9 处事实/类型/行号错误；撤回 broker-proxy「靠 `**Reply from X:**` 文本解析、脆弱」论据（核查源码确认其用结构化 API），废弃决策保留但论据改为「职责重叠」（路由/会话名占位/状态影子三层重复）。
- **hiagent-design 对齐多项目重构**：以 sidebar-projects-design 为基准回溯修正单项目描述（启动页/视图清单/AgentManager 双 key/WS 协议字段等）。

---

## 2026-07-06

### 新增
- **前端数据层**：单例 WS 客户端（`ws-instance.ts`，懒连接 kernel 9776）+ projects/session/agents/intercom 四个 Zustand store，供后续所有组件依赖；顺带修复 Vite alias 相对路径解析 bug（原相对字符串，Vite 以引用方文件解析失败，改 `fileURLToPath` 绝对路径）。

### 文档
- **hiagent-design 对齐多项目重构**：以 `2026-07-06-sidebar-projects-design.md` 为基准，消除两份设计文档冲突。
