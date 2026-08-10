# 变更日志

记录所有业务和代码版本修改。新条目始终添加在顶部（时间倒序）。

---

## 2026-08-10 — 修复对话界面 React duplicate key 警告 + Virtuoso 横向溢出 + 回收站长内容换行

### 修复

- **fix(frontend)·duplicate key**：`MessageList.tsx` react-virtuoso 渲染出现 `Encountered two children with the same key` 警告。根因：同 turn 的多条 assistant 消息被 `subagent-notification` custom 消息隔断，`collapseSameTurnAssistants` 因 custom 占独立行无法合并，导致两条 `agentName:timestamp` 完全相同的行进入最终渲染列表。
  - 修复 ①（治本）：`preprocess` 跳过 `subagent-notification`（渲染层本就 `return null`，数据层不应占独立行打断 assistant 连续性）。
  - 修复 ②（防御）：`listRows` key 重复时追加 `#序号` 后缀保证全局唯一。

- **fix(frontend)·横向溢出**：Virtuoso scroller 的 `p-4`（全方向 padding）导致 item 宽度计算溢出——react-virtuoso 把 item `width` 设为 `scroller.clientWidth`（含左右 padding），但 item 渲染在 padding 内部，右边界超出物理视口，用户消息被截。
  - 修复：scroller 改为 `pt-4 pb-4`（仅垂直 padding），水平 padding 移至 itemContent 包裹 div（`px-4 pb-4`）。

- **fix(frontend)·回收站换行**：`TrashMessageViewer` 查看会话详情时，长 URL / 连续英文 / 代码行无换行点，撑破 `max-w-[80%]` 约束导致横向滚动。
  - 修复：消息气泡加 `min-w-0 break-words overflow-hidden`；prose 容器加 `break-words`；代码块加 `[&_pre]:overflow-x-auto`（内部滚动而非撑破）；滚动容器加 `overflow-x-hidden` 兜底。
  - 影响范围：`packages/frontend/src/components/TrashMessageViewer.tsx`。

### 影响范围

- `packages/frontend/src/components/MessageList.tsx`

### 验证

- 新增 `tests/MessageList.duplicate-key.test.tsx`（3 用例）：subagent-notification 不打断合并、同 timestamp 不同 turn key 去重、delegate 场景。修复前精确复现报错，修复后全部通过。
- typecheck 通过，MessageList 相关测试全部通过。

---

## 2026-08-09 — 修复 StreamingBatcher rAF 裸引用 this 错位致真实浏览器流式预览失效（task-7 P0）

### 修复

- **fix(frontend)**：`store/session.ts` 传给 `StreamingBatcher` 的 `raf` 由裸引用 `requestAnimationFrame` 改为箭头包裹 `(fn) => requestAnimationFrame(fn)`。裸引用在 batcher 内 `this.scheduleFn(cb)`（this=batcher 实例）的成员访问调用下，被真实 Chromium 原生 rAF 检测到 receiver≠window 拒绝并抛 `Illegal invocation`，导致所有 `message_update(text_delta)` 流式预览在真实浏览器不更新（直到 `message_end` 定稿），任务 1–6 的 rAF 合帧优化在真实浏览器从未生效。happy-dom 的 rAF 是 setTimeout mock、不校验 receiver，故组件层从未暴露。`caf` 已是箭头包裹，未改。
  - 影响范围：`packages/frontend/src/store/session.ts`。

### 测试

- 新增 `store/session-raf-regression.test.ts`：用「校验 receiver 的 rAF 替身」模拟原生严格语义，断言 message_update 流式路径在严格 rAF 下不抛 Illegal invocation（修复前 FAIL、修复后 PASS）。
- E2E 场景 1「流式对话：合帧更新→定稿后代码块高亮」为真实 Chromium 回归守卫，修复后转 PASS。

---

## 2026-08-09 — 修复虚拟化后「进入会话定位到最新」回归 + 补滚动行为自动化覆盖（task-6 审查修复）

### 修复

- **fix(frontend)**：进入会话的滚动定位 effect 依赖由 `[sessionId]` 改为 `[sessionId, listRows.length]` + 每会话一次守卫（`didInitScrollRef`），复刻虚拟化前的旧语义。回归原因：SessionView 异步 `api.get(.../messages)` 加载历史，首访空缓存时 effect 首次运行 `listRows` 仍为空（早退），历史到达后若仅依赖 `[sessionId]` 则不重跑，用户停在历史顶部而非最新回复（头号行为回归）。`listRows.length` 列入依赖后，历史异步到达（0→非空）触发重跑，定位到末行；守卫保证同会话后续消息增长（流式/新轮）不在此抢滚动（由 `followOutput` 跟随）。
  - 影响范围：`packages/frontend/src/components/MessageList.tsx`。

### 测试补覆盖（审查 Important-2）

- 新增 `packages/frontend/tests/MessageList.enter-scroll.test.tsx`（组件级，3 用例）：mock `react-virtuoso` 捕获 `scrollToIndex` 调用，断言首访空缓存/复访有缓存/切换到空缓存三种场景下异步历史到达后定位到末行（index 48）。happy-dom 无真实滚动几何，故用 mock 捕获调用而非断言 scrollTop。
- 新增 `packages/frontend/e2e/streaming-render-perf.spec.ts`（E2E，1 用例）：真实浏览器中 seed 长会话（60 轮）→ 进入即定位到底部（断言 scrollTop 距底 ≤40px + 末轮回复可见）→ 上滑到顶部断言浮钮出现 + 首轮问题可见 → 点浮钮断言回底 + 浮钮消失。覆盖被删的 13 个滚动行为测试核心子集（进入定位/上滑浮钮/点浮钮回底）。

---

## 2026-08-09 — 消息列表 react-virtuoso 虚拟化，滚动收编 followOutput 移除无限 rAF 循环

### 性能优化

- **perf(frontend)**：消息列表改用 `react-virtuoso@4.18.11` 虚拟化渲染，仅渲染可视区 + overscan 行（`increaseViewportBy=400`），可视区外行卸载——长会话不再全量渲染所有 `MessageRow`（含 Markdown/Prism 重解析）。删除流式期间无限 `requestAnimationFrame` 贴底循环（每帧读 `scrollHeight` + 写 `scrollTop` 造成 forced reflow），滚动跟随收编到 Virtuoso `followOutput`（`autoScrollActive` 时贴底）+ `atBottomStateChange`（驱动 `stickBottom`/浮动按钮）。「进入会话滚到底」改为一次性 `virtuosoRef.scrollToIndex`（无 rAF 循环）。
  - 已知权衡（已记录）：可视区外行被卸载，其内部 `useState` 不保留——`useAutoCollapse` 自动折叠语义不变（props 驱动），仅「用户手动展开后滚出视口再滚回」会回到自动态，可接受。
  - 偏离记录：简报原定 `initialTopMostItemIndex={listRows.length-1}` 在 `VirtuosoMockContext`（happy-dom 测试）下触发 react-virtuoso 4.18.11 mock 限制——任何 N≥1 均渲染 0 行（已实证）；改用一次性 effect（`virtuosoRef.scrollToIndex`）实现「进入会话滚到底」，真实浏览器行为不变，性能目标（移除 rAF 循环）不变。`data-testid="virtuoso-scroller"` 断言因 MessageList 传 `data-testid="message-list"` 覆盖了 Virtuoso 默认 testid，改用 `data-virtuoso-scroller="true"` 标记断言。
  - 测试调整：删除 13 个针对旧滚动算法（rAF/handleScroll/isNearBottom/setScrollMetrics mock）的测试（被测代码已删除，行为外包给 react-virtuoso，happy-dom 无法验证真实滚动→改由步骤 7 冒烟覆盖）；重写空 session 断言；新增 `MessageList.virtualized.test.tsx`（itemContent 分发、流式占位行、Virtuoso 接管滚动守护网）；所有 `render(<MessageList/>)` 测试包 `VirtuosoMockContext.Provider`。
  - 影响范围：`packages/frontend/package.json`、`packages/frontend/src/components/MessageList.tsx`、`packages/frontend/tests/{MessageList,MessageList.virtualized,MessageList.streaming-render,MessageList-sparse-content,MessageRow-streaming,AgentSwitcher,DelegateCard,FleetCard,SessionView}.test.tsx`。

---

## 2026-08-09 — 子代理卡片 memo + 流式输出停顿前纯文本预览降级渲染

### 性能优化

- **perf(blocks)**：`DelegateCard`/`FleetCard` 用 `memo` 包裹，避免父组件（MessageRow）每帧重渲染传导；新增 `StreamingOutput` 组件——子代理执行中（progress.output 高频增长）且未停顿时渲染 `whitespace-pre-wrap` 纯文本预览（与 ThinkingCard 同款低成本渲染），停顿 500ms（`useSettled`）或流式结束后才切完整 markdown。新增 `useSettled` hook 实现「停顿」检测。
  - 影响范围：`packages/frontend/src/components/blocks/{DelegateCard,FleetCard,StreamingOutput,useSettled}.tsx/ts`，对应测试。

---

## 2026-08-09

### 变更

- **chore(desktop)：版本号 0.1.10 → 0.1.11，RELEASE_NOTES 更新为当版内容**（补记回收站 SVG 图标化、auth.json 凭证修复、新会话草稿修复三条已发布变更）。
  - 影响范围：`packages/desktop/package.json`、`packages/desktop/RELEASE_NOTES.md`。

---

## 2026-08-09 — 修复设置页改 API key 不生效（auth.json 过期凭证劫持）

### 修复

- **根因**：pi 鉴权协议规定凭证存储（`~/.pi/agent/auth.json`）优先于 `registerProvider` 注入的 apiKey（pi-ai `resolveProviderAuth`），且 `AuthStorage` 进程启动时缓存、reload 不重读。auth.json 残留过期 key 时，设置页改 key 经任何机制都无法生效。
- **变更**：`ProviderStore` 保存/删除 provider 时同步 pi auth.json——保存按注册 slug 写入/覆盖 `{ type: "api_key", key }`（不覆盖 oauth 登录凭证）；删除仅当条目 type=api_key 且 key 匹配时移除（不动用户自行 login 的凭证）；slug 变更时清理旧条目。authFile 默认取 providers.json 同目录，测试天然隔离。
- **影响范围**：`packages/kernel/src/provider-store.ts`、新增 `packages/kernel/tests/provider-store-auth-sync.test.ts`
- **验证**：新增 7 个单测全绿 + 既有 provider 相关 26 个单测不回归；独立 kernel 实例（隔离 WA_PI_DIR）API 集成测试通过（POST 同步→改 key 覆盖→DELETE 移除且其他条目无影响）。**生效需重启应用**（运行中的 pi 会话进程内存仍缓存旧凭证）。

---

## 2026-08-09 — 修复回收站眼睛/关闭图标不居中

### 修复

- **变更**：emoji 换 SVG 后，`TrashSessionRow` 查看按钮（eye）与 `RecycleBinModal` 关闭按钮（x）失去居中——原为 emoji 文本依赖按钮默认文本居中，替换为 SVG 后需显式 flex 居中。两个按钮 className 增加 `inline-flex items-center justify-center`。
- **影响范围**：`packages/frontend/src/components/TrashSessionRow.tsx`、`packages/frontend/src/components/RecycleBinModal.tsx`
- **验证**：`tsc --noEmit` 通过；前端全量单测 1262 pass 0 fail

---

## 2026-08-09 — 回收站功能 emoji 图标全面替换为自建 SVG `<Icon>` 组件

### 重构

- **变更**：回收站相关 UI 中的 emoji/符号图标全部替换为 `packages/frontend/src/components/ui/Icon.tsx` 的 `<Icon>` 组件；`Icon.tsx` 新增 3 个图标：`inbox`（空态托盘）、`smartphone`（IM 手机标记）、`book`（只读提示），风格与现有图标一致（24 viewBox、stroke currentColor、1.6 线宽、圆角端点）。`IconName` 从 ICONS key 推导，无需手动扩类型。
- **替换映射**：RecycleBinButton（🗑️→trash，沿用 --font-scale 缩放写法）、RecycleBinModal（标题 🗑️→trash、✕→x、空态 📭→inbox 48px、恢复 ↩️→reply、删除 🗑️→trash、清空 ⚡→bolt）、TrashSessionRow（📱→smartphone、👁→eye、头像充底 🤖→渲染 robot 图标，有 emoji 时仍显示 emoji）、TrashMessageViewer（⚠️→warning ×2、📭→inbox、📖→book）、GeneralSection（🗑️→trash）。
- **影响范围**：`packages/frontend/src/components/ui/Icon.tsx`、`RecycleBinButton.tsx`、`RecycleBinModal.tsx`、`TrashSessionRow.tsx`、`TrashMessageViewer.tsx`、`settings/GeneralSection.tsx`、`tests/Icon.test.tsx`（新图标加入冒烟名单）
- **验证**：`tsc --noEmit` 通过；前端全量单测 1262 pass 0 fail；grep 确认 5 个文件不再残留 emoji/符号图标；回收站 UI 无 E2E spec 引用，无需运行

---

## 2026-08-09 — 修复「新会话消息都跑到同一个会话」（草稿 id 未消费）

### 修复

- **根因**：新建会话页的草稿 sessionId 持久化在 localStorage/IDB，全前端唯一清除点是 App.tsx 对 `session:created` 广播的处理。而 kernel 对 placeholder 占位会话的首发消息走 `isNew=false` 分支、**不广播 session:created** → 草稿 id 永久残留 → 下次进新建页复用同一 id。发送守卫（`existed` 检查本地 sessions 列表）在稳态下能自愈，但在两个窗口失效：① 重启竞态（列表未加载就发送）；② 会话被删除后（loadActive 过滤 deletedAt，kernel 的 existing 查找却不过滤）——后者会确定性地把所有消息写进回收站里的同一个会话。

- **修复方案**：`NewSessionPane.handleSend` 发送成功后无条件 `clearNewSessionId(newSessionKey)`——发送即消费草稿 id，不再依赖 kernel 广播这一间接信号；挂载同步 effect 会按需重新生成全新草稿 id。

- **影响范围**：`packages/frontend/src/components/NewSessionPane.tsx`、`packages/frontend/src/components/new-session-send.test.tsx`（新增）、`packages/frontend/e2e/new-session-draft.spec.ts`（新增）

- **验证**：第二层组件测试（模拟持久层恢复残留草稿 id → 发送 → 断言草稿被消费，修复前 RED / 修复后 GREEN）+ 第四层 Playwright E2E（删除会话后再新建发送 → 断言消息进入全新会话；已验证回退修复后该 E2E 稳定复现 bug）；前端全量 1262 pass 0 fail

---

## 2026-08-09 — 修复「莫名其妙的空会话」（预热占位记录残留）

### 修复

- **根因**：新建会话页挂载时 `ComposerInput` 拉取 slash 命令 → `AgentManager.getCommands` 第 4 兜底分支会**静默创建空标题 session 记录**（预热 pi 进程用）并落盘 projects.json。用户未发送消息就离开时，既有的孤儿回滚机制（`_onProcessExit` 删记录）只在进程**崩溃**时生效；**60 秒空闲回收**走 `disposeSession`（`disposed=true` 直接 return）和**关闭应用**两条路径都跳过回滚 → 空记录永久残留，下次启动才在侧栏现身，看似「莫名其妙」。

- **修复方案**：给兜底记录打 `placeholder` 标记，可见性与进程退出时序彻底解耦——
  - `SessionEntity` 新增 `placeholder?: boolean`；`getCommands` 兜底建记录时传 `placeholder: true`
  - `ProjectStore.loadActive()`（侧栏列表数据源）过滤 placeholder 记录 → 幽灵会话永不进侧栏
  - `fillSessionTitleIfEmpty()` 首次发消息填标题时同步清除 placeholder（转正），ws-server 现有逻辑自动广播 projects:list，会话正常出现
  - 进程启动链路不变（`_createSession` 仍依赖记录存在，预热设计保留）
  - 顺带修复既有 lint 阻断：`project-store-trash.test.ts` 对 private `save` 的直调改为 `(s as any)` 反射（与 trash-messages-integration 既有实践一致）；`e2e-integration.test.ts` 删除两个未使用变量

- **影响范围**：`packages/shared/src/types.ts`、`packages/kernel/src/project-store.ts`、`packages/kernel/src/agent-manager.ts`、`packages/kernel/tests/{project-store,agent-manager,e2e-integration}.test.ts`、`packages/kernel/src/__tests__/project-store-trash.test.ts`、`packages/frontend/e2e/placeholder-session.spec.ts`（新增）

- **验证**：第一层 bun:test 单元测试（placeholder 过滤/转正）+ 第三层 HTTP 集成测试（拉 commands→侧栏无记录→首发消息→转正出现）+ 第四层 Playwright E2E（placeholder-session.spec.ts 幽灵不可见/正常会话对照可见）全部通过；kernel 全量 873 pass，2 个失败均为改动前既有（孤儿回滚、deleteProject 级联）

---

## 2026-08-09 — 修复切换模型后会话模型被回滚（loadSession 竞态）

### 修复

- **根因**：`composer-prefs.ts` 的 `loadSession` else 分支（会话首次加载）用 `getDefaults()` 的 **T0 快照**无条件覆盖内存 `defaults`。而 `getDefaults()` 是同步读 localStorage（快照在调用时即捕获），`getSessionPrefs()` 是真实 IDB 读（挂起窗口）——窗口内用户若切换了模型，`loadSession` 完成时会把内存 defaults 回滚到开读时刻的旧值。这是「有时候切换了模型再切换回来，会话模型就变了」的竞态根因（是否触发取决于 IDB 读取是否撞上模型切换，故间歇出现）。

- **修复方案**：else 分支与 existing 分支对齐同一守卫——仅当内存 `defaults.model == null`（冷启动尚未加载）时才从持久层 T0 值填充，否则保留内存当前值；会话模型回退链改为 `stored?.model ?? s.defaults.model ?? defaults.model`（优先内存当前值，再持久层快照）。
  - 影响范围：`packages/frontend/src/store/composer-prefs.ts`

### 测试

- 新增确定性竞态复现测试：利用 `getDefaults()` 同步捕获快照的特性，在 `loadSession()` 返回后同步改 defaults，断言完成后内存 defaults 不被回滚（修复前 fail、修复后 pass）。
- 全量回归：frontend 1261 pass / 0 fail，typecheck 全绿。

## 2026-08-09 — 修复 fleet 同名 agent 并行委托状态显示一模一样

### 修复

- **根因**：fleet（并行委托）中 LLM 常把多个任务派给同一智能体（同名 agent），而进度事件/持久化统计均按 `agent` 名字做 key，同名任务互相覆盖（后写覆盖先写），导致前端各任务行显示「完成/进行中/失败一模一样」。昨日修复（6ace36c4）只解决了回复文本串台，未覆盖进度/统计通道。

- **修复方案**：每个 fleet 任务分配 `taskIndex`（原始数组序号 0-based），从 kernel → bridge → store → 前端全链路携带，按序号而非名字区分各子任务：
  - `SubagentProgressEvent` 增加 `taskIndex?: number` 字段
  - `DelegateSpawnFn` 增加 `taskIndex?: number` 参数
  - kernel `delegate-tool.ts`：fleet 循环传 `index` 给 spawn；`makeSpawnFn` 闭包把 `taskIndex` 注入 onProgress 事件；`details.fleet` 改按 `String(index)` 存储
  - 前端 `store/session.ts`：`handleSubagentProgress` 按 `String(taskIndex ?? agent)` 键入（无 taskIndex 的 delegate 单任务/老数据按 agent 名降级）
  - 前端 `FleetCard.tsx`：任务行按 `String(i)` 匹配进度/统计，老数据按 agent 名降级
  - 影响范围：`packages/shared/src/types.ts`、`packages/kernel/src/delegate-tool.ts`、`packages/frontend/src/store/session.ts`、`packages/frontend/src/components/blocks/FleetCard.tsx`

### 测试（四层全场景覆盖）

- **① 单元（kernel/store）**：kernel delegate-tool 6 例（同名 agent 多任务各收不同 taskIndex、details.fleet 按序号 key 不互相覆盖、越权项不打乱编号、onProgress 事件注入 taskIndex、delegate 单任务向后兼容）+ store 2 例（同名 agent 不同 taskIndex 独立存储、无 taskIndex 按 agent 名降级）
- **② 组件（FleetCard）**：3 例（运行态各任务行显示各自独立工具统计、完成态 details 按序号 key 各显示各自统计、老数据按名字 key 降级不崩溃）
- **③ 集成（agent-manager）**：2 例（fleet 3 子任务 taskIndex 端到端透传到广播、同名 agent 多任务各带不同 taskIndex 忠实复现）
- **④ E2E（真实 Chromium）**：1 例（浏览器侧注入同名 agent fleet 数据 + progress 事件，断言各任务行显示独立统计）
- 全量回归：kernel 840 pass / frontend 1260 pass，typecheck 全绿

## 2026-08-09 — 新增开机自启功能

### 变更

- **新增功能：系统设置 → 通用中新增「开机自启」开关，默认安装后开启**。使用 Electron 原生 `app.setLoginItemSettings` API，通过 IPC 同步前端偏好到系统注册表/启动项。仅在桌面打包版显示该选项（检测 `window.waPiApp.setLoginItem` 是否存在）。
  - 影响范围：
    - `packages/desktop/src/main.cjs`（新增 IPC handler `app:get-login-item` / `app:set-login-item`）
    - `packages/desktop/src/preload.cjs`（waPiApp 暴露 `getLoginItem` / `setLoginItem`）
    - `packages/frontend/src/store/ui-prefs.ts`（新增 `autoLaunch` 字段，默认 `AUTO_LAUNCH_DEFAULT = true`）
    - `packages/frontend/src/components/settings/GeneralSection.tsx`（mount 时同步 store 偏好到系统 + toggle UI）
    - `packages/frontend/src/util/clipboard.ts`（扩展 waPiApp 类型声明）
    - `packages/frontend/src/i18n/locales/zh.ts` + `en.ts`（新增文案）
  - 新增测试：`tests/store-ui-prefs-autolaunch.test.ts`（默认值 true + setter 持久化）。

---

### 变更

- **修复(frontend)：不同项目（不同 ProjectItem 组件）右键时菜单重叠**。根因：`sessionMenu` 和 `projectMenu` 是每个 ProjectItem 的局部状态，跨组件不互斥。修复：右键时 dispatch 全局 `project-menu-close` 事件，所有 ProjectItem 监听该事件关闭自身菜单，确保同一时间只有一个菜单。同时修复了同一组件内会话/项目菜单的互斥逻辑。
  - 影响范围：`packages/frontend/src/components/ProjectItem.tsx`（handler 中 `window.dispatchEvent` + 新增 `useEffect` 监听全局事件）。
- **改进(frontend)：重命名弹窗禁止点击遮罩关闭**。防止用户误触遮罩区域导致弹窗意外关闭、输入内容丢失。改为 `closeOnOverlayClick={false}`，仅通过取消按钮、确认按钮或 ESC 关闭。
  - 影响范围：`packages/frontend/src/components/ProjectItem.tsx`（Modal 属性 `closeOnOverlayClick={false}`）。
  - 新增测试：`ProjectItem.rename.test.tsx`（跨组件互斥 + 遮罩不关闭）。

---

## 2026-08-09 — 修复右键菜单不互斥（多个菜单同时显示）

### 变更

- **修复(frontend)：右键项目和会话时菜单不互斥，导致多个菜单同时显示**。根因：`handleSessionContextMenu` 和 `handleProjectContextMenu` 各自只设置自己的菜单状态，不清理对方的。修复后两个 handler 在打开自己菜单前清除对方菜单状态。此修复同时解决了多菜单叠加导致的渲染卡顿和点击外部不关闭的问题。
  - 影响范围：`packages/frontend/src/components/ProjectItem.tsx`（`handleSessionContextMenu` 加 `setProjectMenu(null)`、`handleProjectContextMenu` 加 `setSessionMenu(null)`）。
  - 新增测试：`ProjectItem.rename.test.tsx`（右键互斥 + Modal 遮罩关闭）。

---

## 2026-08-09 — 项目右键菜单添加重命名功能

### 变更

- **新增功能(frontend)：项目右键菜单添加「重命名项目」选项，复用会话重命名的 Modal 弹窗模式**。后端 PATCH /api/projects/:id API 链路已就绪（project:update → projectStore.updateProject → broadcast），前端只需接入。系统项目（默认工作区）不显示重命名选项（与删除项目一致）。
  - 影响范围：`packages/frontend/src/api-client.ts`（新增 `patch` 方法）、`packages/frontend/src/components/ProjectItem.tsx`（扩展 renameTarget 类型支持 ProjectEntity、新增 handleProjectRename、右键菜单加重命名项、Modal 标题区分项目/会话）、`packages/frontend/src/i18n/locales/zh.ts` + `en.ts`（新增 ctxRenameProject / renameProjectTitle 文案）。
  - 新增测试：`packages/frontend/tests/ProjectItem.rename.test.tsx`（菜单显示/隐藏、Modal 预填、PATCH API 调用）。

---

## 2026-08-09 — 修复 anthropic-messages 格式 provider 测试连接 404

### 变更

- **修复(kernel)：`provider-test.ts` 中 `anthropic-messages` 格式的测试连接拼接路径错误**。根因：测试连接代码对 anthropic-messages 分支拼接的 URL 是 `{baseUrl}/messages`，但 Anthropic SDK（pi-ai 实际调用时使用的）拼接的是 `{baseUrl}/v1/messages`。这导致所有 baseUrl 不自带 `/v1` 的 Anthropic 兼容 provider（如 Kimi Code `https://api.kimi.com/coding`）在点击「测试连接」时返回 404 `resource_not_found_error`，尽管实际对话能正常工作。修复后路径改为 `{baseUrl}/v1/messages`，与 SDK 行为一致。同时修正了原有测试中错误的 baseUrl 约定（不应带 `/v1`），并新增 Kimi Code 回归测试。
  - 影响范围：`packages/kernel/src/provider-test.ts`（URL 拼接 `/messages` → `/v1/messages`）、`packages/kernel/tests/provider-test.test.ts`（baseUrl 约定修正 + 新增回归测试）。

---

## 2026-08-09 — 修复：最终代码审查发现的 5 个问题

### 类型

修复

### 摘要

- **Important #1**：`saveTrashSettings` 添加 clamp 校验（[1,365]），负数/0 不再导致全量归档/清除；PUT 路由回显归一化结果；前端 `GeneralSection` 用 `Math.max(1, ...)` 兜底
- **Important #2**：`deleteProject` 物理删除子会话改为软删除（移入回收站），避免绕过回收站直接丢失数据
- **Important #3**：`session:messages` handler 添加 `deletedAt` 守卫，软删除会话只读模式不 touch、不 prewarm，避免复活 pi 进程
- **Minor #M4**：TrashSessionRow 查看按钮 title 从 `trash.viewerBack`（"返回回收站"）修正为新增 key `trash.view`（"查看消息"）
- **Minor #M6**：Sidebar 加载回收站总数并传入 RecycleBinButton，角标不再为死代码

### 影响范围

- `packages/kernel/src/settings-store.ts`、`routes/settings.ts`、`project-store.ts`、`ws-server.ts`
- `packages/frontend/src/components/Sidebar.tsx`、`TrashSessionRow.tsx`、`settings/GeneralSection.tsx`
- `packages/frontend/src/i18n/locales/zh.ts`、`en.ts`
- 单元测试：`settings-trash.test.ts`（+3）、`project-store-trash.test.ts`（+3）

---

## 2026-08-09 — 新增功能：回收站弹窗 + 会话行 + 只读消息查看器 + Sidebar 集成

### 变更

- **新增(frontend)：TrashSessionRow 组件**。单行会话条目，含复选框、agent emoji、agent 名、项目标签、删除原因标签（手动/自动）、相对时间、查看按钮（👁）。`memo` 优化重渲染。项目名回退到 SYSTEM_PROJECT_NAME。
  - 影响范围：`packages/frontend/src/components/TrashSessionRow.tsx`（新建）。
- **新增(frontend)：RecycleBinModal 组件**。80vw×80vh 弹窗，布局为 Header（标题+计数+关闭）→ 项目筛选 Tab → 会话列表（全选/选中计数/行渲染）→ 分页 → 底部操作栏（恢复/删除/清空）。清空和物理删除各包裹 ConfirmDialog 确认弹窗。store.viewerSessionId 非空时切换为 TrashMessageViewer 视图（ESC/遮罩点击返回列表）。
  - 影响范围：`packages/frontend/src/components/RecycleBinModal.tsx`（新建）。
- **新增(frontend)：TrashMessageViewer 组件**。只读消息查看器，复用 `/api/sessions/:id/messages` 端点加载历史（软删除不删 jsonl 文件），通过 `useSessionStore.setMessages` 注入后复用 MessageList 渲染。含警告提示条（只读模式+恢复链接）和返回按钮。
  - 影响范围：`packages/frontend/src/components/TrashMessageViewer.tsx`（新建）。
- **修改(frontend)：Sidebar.tsx 集成**。底部栏从单独 SettingsButton 改为 RecycleBinButton + SettingsButton 并排（flex gap-1）。新增 showTrash state 控制 RecycleBinModal 开关。
  - 影响范围：`packages/frontend/src/components/Sidebar.tsx`。
- **新增(frontend)：分页 i18n key**。在 zh.ts / en.ts 的 trash 分组新增 prevPage / nextPage，替代简报中的语言检测 hack。
  - 影响范围：`packages/frontend/src/i18n/locales/zh.ts`、`packages/frontend/src/i18n/locales/en.ts`。

---

## 2026-08-09 — 新增功能：前端回收站 i18n 文案 + store/trash.ts + RecycleBinButton 组件

### 变更

- **新增(frontend)：回收站 i18n 文案**。在 `zh.ts` / `en.ts` 的 `sidebar` 分组后新增 `trash` 分组（23 个 key：标题、空态、计数、全选/选中状态、恢复/彻底删除/清空操作、删除原因、只读查看器提示、确认弹窗文案、IM 标签等），并在 `settings` 分组新增 `trashSection` / `trashAutoArchive` / `trashArchiveDays` / `trashAutoPurge` / `trashPurgeDays` 5 个设置项文案。中英结构完全镜像。
  - 影响范围：`packages/frontend/src/i18n/locales/zh.ts`、`packages/frontend/src/i18n/locales/en.ts`。
- **新增(frontend)：store/trash.ts**。基于 zustand 的回收站状态管理：`loadTrash`（分页 + 项目过滤拉取回收站会话）、`toggleSelect` / `selectAllOnPage` / `clearSelection`（批量选择）、`restore` / `permanentlyDelete` / `emptyTrash`（恢复/物理删除/清空，操作后自动刷新列表并清理选择集）、`openViewer` / `closeViewer`（只读查看器）。API 契约对齐后端 `GET/POST/DELETE /api/trash/sessions`。
  - 影响范围：`packages/frontend/src/store/trash.ts`（新建）。
- **重构(frontend)：projects store setAll 防御性过滤**。在 `useProjectsStore.setAll` 中新增 `sessions.filter(x => !x.deletedAt)` 过滤，剥离软删除会话，确保主列表只展示活跃会话（后端 `loadActive()` 已过滤，此处为防御性安全网）。
  - 影响范围：`packages/frontend/src/store/projects.ts`。
- **新增(frontend)：RecycleBinButton 组件**。回收站入口按钮，参考 `SettingsButton.tsx` 样式，支持角标显示回收站会话数（>99 显示 99+）。Sidebar 集成推迟至 Task 8（RecycleBinModal 创建后）。
  - 影响范围：`packages/frontend/src/components/RecycleBinButton.tsx`（新建）。

---

## 2026-08-09 — 新增功能：会话自动归档调度器（回收站定时归档 + 可选自动清理）

### 变更

- **新增(kernel)：会话自动归档调度器**。在 `index.ts` 的 `startKernel()` 中、`server.start()` 之后新增 `runAutoArchive()` 调度器：每 6 小时执行一次，启动时立即执行一次。读取 `loadTrashSettings()`，把超过 `autoArchiveDays` 未活动的会话经 `projectStore.archiveStaleSessions()` 软删除到回收站，归档后调用 `server.broadcastProjectsList()` 刷新前端列表；若启用 `autoPurgeEnabled`，再经 `purgeOldTrashSessions()` 物理清理超过 `autoPurgeDays` 的回收站会话。调度器独立于 workdir 清理与空闲会话回收，复用同一 `setInterval` + `clearInterval` 模式。
- **新增(kernel)：shutdown 清理归档 timer**。在 `shutdown()` 函数中新增 `clearInterval(archiveTimer)`，与 `reapTimer` 一并清理，避免退出后残留定时器。
  - 影响范围：`packages/kernel/src/index.ts`。

---

## 2026-08-09 — 新增功能：回收站 WS 事件处理器 + HTTP 路由 + projects:list 过滤已删除会话

### 变更

- **新增(kernel)：WS 层回收站事件处理器**。在 `ws-server.ts` 的 `handle()` switch 中新增 4 个 case：`trash:list`（分页查询回收站会话，返回 sessions/projects/total）、`trash:restore`（批量恢复后广播 projects:list）、`trash:delete`（永久删除指定会话）、`trash:empty`（清空回收站并返回删除数量）。
- **新增(kernel)：`broadcastProjectsList()` 公开辅助方法**。封装 `loadActive()` + `broadcast({type:"projects:list"})`，统一过滤已软删除会话。将 `ws-server.ts` 中全部 9 处手动 `load()` + `broadcast(projects:list)` 模式（project:update、project:delete、session:rename、session:set-agent、session:reload、session:delete、agent:prompt 填充标题、agent:save 改名、fillEmptySessionTitle）替换为此方法。`projects:list` 定向 reply 也改为 `loadActive()`。
  - 影响范围：`packages/kernel/src/ws-server.ts`。
- **新增(kernel)：回收站 HTTP 路由**。在 `routes/projects-sessions.ts` 新增 `GET /api/trash/sessions`（分页查询）、`POST /api/trash/sessions/restore`（批量恢复）、`DELETE /api/trash/sessions`（带 sessionIds 数组则永久删除，否则清空回收站）。
  - 影响范围：`packages/kernel/src/routes/projects-sessions.ts`。
- **新增(kernel)：回收站设置 HTTP 路由**。在 `routes/settings.ts` 新增 `GET /api/settings/trash` 和 `PUT /api/settings/trash`，直接调用 `loadTrashSettings` / `saveTrashSettings` 读写 settings.json（不走 WS callApi）。
  - 影响范围：`packages/kernel/src/routes/settings.ts`。

---

## 2026-08-09 — 新增功能：回收站设置存储 loadTrashSettings/saveTrashSettings

### 变更

- **新增(kernel)：回收站自动归档/清除设置的持久化读写**。在 `settings-store.ts` 新增 `TRASH_DEFAULTS`（默认开启 7 天自动归档、关闭自动清除、清除阈值 30 天）与 `loadTrashSettings` / `saveTrashSettings`（read-modify-write，保留 settings.json 内 retry/httpIdleTimeoutMs 等其他字段），与既有 `loadRetrySettings` / `saveRetrySettings` 同构，均带可选 `file` 参数以便测试隔离。配套单元测试 3 例覆盖「无文件回退默认值」「保存后读回」「保留其他字段」。
  - 影响范围：`packages/kernel/src/settings-store.ts`（新增 `TRASH_DEFAULTS` + 2 函数 + import `TrashSettings`）、`packages/kernel/src/__tests__/settings-trash.test.ts`（新增）。

---

## 2026-08-09 — 新增功能：ProjectStore 回收站查询与自动归档/清理方法

### 变更

- **新增(kernel)：ProjectStore 回收站查询与生命周期管理能力**。新增三个方法：`loadTrash`（分页查询回收站，支持 `projectId` 过滤与 `offset/limit` 分页，按 `deletedAt` 倒序，返回 `{ sessions, total }`）、`archiveStaleSessions(thresholdMs)`（扫描超过阈值未活动且未删除的会话，标记软删除 `deletedReason="auto"`）、`purgeOldTrashSessions(purgeBefore)`（永久删除 `deletedAt` 早于指定时间点的回收站会话）。配套单元测试 9 例覆盖分页/过滤/空集/阈值边界/已删除跳过等场景。
  - 影响范围：`packages/kernel/src/project-store.ts`（新增 3 方法）、`packages/kernel/src/__tests__/project-store-trash.test.ts`（追加 9 测试）。

---

## 2026-08-09 — 新增功能：ProjectStore 软删除/恢复/彻底删除/清空回收站 + loadActive

### 变更

- **新增(kernel)：ProjectStore 回收站存储层能力**。将 `deleteSession` 从物理删除改为软删除（置 `deletedAt` / `deletedReason="manual"`），新增四个方法：`loadActive`（仅返回未软删除会话）、`restoreSession`（清空软删除标记，原项目不存在则归入默认工作区）、`permanentlyDeleteSessions`（按 id 批量物理移除）、`emptyTrash`（清空所有已软删除会话并返回移除数量）。配套单元测试 8 例覆盖正常路径与边界（no-op、空回收站、不存在 id）。
  - 影响范围：`packages/kernel/src/project-store.ts`（改造 `deleteSession` + 新增 4 方法 + import `SYSTEM_PROJECT_ID`）、`packages/kernel/src/__tests__/project-store-trash.test.ts`（新增）。

---

## 2026-08-09 — 新增功能：会话回收站类型定义

### 变更

- **新增(shared)：会话回收站功能的共享类型定义**。为 `SessionEntity` 新增软删除字段（`deletedAt` / `deletedReason`），新增 `TrashSettings`（自动归档/清除设置），新增回收站 WS 事件类型（`TrashListRequest` / `TrashRestoreEvent` / `TrashDeleteEvent` / `TrashEmptyEvent` / `TrashListResult` / `TrashOpResult`），并追加到 `WSClientEvent` / `WSServerEvent` 联合类型。
  - 影响范围：`packages/shared/src/types.ts`。

---

## 2026-08-09 — 发版 v0.1.10

### 变更

- **发版(desktop)：发布 v0.1.10 桌面安装包（WA PI Agent，NSIS）到阿里云 OSS + GitHub Release**。自 v0.1.9 以来：文件树重新显示隐藏项（listDir 透传 showHidden）、点击附件 chip 内置文件预览器预览、streaming 期间不再提前显示复制/导出按钮。产物 WaPi-Setup-0.1.10.exe + latest.yml 上传至 coaicom/releases/，GitHub Release v0.1.10 同步发布。
  - 影响范围：`packages/desktop/package.json`（0.1.9 → 0.1.10）、`packages/frontend/package.json`（0.1.9 → 0.1.10）、`packages/desktop/RELEASE_NOTES.md`。

---

## 2026-08-09 — 修复 streaming 期间提前显示复制/导出按钮

### 变更

- **修复(frontend)：AI 回复未结束时（streaming），消息上的复制和导出按钮提前显示**。根因：`MessageList.tsx` 中 `renderSeg` 的按钮渲染条件仅检查 `seg === segments[lastTextSegIdx]`，缺少 `!isStreaming` 判断。修复后加入 `&& !isStreaming`，确保按钮仅在消息完成后显示。
  - 影响范围：`packages/frontend/src/components/MessageList.tsx`（`renderSeg` 按钮条件加 `!isStreaming`；导出 `MessageRow` 供测试；清理 2 个预先存在的 lint 问题：删除未使用的 `mdComponents`、`processSegs` 的 `s` 参数改为 `_`）。
  - 新增测试：`packages/frontend/tests/MessageRow-streaming.test.tsx`（streaming 时按钮不渲染 + 非 streaming 时按钮渲染）。

---

## 2026-08-09 — 点击附件 chip 用内置文件预览器打开预览

### 变更

- **修复(frontend+kernel)：右侧项目文件树重新显示 .git/.env/.vscode 等隐藏文件/文件夹**。此前 commit 13aab6b3 删除了 ExplorerPanel 前端的 dotfile 过滤，但未给 `listDir` 传 `showHidden=true`，kernel `routes/fs.ts` 的 `showHidden || !name.startsWith(".")` 过滤仍在——修复未闭环，隐藏项依旧不显示。修复：`ExplorerPanel.tsx` 调 `listDir(dir, true)` 放行隐藏项；kernel 将 list-dir 的 readdir+dotfile 过滤逻辑抽取为可测的导出函数 `listDir(path, showHidden)`（行为不变，路由复用）。新增测试：前端组件测试断言 listDir 请求携带 `showHidden: true`；kernel 测试锁定 dotfile 过滤契约（showHidden 缺省过滤 / true 放行 .git/.gitignore）。
  - 影响范围：`packages/frontend/src/components/ExplorerPanel.tsx`、`packages/frontend/tests/ExplorerPanel.test.tsx`、`packages/kernel/src/routes/fs.ts`、`packages/kernel/tests/fs-routes.test.ts`。

- **新增功能(frontend)：点击附件 chip 时，用应用内置的文件预览弹窗（FilePreviewModal + FileViewer）预览文件内容**，与点击消息中的文件引用、双击文件树体验一致。snippet 类型（无文件路径）不支持预览。
  - 影响范围：`packages/frontend/src/components/ui/AttachmentChip.tsx`（新增 `onClick` prop，chip 本体可点击，删除按钮 stopPropagation）；`packages/frontend/src/components/ui/ComposerInput.tsx`（传入 onClick 回调，调用 `useSessionStore.openFilePreview`）。
  - 新增测试：`packages/frontend/tests/AttachmentChip.test.tsx`（点击 chip 本体触发 onClick；点击删除按钮不触发 onClick）。

---

## 2026-08-09 — 粘贴超过 30 行文本自动转为文件附件

### 变更

- **新增功能(frontend)：粘贴文本超过 30 行时，自动转为 .txt 文件附件上传，不再撑爆输入框**。≤30 行的文本正常插入输入框。
  - 影响范围：`packages/frontend/src/components/ui/ComposerInput.tsx`（`handlePaste` 增加行数阈值判断；`uploadFiles` 签名扩展为 `FileList | File[]`）。
  - 新增测试：`packages/frontend/tests/ComposerInput.test.tsx`（>30 行→文件上传；≤30 行→正常粘贴）。

---

## 2026-08-09 — 新建角色默认关系网包含所有内置智能体

### 变更

- **功能优化(kernel)：新建角色（空白创建 & 预设创建）时，`partners.askTo` 默认填入所有内置智能体（ALL_AGENT_NAMES），用户无需手动到关系网 tab 逐个勾选**。之前默认为空，用户每次新建角色都需要手动配置关系网。
  - 影响范围：`packages/kernel/src/agent-md.ts`（`makeDefaultAgentConfig` 默认 partners.askTo 从 `[]` 改为 `[...ALL_AGENT_NAMES]`）。空白创建（POST /api/agents）与预设创建（POST /api/agents/from-preset → `buildAgentConfigFromPreset` → `makeDefaultAgentConfig`）两条路径同时生效。
  - 新增测试：`agent-md.test.ts`（makeDefaultAgentConfig 默认关系网）、`preset-store.test.ts`（buildAgentConfigFromPreset 继承默认关系网）。

---

## 2026-08-09 — 发版 v0.1.9

### 变更

- **发版(desktop)：发布 v0.1.9 桌面安装包（WA PI Agent，NSIS）到阿里云 OSS + GitHub Release**。自 v0.1.8 以来：会话重命名改用内置 Modal 弹窗（替代浏览器原生 prompt，新增 4 条测试）。产物 WaPi-Setup-0.1.9.exe + latest.yml 上传至 coaicom/releases/，GitHub Release v0.1.9 同步发布。
  - 影响范围：`packages/desktop/package.json`（0.1.8 → 0.1.9）、`packages/frontend/package.json`（0.1.8 → 0.1.9）、`packages/desktop/RELEASE_NOTES.md`。

---

## 2026-08-09 — 重命名会话改用内置弹窗

### 变更

- **重构(frontend)：会话「重命名」从浏览器原生 `window.prompt` 改为内置 `Modal` 组件弹窗**。右键菜单点击「重命名会话」后，弹出与删除确认框同风格的输入弹窗（预填当前标题、支持 Enter 提交、取消/确认按钮），与删除会话的 ConfirmDialog 体验对齐，消除全仓唯一一处原生 prompt。后端接口 `POST /api/sessions/:id/rename` 不变。
  - 影响范围：`packages/frontend/src/components/ProjectItem.tsx`、`packages/frontend/tests/ProjectItem.sort-menu.test.tsx`（新增 4 条重命名弹窗测试）。

---

## 2026-08-09 — 恢复 README 截图素材

### 变更

- **文档：恢复 README 引用的 4 张界面截图**。撤销 `bd92abcd`（chore: 移除 docs 目录）对 README 素材的误删：从 git 历史恢复 `docs/assets/readme/`（readme-session / readme-mcp / readme-extensions / readme-models 四张 PNG），并在 `README.md` / `README.zh-CN.md` 恢复对应的 4 处 `<img>` 引用（会话界面、MCP 连接器、插件管理、模型管理），与删除前版本完全一致。docs/ 下第三方参考文档（references）不恢复。
  - 影响范围：`docs/assets/readme/`（新增 4 张图片）、`README.md`、`README.zh-CN.md`。

---

## 2026-08-09 — 发版 v0.1.8

### 变更

- **发版(desktop)：重新发版为 v0.1.8 桌面安装包（WA PI Agent，NSIS）到阿里云 OSS**。0.1.7 打包完成后未发布（版本号未对外），实际发版版本号修正为 0.1.8，内容与 0.1.7 一致（初始化向导、预设智能体、fleet 同名串台修复、企微 IM 断线崩溃修复、预设头像/同步修复、仓库脱敏）。产物 WaPi-Setup-0.1.8.exe + latest.yml（注入 releaseNotes）上传至 coaicom/releases/。
  - 影响范围：`packages/desktop/package.json`（0.1.7 → 0.1.8）、`packages/frontend/package.json`（0.1.7 → 0.1.8）、`packages/desktop/RELEASE_NOTES.md`。

---

## 2026-08-09 — 发版 v0.1.7

### 变更

- **发版(desktop)：发布 v0.1.7 桌面安装包（WA PI Agent，NSIS）到阿里云 OSS**。自 v0.1.6 以来的 27 个提交：①新增初始化向导（无模型自动弹出、设置页可重开、复用 ProviderForm、defaultAgent 优先级）；②新增预设智能体体系（268 条预设数据、preset-store、from-preset 创建 API、presets/:id 详情接口、部门筛选、随机中文人名库、AgentCreatePicker 空白/预设两 Tab、3 列卡片弹窗 720 宽）；③修复（fleet 同名 agent 任务卡片串台、企微 IM 流式推送断线期 unhandledRejection 崩溃、预设非 hex 颜色头像渐变、defaultAgent 变更同步、宫格面板被挤出视口）；④测试与文档（presets curl 集成测试、初始化向导 E2E、脱敏公开仓库本机路径）。产物 WaPi-Setup-0.1.7.exe + latest.yml（注入 releaseNotes）上传至 coaicom/releases/。
  - 影响范围：`packages/desktop/package.json`（0.1.6 → 0.1.7）、`packages/frontend/package.json`（0.1.6 → 0.1.7）、`packages/desktop/RELEASE_NOTES.md`。

---

## 2026-08-09

### 变更

- **修复(frontend)：会话消息流渲染崩溃 `Cannot read properties of undefined (reading 'type')`**。根因：pi-ai 0.84 的 `message_update` 只发 delta，前端按 `contentIndex` 累积 content——一轮含 `text → toolCall → text` 时 toolCall 占位的索引从未赋值，产生稀疏数组空洞（历史 JSONL 也可能带 null 元素）；`MessageList.segmentBlocks` 用 for 循环直接 `blocks[idx]` 访问（不跳过空洞），元素 undefined 时 `b.type` 崩溃，fleet/delegate 场景最易触发（调用前 text + 调用后 text 正好形成空洞）。修复：`segmentBlocks` 跳过 undefined 元素；同步给 `StreamingRow.hasContent`、`hasMeaningfulContent`、`FleetCard`/`DelegateCard`/`ToolCallCard` 的 content 遍历加 `?.` 保护（防御其他渲染路径）。新增稀疏空洞/显式 undefined 渲染测试 2 例，全量 1235 例通过。
  - 影响范围：`packages/frontend/src/components/MessageList.tsx`、`packages/frontend/src/store/session.ts`、`packages/frontend/src/components/blocks/FleetCard.tsx`、`packages/frontend/src/components/blocks/DelegateCard.tsx`、`packages/frontend/src/components/blocks/ToolCallCard.tsx`、`packages/frontend/tests/MessageList-sparse-content.test.tsx`。
- **调整(frontend)：初始化引导入口从「通用」迁移到「关于」tab，按钮改为 icon**。入口形态改为说明文字「重新打开新手引导，配置模型与默认智能体」+ 火箭 icon 按钮（testid `reopen-onboarding` 不变）；i18n 键从 `settings.general.onboarding.*` 移到 `settings.about.onboardingDesc/onboardingButton`。
  - 影响范围：`packages/frontend/src/components/settings/AboutSection.tsx`、`GeneralSection.tsx`、`src/i18n/locales/{zh,en}.ts`、`e2e/onboarding-wizard.spec.ts`。
- **调整(frontend)：新建智能体面板细节优化**。命名面板的「← 返回列表」与「取消」改为同一行（左/右）；提示词预览弹窗标题栏加 × 关闭 icon（`preset-prompt-close`）；预设卡片网格从 2 列改为 3 列，弹窗宽度 560 → 720。
  - 影响范围：`packages/frontend/src/components/onboarding/AgentCreatePicker.tsx`、`packages/frontend/src/components/AgentGalleryModal.tsx`。
- **新增(kernel+frontend)：预设智能体支持右键查看完整提示词 + 部门筛选**。新建智能体面板的预设 Tab：卡片右键弹出完整提示词预览（新增 `GET /api/agents/presets/:id` 按需返回含正文的完整预设，列表接口仍只回元数据）；搜索框旁新增部门下拉筛选（与关键词搜索叠加生效）。
  - 影响范围：`packages/shared/src/types.ts`（`AgentPresetGetRequest`/`AgentPresetResult`）、`packages/kernel/src/ws-server.ts`、`packages/kernel/src/routes/agents.ts`、`packages/kernel/tests/agent-presets-routes.test.ts`、`packages/frontend/src/components/onboarding/AgentCreatePicker.tsx`、`packages/frontend/src/i18n/locales/{zh,en}.ts`。
- **修复(frontend)：宫格新建智能体面板改为独立弹窗**。之前 AgentCreatePicker 渲染在宫格卡片内部底部，被挤出视口导致点击「新建智能体」看似无反应；改为独立居中 Modal（标题栏 + 70vh 滚动区）。
  - 影响范围：`packages/frontend/src/components/AgentGalleryModal.tsx`。

---

- **修复(frontend)：fleet 并行派发同名 agent 任务时卡片内容串台**。根因：`FleetCard` 的 `extractAgentReplies` 用 `Map<agent, text>` 聚合——fleet 任务清单里出现同名 agent（LLM 常把多个独立任务派给同一智能体，schema 未禁止）时同名 `map.set` 覆盖，任务 1 的回复丢失、展开后显示任务 2 的内容；同时 `FleetTaskItem` 的 `key={r.agent}` 同名冲突触发 React 重复 key 警告。修复：`extractAgentReplies` 改为按段落顺序精确分配（同名按出现顺序对应同名任务），段落数与任务数不匹配（正文误含 `【】`/老数据无标记）时返回 null 降级为聚合显示；任务行 key 改为 `${index}-${agent}` 唯一。新增同名场景测试 3 个（任务 1/任务 2 各显其文 + 不同 agent 回归保护），原 18 个 FleetCard 测试全部保持通过。
  - 影响范围：`packages/frontend/src/components/blocks/FleetCard.tsx`、`packages/frontend/tests/FleetCard-same-agent.test.tsx`。

---

## 2026-08-08

### 变更

- **修复(kernel)：企微 IM 流式推送断线期 unhandledRejection 崩溃**。根因：`channel-manager.ts` 流式节流的 setTimeout 回调内 `void this.sendStreamFrame(...)` 缺少 `.catch()`——企微 WS 断线（网络波动/重连中）时 SDK `send()` 抛 `WebSocket not connected, unable to send data` 并经 `sendReply → processReplyQueue → item.reject` 传播，setTimeout 回调是独立异步任务、不在外层 `streamUpdate().catch()` 覆盖内，rejection 无人消费触发 kernel 崩溃日志。修复：该调用补 `.catch()`（与 streamUpdate/replyTurn/handleInbound 消费点模式一致），错误记 warn 后静默（agent_settled 终态仍会重试整轮回复）。新增回归测试「节流 setTimeout 回调：streamReply 失败（WS 断线）不产生 unhandledRejection，记 warn」，测试堆栈与线上 kernel-crash.log 完全一致。
  - 影响范围：`packages/kernel/src/channel-manager.ts`、`packages/kernel/tests/channel-manager.test.ts`。

---

## 2026-08-08 — 发版 v0.1.6

### 变更

- **发版(desktop)：发布 v0.1.6 桌面安装包（WA PI Agent，NSIS）到阿里云 OSS**。自 v0.1.4（08-08 16:05 打包）以来的增量：①新增任务完成/需要操作提示音（通用设置独立开关 + 试听，agent_end 终态与新 ask_user_question 触发，IM 渠道会话不播放）；②对话消息移除机器人/用户头像，仅保留智能体名字；③渠道流式回复适配 pi-ai 0.84（message_update 无 partial 快照，改 delta 累积）；④核心依赖批量升级（pi-ai ^0.84.1、vite ^8.2.1、electron ^43.3.0、electron-builder ^26.15.3 等）+ 修复 skillsAllOff 透传；⑤README 英文化（拆分 README.zh-CN.md）+ 插件生态截图 + i18n badge。产物 WaPi-Setup-0.1.6.exe + latest.yml（注入 releaseNotes）上传至 `coaicom/releases/`，终端用户通过「系统设置 → 关于」检查更新拉取。
  - 影响范围：`packages/desktop/package.json`（0.1.4 → 0.1.6）、`packages/frontend/package.json`（0.1.0 → 0.1.6）、`packages/desktop/RELEASE_NOTES.md`。

---

## 2026-08-08

### 变更

- **修复(frontend+kernel)：适配 pi 0.84 移除 message_update partial 快照的流式协议变更**。pi 0.84.0 起 RPC `message_update` 只发 `assistantMessageEvent` delta（text_delta/thinking_delta 的 contentIndex+delta），不再携带累积 `message` 字段与 `partial` 快照；此前 wa-pi 前端流式渲染与企微渠道流式推送都依赖被移除字段（前端打字机效果消失、channel-manager 因 `extractAssistantText([undefined])` 抛 TypeError 被静默吞掉致 IM 流式退化）。修复：前端 `store/session.ts` 改为在 message_start 骨架基础上把 delta 累积到对应 content block（text/thinking）；`channel-manager.ts` 增加 per-session delta 累积（message_start 重置 / message_end 清空 / agent_settled 清空），流式帧用「已落地文本 + 当前 delta 累积」拼装；`shared/types.ts` 镜像类型同步 0.84 契约（`AssistantMessageEvent.partial` 改可选、`message_update.message` 改可选），`event-throttle.ts` 注释更新。测试同步改写为 0.84 事件形状（store-session 3 例、channel-manager textDeltaEvent helper 与多消息轮边界事件）。
  - 影响范围：`packages/frontend/src/store/session.ts`、`packages/frontend/tests/store-session.test.ts`、`packages/kernel/src/channel-manager.ts`、`packages/kernel/tests/channel-manager.test.ts`、`packages/shared/src/types.ts`、`packages/kernel/src/event-throttle.ts`。

- **移除(frontend)：对话消息行不再显示机器人/用户头像，保留智能体名字**。`MessageList.tsx` 中正常 assistant 回复行与流式「思考中」加载占位两处的 robot 图标头像容器、以及用户消息行右侧的「我」占位方块均删除（名字行不变：AI 名字 + 时间、用户「我 · 时间」照常显示）。同步更新 `MessageList.test.tsx`：3 处头像断言改为「不再渲染 avatar-robot」+ 用名字行次数验证回合合并逻辑，3 处宽度断言从 `children[1]` 改为 `children[0]`（头像移除后内容列成为首个子元素），新增 1 个用户消息行内只剩内容列的断言。
  - 影响范围：`packages/frontend/src/components/MessageList.tsx`、`packages/frontend/tests/MessageList.test.tsx`。

---

## 2026-08-08

### 变更

- **文档：README 双语版头部增加中英界面支持标识**。两个版本（`README.md` / `README.zh-CN.md`）的关键词行末尾追加「中文 / English UI（双语界面）」，徽章行追加 i18n 徽章（shields.io，已验证可访问）。
  - 影响范围：`README.md`、`README.zh-CN.md`。

- **依赖升级(全仓):核心依赖批量升级到最新 minor/patch 版本**。覆盖 4 个包:kernel(`@earendil-works/pi-ai` ^0.83.0→^0.84.1、`@earendil-works/pi-coding-agent` ^0.83.0→^0.84.1、`@amaster.ai/pi-memory` ^0.1.6→^0.1.8、`pi-web-access` ^0.17.1→^0.19.0、`typebox` ^1.3.6→^1.3.11)、frontend(`vite` ^8.1.5→^8.2.1、`@vitejs/plugin-react` ^6.0.4→^6.0.5、`mermaid` ^11.16.0→^11.16.1、`happy-dom`/`@happy-dom/global-registrator` ^20.11.1→^20.11.2、`@playwright/test` ^1.62.0→^1.62.1、`@types/react` ^19.2.17→^19.2.18、`@types/react-dom` ^19.2.3→^19.2.4)、desktop(`electron` ^43→^43.3.0、`electron-builder` ^26→^26.15.3)、根(`@types/bun` ^1.3.0→^1.3.14)。大版本跳升项按约定保持不动:`pi-mcp-adapter` 2.17.0(项目自定义 patch)、`tailwindcss` 3(4 为 CSS-first 重构)、`typescript` 5(7 待单独评估)。验证:全仓 typecheck 通过、单测全绿(kernel 815 / shared 95 / desktop 56 / frontend 1199)、vite build 成功、E2E 核心流程通过。
  - 影响范围：`package.json`、`packages/{kernel,shared,frontend,desktop}/package.json`、`bun.lock`。

- **修复(kernel)：`WaPiSpawnConfig` 补充 `skillsAllOff` 字段，修复子代理技能全关语义失效**。`delegate-tool.ts` 访问 `config.skillsAllOff` 决定是否给子代理传空技能数组，但 `WaPiSpawnConfig`（subagent-runner.ts）从未定义该字段——运行时恒为 `undefined`，导致「显式全不选技能」永远走白名单分支、typecheck 报 TS2339。修复：接口补 `skillsAllOff?: boolean`，`agent-manager.ts` 的 `resolveSpawnConfig` 从 `AgentConfig` 透传该值。
  - 影响范围：`packages/kernel/src/subagent-runner.ts`、`packages/kernel/src/agent-manager.ts`。

- **文档：README 改为英文默认版，中文版拆分为 README.zh-CN.md，两版顶部互相跳转**。原中文 README 整体迁至 `README.zh-CN.md`（顶部加「[English](./README.md) | **简体中文**」切换行）；`README.md` 重写为完整英文版（忠实翻译全部章节：定位、三分钟上手、CLI vs GUI 对比、7 个特性节、架构、项目结构、开发、路线图五大方向），顶部加「**English** | [简体中文](./README.zh-CN.md)」切换行。截图素材共用 docs/assets/readme/（界面截图为中文 UI，与双语界面特性一致）。
  - 影响范围：`README.md`（重写为英文）、`README.zh-CN.md`（新增，原中文内容）。

- **文档：README 插件生态与 pi RPC 事件透明化升级为已交付亮点，新增插件管理截图**。经代码核实（rpc-client.ts / store/session.ts / ExtensionSection.tsx / extension-manager.ts）：重试/压缩/摘要进度提示、extension_error/setStatus/setWidget 可视化、插件动态安装/卸载/升级（热加载、markAllDirty + reloadExtensions）均已完整实现，从路线图「持续推进」注记移入「已经交付」清单（新增 2 条勾选）；核心特性新增「插件生态」大节（动态安装/卸载/升级、TUI 插件 UI 原语 GUI 原生呈现、slash 命令管理）并配新截图 `docs/assets/readme/readme-extensions.png`（Playwright 对运行中应用实拍，2880x1800@2x）；「可观测与诊断」节扩写为「运行状态透明化」。诚实性边界：tool_execution_update 的 partialResult 与 turn_* 遥测尚无 UI 消费，README 未宣称；TUI 支持表述限定为「UI 原语桥接」，不含全屏终端 UI。
  - 影响范围：`README.md`、`docs/assets/readme/readme-extensions.png`（新增）。

- **文档：README.md 全面重写（定位深化 + 路线图换新 + 修复过时点）**。定位在「pi agent 的 GUI 框架」基础上强化吸引力文案（新标语、截图前置、「三分钟上手」快速开始）；路线图未来方向替换为五大新方向——可视化流程编排、定时任务、连接器、产物分享、差异监控（各附一句话价值描述），已完成项补充 IM 机器人渠道、桌面自动更新、中英双语。修复 Explore 审查发现的过时点：`WA_PI_DIR` 默认值 `~/.wa-pi` → `~/.pi/agent`（2 处）；新增「IM 机器人渠道」（企业微信已支持、微信/飞书/QQ 预留）与「可观测与诊断」特性节；架构图与项目结构补充 IM 渠道；打包命令补充 `pack:all`；开发节补充 `WA_PI_PREVIEW_PORT` 与前端 e2e 说明。
  - 影响范围：`README.md`。

- **文档：重写 README.md，产品定位调整为「pi agent 的 GUI 框架」**。主标语从「多智能体协作工作台」改为「pi agent 的 GUI 框架——给 AI 编程智能体一个友好的桌面操作体验」；「这是什么」章节重写为 GUI 框架叙事（pi 引擎为内核、本框架提供图形化桌面体验、引擎与界面解耦），多智能体协作降级为框架之上的增值能力；新增「为什么选择 GUI」章节（CLI vs GUI 对比表）；架构章节补充「GUI 负责体验，pi 负责智能，内核负责编排」的职责定位。功能事实（特性、快速开始、项目结构、路线图等）保持不变。
  - 影响范围：`README.md`。

- **新增(frontend)：系统设置-通用新增「提示音」设置**。任务完成（agent_end 终态）与需要操作（新 ask_user_question 待回答）时播放 WebAudio 蜂鸣提示音，两种事件独立开关（默认开）、各带试听按钮，即时生效并持久化到 localStorage；浏览器自动播放策略阻止时静默降级。需要操作提示音带 500ms 去抖防叠加。开关以 switch 滑块呈现（位于「自动重试」上方）。IM 渠道会话（sessionId 以 `im-` 开头，如企业微信）不播放提示音。
  - 影响范围：`packages/frontend/src/util/sound.ts`（新增）、`packages/frontend/src/store/ui-prefs.ts`、`packages/frontend/src/store/session.ts`、`packages/frontend/src/components/settings/GeneralSection.tsx`、`packages/frontend/src/i18n/locales/{zh,en}.ts`。

- **修复(frontend)：系统设置-通用页签内所有内容改为保存后才生效**。字号滑块（fontSize）与导出轮数滑块（exportTurns）原来拖动即写 store 即时生效，与同页的语言/重试配置（草稿态 + 点保存生效）行为不一致。修复：两个滑块改为草稿态（draftFontSize/draftExportTurns），拖动只改界面显示，点「保存」时才调用 `setFontSize`/`setExportTurns` 应用（仅当与当前值不同才写入）；关闭弹窗不保存则还原。导出按钮运行时读取的是已保存的 store 值，语义不变。更新 1 个测试为草稿态断言 + 新增 1 个导出轮数草稿测试。
  - 影响范围：`packages/frontend/src/components/settings/GeneralSection.tsx`、`packages/frontend/tests/GeneralSection.test.tsx`。

- **移除(frontend)：技能 tab 的「全部勾选 = 全量继承；取消勾选后按显式列表保存」提示行**。AgentConfig 技能 tab 顶部不再显示 skillsHint 说明文字，删除组件中的提示段落与 en/zh 两个语言文件中的 `skillsHint` 翻译键（全部勾选开关和逐项勾选交互不变）。
  - 影响范围：`packages/frontend/src/components/AgentConfig.tsx`、`packages/frontend/src/i18n/locales/{en,zh}.ts`。

- **修复(frontend)：设置弹窗左侧导航选中 tab 高亮为会话选中同款浅绿**。SettingsModal 左侧导航（通用/模型/技能/…）选中 tab 原来用灰色底 `var(--surface-hover)` + `var(--brand)` 文字，与会话选中（SessionRow）的浅绿 `--accent-soft` 底 + `--accent` 文字不一致。修复：9 个导航 tab 的选中样式统一改为 `background: var(--accent-soft)`、`color: var(--accent)`，与会话选中视觉对齐。新增回归测试（选中 tab 浅绿、切换后旧 tab 恢复无底色）。
  - 影响范围：`packages/frontend/src/components/SettingsModal.tsx`、`packages/frontend/tests/SettingsModal.test.tsx`。

- **重构(desktop)：自动更新源 Gitee Release → 阿里云 OSS**。Gitee Release 单文件 100MB 限制与 146MB 安装包冲突，改为 OSS（bucket `coaicom`，河源 region，公开读）。改用 electron-updater 内置 GenericProvider（`setFeedURL`），删除自定义 GiteeProvider/gitee-api（OSS 是静态对象存储，无需 Gitee 的 API 层列附件）。`publish-gitee.ts` 换成 `publish-oss.ts`（ali-oss SDK，分片上传 exe + 注入 releaseNotes 到 latest.yml）。electron-builder.yml 加 `publish: generic` 配置使打包自动生成 latest.yml。AK/SK 只走环境变量。
  - 影响范围：删除 `packages/desktop/src/updater/gitee-api.{cjs,test.ts}`、`gitee-provider.{cjs,test.ts}`、`scripts/publish-gitee.ts`；改 `updater.cjs`/`main.cjs`/`electron-builder.yml`；新增 `scripts/publish-oss.ts`、`packages/desktop/RELEASE_NOTES.md`；根 `package.json` 加 devDep `ali-oss`。

- **新增功能(frontend)：侧边栏「新建项目」入口移至「项目」标题行右侧 + 图标**。有用户项目时，新建入口从列表底部文字按钮移到「项目」分组标题行右侧的 + 图标按钮（复用 Icon 组件 plus 图标，title/aria-label 提示「新建项目」，hover 变 brand 色）；无用户项目时保持现状（底部文字按钮、标题行不渲染）。i18n 新增 projectList.newProjectHint 中英文案。新增有项目场景组件测试（+ 图标存在、底部按钮隐藏、点击触发新建），强化无项目场景回归断言。
  - 影响范围：`packages/frontend/src/components/ProjectList.tsx`、`packages/frontend/src/i18n/locales/{en,zh}.ts`、`packages/frontend/tests/ProjectList.test.tsx`。

- **新增功能：桌面版「系统设置 → 关于」应用版本检查与自动更新（electron-updater）**。desktop 新增 `updater/` 模块（updater 装配层 NsisUpdater + IPC + 事件翻译），preload 暴露 `waPiUpdater` 桥接，main.cjs 接线 `setupUpdater`；frontend 新增 updater store（Zustand 状态机 + IPC 桥接）+ 设置页「关于」页签（AboutSection 6 状态 UI，全量 i18n 中英双语）；浏览器版经 vite define 注入 package.json 版本号，关于页同样显示版本（桌面版由 app.getVersion() 覆盖）。四层测试：desktop 单测、前端组件测试、E2E（mock waPiUpdater 完整流程）。

- **新增功能：输入框支持 Ctrl+Enter（macOS Cmd+Enter）引导发送**。agent 运行中（回复过程中）按 Ctrl+Enter 直接把输入框内容作为引导（steering）消息发送（调 `/api/sessions/:sessionId/steer`，乐观更新引导队列），空闲时等同普通发送；Enter 行为不变（运行中仍进排队队列），Shift+Enter 换行不变。`ComposerInput` 新增 `onSendSteer` prop 与 Ctrl/Cmd+Enter 按键分支（保留 IME 组词保护），`Composer` 新增 `handleSendSteer` 回调（空闲委托 doSend、运行中复刻 `SessionView.handlePromote` 的 steering 队列去重模式，不设 optimisticEcho——`/steer` 不触发 `session:echo_user`；运行中仅清空文本、保留附件）。新增 3 个组件测试（运行中→/steer、空闲→/prompt、IME 拦截）。
  - 影响范围：`packages/frontend/src/components/Composer.tsx`、`packages/frontend/src/components/ui/ComposerInput.tsx`、`packages/frontend/tests/Composer.test.tsx`。

- **修复(kernel)：会话被清理与后台预热/拉取历史并发时的竞态噪音日志降级**。四个 `console.error`（拉取历史消息失败 / 后台预热会话进程失败 / pi rpc 进程已退出 / 会话已清理）在 `reapIdleSessions` 或 `session:delete` 与冷启动并发时成串打印，视觉上等同崩溃，实为预期关闭流程（jsonl 直读已兜底历史、dispose 只杀进程保留会话记录、下次发消息会重新拉起）。修复：①`agent-manager.ts` `_createSession` 的 `getMessages` catch 中 `disposed.has(sessionId)` 命中（dispose 打断拉取）→ 静默；②「会话已清理」错误加 `code = "SESSION_DISPOSED"` 语义标记；③`ws-server.ts` `prewarm` catch 识别 `SESSION_DISPOSED` → 静默。真异常（进程崩溃、非 dispose 启动失败）仍打 error 便于排障。新增 4 个回归测试（dispose 竞态静默 + 非 dispose 仍打印，agent-manager 与 ws-server 各 2 个）。
  - 影响范围：`packages/kernel/src/agent-manager.ts`、`packages/kernel/src/ws-server.ts`、`packages/kernel/tests/agent-manager.test.ts`、`packages/kernel/tests/ws-server-session-prewarm.test.ts`。

- **修复(frontend)：新建页切换模型后发送，聊天界面模型选择器显示旧模型**。`NewSessionPane` 的 `setModel` 回调原来只更新本地 state + 全局 `defaults.model`，未写入会话级 `bySession[sessionId].model`；发送后进入会话 `Composer` 读取会话级 prefs 显示旧模型（用户选的模型 A 变成了旧值 B）。修复：`setModel` 回调同步调用 `setSessionPrefs(sessionId, { model: m })`，与 `Composer.tsx` 行为对齐。新增回归测试 `NewSessionPane.test.tsx`（新建页切换模型后发送 → 会话级 prefs 记录所选模型）。
  - 影响范围：`packages/frontend/src/components/NewSessionPane.tsx`、`packages/frontend/tests/NewSessionPane.test.tsx`。

---

## 2026-08-07

### 变更

- **新增功能** — 初始化向导：无模型时自动弹出两步引导（配置模型 → 设置默认智能体），设置页可重开；智能体支持从 268 个 agency 预设库选择并以人名保存（随机人名可改）；宫格新建流程升级为同一面板；新建会话默认智能体优先使用向导设置值。附带修复 kernel bug：`agent:prompt` 的 `agent_missing` 拦截在 REST 化后只 `reply` 不上事件总线，导致前端重选弹窗不可达，补一行 `broadcast` 恢复 WS 时代语义。影响范围：kernel（preset-store、agents 路由、ws-server cases）、shared（agency-presets 类型）、frontend（onboarding 向导、AgentCreatePicker、ui-prefs、NewSessionPane、AgentGalleryModal、GeneralSection）

- **前端 6 个组件文案接入 i18n（中英双语）**：`NewSessionPane`/`AgentGalleryModal`/`AgentListSection`/`ProjectItem`/`Composer`/`CommandPalette` 的硬编码中文 UI 文案替换为 `t()`。各组件经门面 `import { useTranslation } from "../i18n/useTranslation"` 引入并在组件内 `const { t } = useTranslation()`。
  - `NewSessionPane`：标题/副标题/无项目选项/placeholder 接入 `newSession.*`；placeholder 用 `t("newSession.placeholder", { agent: agentName ?? "研发" })` 保留占位回退。
  - `AgentGalleryModal`：usageHint 改用 `t("agentGallery.usageHint", { count, names })` 拼接前导 `\n`（与原 `\n注意：...` 输出一致）；标题 `全部智能体 N 个` → `agentGallery.titleAllCount`（资源值已含" 个"，断言通过）；placeholder/确定/取消/新建/内置/页脚/右键查看·编辑/删除确认框接入 `agentGallery.*` + `common.*`。`SUBAGENT_TYPES.map(t => ...)` 参数遮蔽翻译函数 `t`，提前算好 `builtinBadge` 常量传入 JSX。
  - `AgentListSection`：usageHint 同 Gallery 模式；区头/更多入口/placeholder/新增/右键编辑·删除/确认框接入 `agentList.*` + `common.*`。
  - `ProjectItem`：prompt 标题、右键重命名/删除聊天/删除项目、ConfirmDialog title/message/confirmText 接入 `projectItem.*` + `common.delete`；`openInFileManagerLabel()` 调用保持不变（util 单独迁移）。
  - `Composer`：placeholder 三态接入 `composerExtra.placeholderBlocked`/`placeholderQueued` + 复用 `newSession.placeholder`。
  - `CommandPalette`：命令/技能分组、系统设置/智能体管理标题及其 hint、placeholder、空态、底部 导航/执行/关闭 接入 `commandPalette.*` + `composer.cmdSettings`/`cmdAgents`/`cmdAgentsDesc` + `common.close`；`commandItems`/`skillItems` 的 useMemo 依赖数组补 `t`。
  - 验证：`bun run test tests/NewSessionPane.test.tsx tests/AgentGalleryModal.test.tsx tests/AgentListSection.test.tsx tests/ProjectItem.system.test.tsx tests/CommandPalette.test.tsx tests/Composer.test.tsx` 81 pass / 0 fail，测试文件未改动。关键断言（搜索技能和命令... / 技能 / 命令 / 系统设置 / 智能体管理 / 没有匹配的结果、更多智能体 (2)、内置 / N 个）全绿。
  - 影响范围：`packages/frontend/src/components/NewSessionPane.tsx`、`AgentGalleryModal.tsx`、`AgentListSection.tsx`、`ProjectItem.tsx`、`Composer.tsx`、`CommandPalette.tsx`。

---

### 变更

- **前端 7 个组件文案接入 i18n（中英双语）**：`ImConversationList`/`ExtensionDialog`/`AgentSwitcher`/`SessionRow`/`AgentMissingModal`/`Sidebar`/`ProjectList` 的硬编码中文 UI 文案替换为 `t()`。各组件经门面 `import { useTranslation } from "../i18n/useTranslation"` 引入并在组件内 `const { t } = useTranslation()`。
  - `ImConversationList`：模块级 `titleOf` 改为组件内函数（依赖 `t`），群聊标题用 `t("im.groupTitle", { chatId, from })`；空态 `im.emptyHint`、菜单 `im.deleteChat`、确认框 `im.deleteConfirmMessage`/`common.delete`。`ImConvRow` 通过 `titleOf` prop 接收组件内函数。
  - `ExtensionDialog`：footer 与 select-only 态取消/确认按钮 → `common.cancel`/`common.confirm`（动态 req 载荷不迁移）。
  - `AgentSwitcher`：`已切换为 ${agentName}` 在写入 message.content 时构造时插值 `t("agentSwitcher.switchedMessage", { agent })`（避免存入模板占位符，保证测试断言 `content==="已切换为 代码审查"`）；确认框 title/message/cancel/confirm 接入 `agentSwitcher.*` + `common.cancel`。`t` 加入 effect 依赖数组。
  - `SessionRow`：`运行中` aria-label → `common.statusRunning`；`有新回复` aria-label 资源无对应 key，按指示保留原文。
  - `AgentMissingModal`：标题/正文/空列表 → `agentMissing.title`/`message`/`empty`。
  - `Sidebar`：tab 文案 `任务`/`IM` → `sidebar.tabTasks`/`tabIm`；tab 循环变量 `t` 重命名为 `tabKey` 以让位翻译函数 `t`（必须改动）。品牌名 WA PI Agent 不迁移。
  - `ProjectList`：区头 `项目` → `projectList.sectionTitle`；`＋ 新建项目` → `projectList.newProject`。
  - 验证：`bun run test tests/ImConversationList.test.tsx tests/ExtensionDialog.test.tsx tests/AgentSwitcher.test.tsx tests/App-agent-missing.test.tsx tests/ProjectList.test.tsx tests/Sidebar.test.tsx` 38 pass / 1 skip / 0 fail，测试文件未改动。关键断言（ImConversationList 群聊(wr_abcde) · lisi / 暂无 IM 会话、AgentSwitcher content==="已切换为 代码审查"、AgentMissingModal 请重新选择智能体后重发消息、ProjectList 项目）全绿。
  - 影响范围：`packages/frontend/src/components/ImConversationList.tsx`、`ExtensionDialog.tsx`、`AgentSwitcher.tsx`、`SessionRow.tsx`、`AgentMissingModal.tsx`、`Sidebar.tsx`、`ProjectList.tsx`。

---

### 变更

- **前端 5 个组件 + platform.ts 文案接入 i18n（中英双语）**：`EmptyState`/`SettingsButton`/`NewSessionButton`/`ExplorerPanel` 硬编码中文 UI 文案替换为 `t()`；`util/platform.ts` 的 `openInFileManagerLabel` 改造为接收可选 `labels` 参数（默认回退中文，行为不变）。
  - 各组件经门面 `import { useTranslation } from "../i18n/useTranslation"` 引入并在组件内 `const { t } = useTranslation()`。
  - `EmptyState`：标题/副标题/新建项目按钮（`emptyState.*`）。
  - `SettingsButton`：`系统设置` 文案 + `aria-label`/`title`（`settings.title`）。
  - `NewSessionButton`：`＋ 新建会话`（`sidebar.newSession`）。
  - `ExplorerPanel`：右键菜单 `复制路径`、toast `打开失败`、占位 `未设置工作目录`/`加载失败：${error}`/`加载中…`（`explorer.*` + `common.loading`）。子组件 `ExplorerContextMenu` 通过 `t` props 接收翻译函数（类型 `TFunction`）。`openInFileManagerLabel()` 调用保持不变（util 改造，组件本轮不改）。
  - `util/platform.ts`：`openInFileManagerLabel` 改为 `openInFileManagerLabel(labels?)`，不传参时回退原中文默认值，保证普通函数调用与单测行为零变化；为后续组件传入 i18n 值预留入口。
  - 验证：`bun run test tests/ExplorerPanel.test.tsx tests/SettingsButton.test.tsx tests/NewSessionButton.test.tsx tests/ProjectItem.system.test.tsx` 14 pass / 0 fail；`bun run typecheck` 通过。关键断言（ExplorerPanel 复制路径/在资源管理器中打开/未设置工作目录、NewSessionButton 含新建会话）全绿，测试文件未改动。
  - 影响范围：`packages/frontend/src/components/EmptyState.tsx`、`SettingsButton.tsx`、`NewSessionButton.tsx`、`ExplorerPanel.tsx`、`packages/frontend/src/util/platform.ts`。

---

## 2026-08-07

### 变更

- **前端 ask 提问卡 + 目录树选择器文案接入 i18n（中英双语）**：`src/components/ask/AskFormCard.tsx` 与 `src/components/DirTreePicker.tsx` 的硬编码中文 UI 文案替换为 `t()`。经门面 import `useTranslation`（ask 目录用 `../../i18n/useTranslation`，根目录 `components/` 用 `../i18n/useTranslation`）并在组件内 `const { t } = useTranslation()`。
  - `AskFormCard`：标题插值（`emoji`+`agent` 回退 `ask.agentFallback`）、`aria-label` 终止、其他选项、自定义答案 placeholder、备注 label、stale/提交失败两处错误文案、取消、提交中/提交按钮全部接入。
  - `DirTreePicker`：`buildSearchTree` 由模块级函数改为接收 `rootName` 参数（由组件传入 `t("filePicker.thisPc")`）；初始 root 占位 `加载中…`、主 tree 根 `此电脑`、标题「选择项目目录」、搜索 placeholder/搜索中/无匹配、treeLabel 目录、显示隐藏目录、取消、选择按钮全部接入；复用 `filePicker.*` 与 `dirPicker.*` key。
  - `AskDock` 经核对无硬编码 UI 文案（仅注释），跳过。
  - 验证：`bun run test tests/AskFormCard.test.tsx tests/AskDock.test.tsx tests/DirTreePicker.test.tsx` 38 pass / 0 fail，测试文件未改动。
  - 影响范围：`packages/frontend/src/components/ask/AskFormCard.tsx`、`packages/frontend/src/components/DirTreePicker.tsx`。

---

## 2026-08-07

### 变更

- **记忆模块 4 个组件文案接入 i18n（中英双语）**：`src/components/memory/` 下 `MemoryPage`/`MemoryCard`/`MemoryEmpty`/`InstructionItem` 全部硬编码中文 UI 文案替换为 `t()`。各组件顶部经门面 `import { useTranslation } from "../../i18n/useTranslation"` 引入并在组件内 `const { t } = useTranslation()`。
  - `MemoryPage`：标题/开关/tab label/筛选 chip/分类 chip/添加按钮/表单 placeholder/取消保存/作用域下拉文案（含 `📁 {{name}}` 插值）。**tab label 资源值保持 `已保存`/`归档`/`指令文件`，`data-testid={tab-${label}}` 自然不变**，5 处单测 + 4 处 E2E 断言零回归；筛选 `filterProject` 中文值保持「项目」满足 E2E `getByRole("button",{name:"项目"})`。
  - `MemoryCard`：模块级 `CATEGORY_STYLE` 常量把中文 `label` 改为 `labelKey`（存 i18n key），组件内用 `t(cat.labelKey)` 渲染；作用域标记/编辑按钮/归档时间（含插值）/操作按钮全部接入。
  - `MemoryEmpty`/`InstructionItem`：空状态标题与提示、作用域徽标/查看/关闭按钮全部接入。
  - 验证：`bun run test tests/MemoryPage.test.tsx` 17 pass / 0 fail。资源 key 中文值与原硬编码值逐一核对一致，测试文件未改动。
  - 影响范围：`packages/frontend/src/components/memory/MemoryPage.tsx`、`MemoryCard.tsx`、`MemoryEmpty.tsx`、`InstructionItem.tsx`。

---

## 2026-08-08

### 变更

- **i18n 修复：补齐英文界面露中文的遗漏点 + 非组件层文案迁移**：
  - **组件层遗漏**：`openInFileManagerLabel()` 4 处调用（ExplorerPanel/ProjectItem×2/FileViewer）补传 i18n labels；FileViewer markdown 头 `title="关闭"` 漏改修复；`main.tsx` ErrorBoundary 兜底页（应用发生错误/重新加载）改用 i18next 实例 t（class 组件不能用 hook，但 ./i18n 已先初始化）。
  - **store/工具层用户可见文案**：`store/session.ts`（压缩上下文 5 处消息 + 扩展错误 toast）、`store/projects.ts`（重复目录提示）、`store/mcp.ts`（连接失败）、`store/recording.ts`（busy 冲突 Error/录音文件名/beforeunload 提示）、`recording/recorder.ts`（已有录音/无音频轨道 Error）、`fs-client.ts`（不支持预览/读取失败/复制失败）全部接入 i18n（统一 `import i18n from "../i18n"` 走门面实例，解决 `bun test --isolate` 下直接 import i18next 实例未初始化的问题）。
  - **耦合判断解耦**：`store/session.ts` 的 `startsWith("已压缩")` 改用结构化 `compactionEnded` 标志判断压缩是否结束（避免 i18n 化后文案判断失效）；`AskFormCard` 的 `message.includes("失效")` 改用 HTTP 400 状态判断。
  - **MermaidBlock** 3 处内部中文 Error 改英文（技术性错误，不直接露界面）。
  - 新增 key：`message.compactionProgress/Aborted/Failed/Done/DoneNoToken`、`message.extensionError`、`store.duplicateProjectCwd/mcpConnectFailed/recordingFile/recordingBusy/recordingNoAudioTrack/unsupportedPreview/readFailed/copyFailedShort`、`common.appError`。
  - 验证：全量单测 1158 pass / typecheck 通过。
  - 影响范围：`packages/frontend`（`src/store/`、`src/recording/`、`src/fs-client.ts`、`src/main.tsx`、`src/components/`、`src/i18n/locales/`）。

- **前端引入国际化（i18n）基础设施，中/英双语支持**：引入 `react-i18next`，搭建 i18n 框架（`src/i18n/`：`index.ts` 模块顶层初始化 i18next 实例、`detect.ts` 首次启动语言检测纯函数、`locales/zh.ts`+`en.ts` 翻译资源）。**首次启动按 `navigator.language` 自动选择**（`zh*`→中文，其余→英文，无法访问 navigator 时回退中文；用户显式选择过则尊重 localStorage 持久化值）。扩展 `ui-prefs` store 新增 `language` 字段 + `setLanguage`（同步 i18n 实例 + `<html lang>`），`main.tsx` 在渲染前完成语言决策。
  - **系统设置-通用新增「语言」切换项**（下拉，中文/English，`data-testid=language-select`），即时生效并持久化到 localStorage。
  - 设置弹窗 `SettingsModal`（标题+8 项导航）与 `GeneralSection` 全部文案接入 `t()`；**设置面板全部 8 个分区及子弹窗**完成中英双语；**前端全部组件文案完成中英双语**——核心交互（MessageList/ComposerInput/SessionView/App/AgentConfig/FilePicker）、`blocks/` 全部消息块（11 个）、`ui/` 全部控件（8 个）、`mcp/`（6 个）、`memory/`（4 个）、`ask/`（2 个）、根目录长尾（DirTreePicker/NewSessionPane/AgentGalleryModal/ProjectItem/CommandPalette/Composer/AgentListSection/ExplorerPanel/ImConversationList/ExtensionDialog/AgentSwitcher/SessionRow/AgentMissingModal/Sidebar/ProjectList/EmptyState/SettingsButton/NewSessionButton）及 `util/platform.ts`（openInFileManagerLabel 改为可选参数，默认行为不变）。
  - 测试基建：`happydom-setup.ts` 通过环境变量 `WA_PI_LANG` 锁定组件测试为中文（解决 `bun test --isolate` 下 globalThis 不共享的时序问题），新增 `.env.test` + `bun --env-file=.env.test test` 跨平台加载；引入 `src/i18n/useTranslation.ts` 门面确保每个组件模块图触发 i18next 初始化。新增 `i18n-detect`/`store-ui-prefs-language` 单测、`GeneralSection-language` 组件测试、`language-switch` E2E。全量单测/组件测试不回归。
  - 影响范围：`packages/frontend`（`src/i18n/`、`src/store/ui-prefs.ts`、`src/main.tsx`、`src/components/` 全部、`src/util/platform.ts`、`tests/`、`e2e/`、`.env.test`、`package.json`）。

- **清理已沉淀的设计原型 mockup 与早期差异文档**：删除 `docs/superpowers/mockups/` 下 16 个早期 UI 原型 HTML（其设计已沉淀进 `docs/superpowers/specs/2026-07-05-wa-pi-design.md`）及 `docs/chat-ui-diff-cocode-vs-wa-pi.md`（cocode vs wa-pi 早期 UI 差异对比，已被实际实现取代）。specs 文档附录中的 mockup 索引保留为历史溯源记录。
  影响范围：`docs/superpowers/mockups/`（删除）、`docs/chat-ui-diff-cocode-vs-wa-pi.md`（删除）。
- **新增初始化向导（Onboarding Wizard）设计文档**：
  `docs/superpowers/specs/2026-08-07-onboarding-wizard-design.md`（状态：已确认）。针对首次启动无模型时的硬性阻塞点，设计 2 步初始化向导：①配置模型（复用供应商表单）→ ②设置默认智能体（新建或从 agency-agents-zh 预设库选）。文档含触发时机、步骤流程、关键决策与字段映射。
  影响范围：`docs/superpowers/specs/`（纯设计文档，无运行时代码改动）。
  - *更新*：步骤流程决策调整——两步均不强制（第 1 步未保存模型也可直接进入第 2 步，第 2 步可跳过），简化流程图。原「下一步置灰」机制移除。
- **引入 agency-agents-zh 中文角色智能体参考库（MIT，纯参考资料）**：
  从 [jnMetaCode/agency-agents-zh](https://github.com/jnMetaCode/agency-agents-zh)（19k+ Stars）
  下载完整仓库（main 分支 tarball，原文未改动）至 `docs/references/agency-agents-zh/`。
  该库含 **268 个中文角色智能体**（带身份/规则/工作流/交付物的真 agent 定义，非单段提示词），
  覆盖工程/设计/营销/产品/游戏/安全/GIS/金融等 19 个部门。许可证为 MIT（含原英文版与中文翻译双版权声明），
  随附原始 `LICENSE`。**不接入运行时**（不并入 `DEFAULT_AGENT_SEEDS`、不写 `~/.wa-pi/agents/`、不接前端 UI）；
  另生成 `README-INDEX.md`：完整智能体索引 + 与 hiagent 角色 `.md` 格式的字段映射对照
  （`name→displayName` / `emoji→avatar` / 正文→`systemPromptBody` 等），便于将来评估接入。
  影响范围：`docs/references/agency-agents-zh/`（整库 + 新增 `README-INDEX.md`，无运行时代码改动）。

### 修复

- **添加/编辑供应商弹窗点击阴影不再关闭**：`ProviderFormModal` 传入 `closeOnOverlayClick={false}`，防止用户填写表单时误点遮罩丢失已输入内容。ESC、取消按钮仍可关闭。
  - 影响范围：`packages/frontend/src/components/settings/ProviderFormModal.tsx`、`packages/frontend/tests/ProviderFormModal.test.tsx`。

---

## 2026-08-07

### 新增功能

- **编辑智能体弹窗 - 技能 tab 改造**：
  1. 顶部新增「全部勾选」开关，支持在全选↔全不选间切换；逐项取消至全部为空时也自动进入全不选态。
  2. 新增 `AgentConfig.skillsAllOff?: boolean` 字段表达"显式全不选"——此前 `skills:[]` 被复用为"继承全部"，无法表达"不加载任何技能"。kernel 主会话与子代理派发路径均已识别该字段，`skillsAllOff=true` 时 `--skill` 列表为空（`--no-skills` 仍传，运行时确为零技能）。
  3. 技能名不再换行（`whitespace-nowrap`）；技能描述超长省略，点击弹出气泡显示完整描述，再次点击/点击外部关闭（新增轻量内联 `SkillDescBubble` 子组件，不引入第三方库）。
  - 影响范围：`packages/shared/src/types.ts`、`packages/kernel/src/agent-md.ts`、`packages/kernel/src/agent-manager.ts`、`packages/kernel/src/delegate-tool.ts`、`packages/frontend/src/components/AgentConfig.tsx` 及对应 kernel/前端测试、`packages/frontend/e2e/agents.spec.ts`。

### 修复

- **角色选择器小窗口下不再超出屏幕**：
  1. `NewSessionPane` 项目下拉（`select`）缺 `min-w-0`，选中项文本撑出 min-content 宽度，把同行角色选择器 pill 挤出可视区——补 `min-w-0` 让其可收缩；
  2. `AgentDropdown` 根节点补 `min-w-0 max-w-full`、pill 按钮补 `w-full`、警示文案补 `truncate`，使 pill 在窄行内可截断收缩；
  3. 下拉菜单新增视口钳制：展开后实测边界，左右任一侧超出可视区 8px 边距即用 `translateX` 平移回屏幕内，并加 `max-w-[calc(100vw-16px)]` 兜底。
  - 影响范围：`packages/frontend/src/components/ui/AgentDropdown.tsx`、`packages/frontend/src/components/NewSessionPane.tsx`、`packages/frontend/tests/AgentDropdown.test.tsx`。
- **委托/工具/思考卡片长文本不再撑破卡片**：`ProcessCard` 基座 body 统一加 `overflow-wrap:anywhere`（可继承，覆盖所有过程卡），长无空格串（路径/base64/URL）任意位置断行；同时修复 `DelegateCard` 任务行 flex 子项因 min-content 不收缩导致的溢出。此前仅 markdown 正文气泡有换行兜底，卡片正文缺失。
  - 影响范围：`packages/frontend/src/components/blocks/ProcessCard.tsx`、`packages/frontend/tests/ProcessCard.test.tsx`。
- **统一「打开系统文件/目录」入口文案，按平台区分**：
  4 处入口文案此前各不相同（「在访达中显示」「在系统查看文件」「查看文件夹」「打开工作目录」），统一为同一句平台相关文案：Windows 显示「在资源管理器中打开」、macOS 显示「在访达中打开」、Linux/其他显示「在文件管理器中打开」。前端此前无平台检测能力，新增 `packages/frontend/src/util/platform.ts`（基于 `navigator.userAgent` 的纯前端客户端检测）。FileViewer unsupported 按钮补 `data-testid="fv-reveal"` 让 E2E 平台无关。后端逻辑（kernel spawn / REST / WS 端点）未改动。
  - 影响范围：`packages/frontend/src/util/platform.ts`（新）、`packages/frontend/src/components/{ExplorerPanel,ProjectItem}.tsx`、`packages/frontend/src/components/blocks/FileViewer.tsx`、`packages/frontend/tests/{platform,ExplorerPanel,FileViewer,ProjectItem.system}.test.tsx`、`packages/frontend/e2e/{explorer.spec,default-workspace.spec,global-setup}.ts`。

### 新增

- **企微机器人默认工作目录 + 切换工作目录开关**：机器人配置新增「默认工作目录」（默认 `__system__`）与「允许切换工作目录」开关（默认关闭）。
  - 动机：原所有 IM 会话硬性落在默认工作区，且 `/use`、`/projects` 对所有机器人无条件开放。
  - 改动：
    - `ChannelConfig` 新增 `defaultProjectId`、`allowProjectSwitch` 字段。
    - `loadChannels` 读取旧数据归一化兜底；`validateChannelInput` 对缺失 `defaultProjectId` 回退默认工作区。
    - `channel-manager` 新建 IM 映射时使用渠道默认工作区；`ensureSession` 对失效 projectId 降级为默认工作区并 warn。
    - `commands.ts` 新增 `CommandContext.allowSwitch`，关闭时 `/use`、`/projects` 返回拒绝回复，`/help` 文案不含这两条。
    - 前端 `BotsSection` 表单新增项目下拉与 checkbox。
  - 兼容：旧 `channels.json` 无需迁移，读取时兜底。
  - 影响范围：`packages/shared/src/types.ts`、`packages/kernel/src/channel-store.ts`、`packages/kernel/src/channel-manager.ts`、`packages/kernel/src/channels/commands.ts`、`packages/kernel/tests/`（channel-store/channel-manager/channel-commands/mock-adapter）、`packages/frontend/src/components/settings/BotsSection.tsx`、`packages/frontend/tests/BotsSection.test.tsx`、`scripts/channels-api-it.sh`、`packages/frontend/e2e/wecom-bot-default-workdir.spec.ts`。

---

## 2026-08-07

### 新增

- **企微群聊会话从「群维度」改「群+用户维度」隔离**：此前同一群里所有用户共享一个会话（A 的上下文 B 可见）；
  现改为同群每个用户各开独立会话（key 从 `channelId:chatId` 升级为 `channelId:chatId:fromUserId`），
  A/B 上下文互不可见，且修复了同群多用户并发流式回复串帧的潜在 bug。
  - 数据结构：`ChannelSessionMapping` 增 `fromUserId`；`ChannelConversationInfo` 增 `fromUserId`。
  - 迁移：`loadChannelMappings` 一次性升级 `schemaVersion` 1→2，单聊无损补 `fromUserId=chatId`，
    群聊旧记录保留在 IM 列表但不再续接（该群用户下次发消息按新维度新建），可右键删除。
  - UI：IM 列表群聊会话标题改为「群聊(群id前8位) · 发送者userid」；会话详情来源文案追加群与发送者。
  - mock 链路：`mockInbound` / `ws-server` / `routes/channels` 透传 `fromUserId`/`chatType`，E2E 可验证群隔离。
  - 影响范围：`packages/shared/src/types.ts`、`packages/kernel/src/channel-store.ts`（迁移）、
    `packages/kernel/src/channel-manager.ts`（key/find/title/listConversations/mockInbound）、
    `packages/kernel/src/ws-server.ts`、`packages/kernel/src/routes/channels.ts`、
    `packages/frontend/src/components/ImConversationList.tsx`、`packages/frontend/src/App.tsx`、对应测试。

---

## 2026-08-07

### 新增

- **IM `/new` 命令保留历史会话 + IM tab 右键删除**：此前 `/new` 只删除"IM 对话→会话"的映射指针，
  旧会话虽仍在磁盘但从 IM tab 消失、无法查看和删除。
  - `/new` 改为归档当前会话（写入 `historySessionIds`）而非丢弃；旧会话继续在 IM tab 显示，
    新会话作为当前活跃会话，同一 IM 对话下可有多条历史会话。
  - `listConversations` 同时返回当前活跃会话与历史归档会话（实体已删则不显示）。
  - IM tab 会话项新增右键菜单「删除聊天」，确认后走既有 `DELETE /api/sessions/:id`；
    删除时联动清理 IM 映射（当前指针 + 历史归档）并广播刷新。
  - 影响范围：`packages/kernel/src/channel-store.ts`（`ChannelSessionMapping` 增 `historySessionIds`）、
    `packages/kernel/src/channel-manager.ts`（`/new` 归档、`listConversations` 返回历史、新增 `onSessionDeleted`）、
    `packages/kernel/src/ws-server.ts`（`session:delete` 联动调用）、
    `packages/frontend/src/components/ImConversationList.tsx`（右键菜单 + 删除确认）、对应测试。

### 修复

- **IM 消息自动弹出会话打扰工作**：企业微信发消息时，软件界面会自动切到 IM 会话视图，
  打断用户当前工作。
  - 根因：后端新建 IM 会话时广播 `session:created`，前端 `addSession` 无条件把新会话设为
    `currentSessionId`，派生 view effect 检测到后自动 `setView("session")` 弹出。
  - 修复：`addSession` 去掉自动设 `currentSessionId`/`currentProjectId` 的副作用，只 append。
    需要选中会话的调用方（NewSessionPane 用户主动新建）已显式调 `selectSession`，不受影响。
  - 影响范围：`packages/frontend/src/store/projects.ts`（addSession）、
    `packages/frontend/tests/store-projects.test.ts`（回归测试）。

### 新增

- **机器人回复粒度新增「极简」选项**：在原有「标准(正文+文件变更)」「简洁(仅正文)」基础上，
  增加 `minimal`（极简）——只把 Agent **最后一条 assistant 消息的全部文字**发给用户，
  丢弃工具调用前的过程性消息（如「我先检查一下」），适合只关心最终结果的场景。
  - 语义：「最后一条」= 一轮里按消息粒度取最后一条 role=assistant 的消息，拼接其全部 text 块；
    该消息若含多行多段则全部保留。
  - 流式行为：minimal 模式禁用流式增量推送（过程文字不实时显示），等 agent_settled
    一次性发送最后一条 assistant 消息全文，避免过程文字先流式显示再被覆盖。
  - 影响范围：`packages/shared/src/types.ts`（`ReplyGranularity` 扩展为
    `"minimal" | "simple" | "standard"`）、
    `packages/kernel/src/channels/reply-composer.ts`（`composeReply` 新增 minimal 分支 +
    `extractLastAssistantText`）、
    `packages/kernel/src/channel-manager.ts`（`streamUpdate` minimal 模式直接 return 禁流）、
    `packages/kernel/src/channel-store.ts`（校验白名单）、
    `packages/frontend/src/components/settings/BotsSection.tsx`（表单下拉新增选项）、
    对应测试。

### 修复

- **流式回复清空前序内容**：工具调用场景下，一轮产生多条 assistant 消息（文字→工具→文字），
  第二条消息流式时企微里之前已显示的内容被清空。
  - 根因：`streamUpdate` 只取当前 partial 的文本，不含本轮已落地的历史消息文本；
    企微 `replyStream` 是整体替换，新 partial 文本比旧内容短 → 看起来"清空"。
    附带修复节流 bug：挂起期间新 delta 未更新待发文本，只发首个 delta 的旧文本。
  - 修复：流式累计文本 = 本轮已落地 assistant 消息文本 + 当前 partial 文本；
    节流挂起期间更新 pendingText，timer 触发时发最新。
  - 影响范围：`packages/kernel/src/channel-manager.ts`（streamUpdate 文本拼接 + 节流）、
    `packages/kernel/tests/channel-manager.test.ts`（多消息轮流式回归测试）。

### 新增

- **企业微信流式回复**：IM 渠道回复从"整轮生成完才一次性发送"改为 token 级流式增量
  更新——企微里能看到回复像打字机一样实时增长。默认启用，适配器不支持时自动降级为整轮发送。
  - 技术基础：企微 SDK `replyStream(frame, streamId, content, finish)` 同 streamId 复用即可
    增量更新同一条消息；agent 层已有 `message_update`(text_delta) 事件，只是被
    `onSessionEvent` 的 `if (type !== "agent_settled") return` 挡掉了。
  - 改动：
    - `ChannelAdapter` 接口新增可选 `streamReply` 方法（能力探测，不实现则降级 sendText）
    - `WecomAdapter.streamReply` 用 `replyStreamNonBlocking`（背压自动跳帧）
    - `ChannelManager.onSessionEvent` 消费 `message_update`(text_delta) → 500ms 节流推送
      累计文本；`agent_settled` 发 finish=true 终结帧（composeReply 兜底含文件汇总）
    - 工具调用阶段无 text_delta，消息自然停在上一段文字末尾（不会卡住）
  - 兼容：适配器不支持 streamReply 时自动降级 sendText；错误回合始终走 sendText。
  - 影响范围：`packages/kernel/src/channels/{types,wecom-adapter,mock-adapter}.ts`、
    `packages/kernel/src/channel-manager.ts`、各层测试。

### 修复

- **IM 渠道：映射缓存的会话被删除后报"会话不存在"阻断通讯**：用户在 IM 对话中收到
  `处理出错：会话不存在: im-ch_xxx`，无法继续沟通。
  - 根因：`ChannelManager.ensureSession` 只检查 IM 映射里是否缓存了 sessionId，不校验该
    session 在 project-store 中是否还存在。当用户在前端删除会话、或数据文件被清理/迁移后，
    映射与实体不一致——`ensureStarted` 在 project-store 找不到 session 抛错，被入站 catch
    转成错误回复推给用户。
  - 修复：`ensureSession` 命中缓存时先用 `projectStore.load()` 校验 sessionId 存在；失效则
    清除旧映射、兜底新建会话（符合"IM 通讯不应被会话状态问题阻断"的原则）。同步移除遗留的
    `[dbg] ensureSession` 临时调试日志。
  - 影响范围：`packages/kernel/src/channel-manager.ts`（ensureSession 方法）、
    `packages/kernel/tests/channel-manager.test.ts`（新增失效会话兜底回归测试）。

- **IM 渠道会话泄漏到任务列表**：IM 消息创建的会话（`im-` 前缀）会出现在侧边栏"任务"
  页签的默认工作区下，用户感觉"消息进到了普通任务会话而不是 IM"。
  - 根因：`SessionEntity` 没有"类型/来源"字段，任务页签 `ProjectItem` 仅按 `projectId`
    过滤会话，不排除 IM 创建的会话——IM 会话 `projectId` 也是 `__system__`，于是混入
    任务列表。IM 页签（`ImConversationList`）走独立的 `/api/channel-conversations` 数据源，
    与任务页签互不过滤。
  - 修复：`ProjectItem` 会话过滤增加 `!s.id.startsWith("im-")`，让 IM 会话只归属 IM
    页签。最小改动，不改数据模型。
  - 影响范围：`packages/frontend/src/components/ProjectItem.tsx`（过滤条件）、
    `packages/frontend/tests/ProjectList.test.tsx`（新增 IM 会话排除回归测试）。

## 2026-07-30

### 修复

- **网络错误不再灌入对话流，改用状态条提示**：根因是底层 SDK（`@anthropic-ai/sdk` / `openai`）的 `APIConnectionError`（默认文案 "Connection error."）经 pi-ai 不变形塞进 `message_end{stopReason:"error", errorMessage}`，被 kernel 翻译成 `{type:"error"}` 后前端 append 成红色会话消息，且 pi 落盘到 JSONL 导致重连/重试 N 次堆积 N 条。修复：kernel 侧按错误文案分类——transient（网络/超时/限流/5xx）改广播 `{type:"net:status"}` 驱动顶部「模型连接异常」状态条，不进对话流；fatal（鉴权失败/配额耗尽/模型不可用）保留红色会话消息。同时历史回读过滤掉 transient error，避免刷新后残留。分类正则复用 pi-ai `utils/retry.js` 语义。
  - 影响范围：`packages/kernel/src/sdk-errors.ts`、`packages/kernel/src/index.ts`、`packages/kernel/src/session-history.ts`、`packages/shared/src/types.ts`、`packages/frontend/src/store/session.ts`、`packages/frontend/src/App.tsx`

- **每个会话固定自己的思考强度，未设置时回退全局默认**：根因是 `loadSession` 把 defaults.thinking 填进了每个会话的 bySession.thinking，导致无法区分"用户显式设的"和"defaults 填充的"；一旦 defaults 变化，所有未显式设置的会话 thinking 跟着变。修复：`SessionPrefs.thinking` 改为可选，`loadSession` 仅在用户显式设置过时才填 thinking（否则保持 undefined）；Composer/MessageList 读取时回退到 `defaults.thinking` 而非硬编码 "disabled"。
  - 影响范围：`packages/frontend/src/store/composer-prefs.ts`、`packages/frontend/src/components/Composer.tsx`、`packages/frontend/src/components/MessageList.tsx`、`packages/frontend/tests/composer-prefs.test.ts`

- **重启后会话标题丢失（变成角色名）**：根因是 `projectStore.createSession` 无去重，直接 `sessions.push`；`getCommands` 兜底分支用 `title: agentName` 创建已存在的 session 时，push 了重复记录覆盖了正常标题。修复：`createSession` 对同 id 幂等——已存在则返回已有记录，不新增不覆盖。
  - 影响范围：`packages/kernel/src/project-store.ts`、`packages/kernel/tests/project-store.test.ts`

## 2026-07-29

- **重启后思考强度被重置为 disabled（hydration 竞态根因，第三次修复）**：前两次修复（`setSessionPrefs` 增量同步、defaults 改用 localStorage）都没解决，因为真正根因是 **stale state 持久化竞态**——`useComposerPrefsStore` 初始内存态 `thinking: "disabled"`，而 `loadDefaults` 是异步的；若在其完成前触发 `setDefaults`/`setSessionPrefs`（用户改 model、附件 auto-select 等），两者内部 `{...s.defaults, ...prefs}` 会拿初始 `disabled` 当"当前 defaults"**无条件写回 localStorage**，覆盖用户上次存的 high/max。`loadDefaults` 姗姗来迟时读到的已是 `disabled`。用户用 F12 实测确认 localStorage 键存在、值确为 disabled，排除了"存不进去"和"读错"。修复：加 hydration guard——`loadDefaults`/`loadSession` 完成后才标记 `defaultsHydrated=true`，此前持久化函数只更新内存、不写回；hydrate 后恢复正常持久化。
  - 影响范围：`packages/frontend/src/store/composer-prefs.ts`、`packages/frontend/tests/composer-prefs.test.ts`（新增 hydration 竞态回归测试，并修正既有"重启往返"测试补上 hydrate 时序）

- **编辑供应商弹窗：选中快捷供应商后手动输入模型 id，快捷下拉卡住关不掉**：根因是 TagInput 回车/分隔符提交后会清空输入文本并回调 `onInputText("")`，而 ProviderFormModal 把"空搜索"解释为"显示全部预设模型"，导致下拉在添加模型后反而重新弹出全部候选项且无法关闭。修复：TagInput 新增 `onSubmit` 回调（回车/分隔符成功提交且非空白时触发，顺序置于 `onInputText` 之后），ProviderFormModal 在 `onSubmit` 时 `setDropPos(null)` 收起快捷下拉；并补 `onBlur` 延迟收起（点击外部关闭）。同时给 TagInput 的两条提交路径统一了 onInputText→onSubmit 的调用顺序，避免空串回调重新打开下拉。
  - 影响范围：`packages/frontend/src/components/ui/TagInput.tsx`、`packages/frontend/src/components/settings/ProviderFormModal.tsx`、`packages/frontend/tests/TagInput.test.tsx`、`packages/frontend/tests/ProviderFormModal.test.tsx`

- **provider 配置变更后，已运行的会话用旧 extension 导致新增模型 "Model not found"**：`provider:save` / `provider:delete` 会重写 `provider-extension.ts`，但运行中的 pi session 进程仍加载启动时的旧版本 extension，用户新增的模型（含斜杠 id 如 `deepseek-ai/deepseek-v4-pro`）在旧 session 里查无此模型，发消息时报 `Model not found`。修复：这两处在重写 extension 后调用 `agentManager.markAllDirty()`，与 `extension:toggle` 等 extension 变更保持一致——激活会话下次使用时（空闲）自动重建进程、重新加载最新 extension；会话历史不丢。
  - 影响范围：`packages/kernel/src/ws-server.ts`、`packages/kernel/tests/ws-provider-dirty.test.ts`

- **切换会话后思考强度丢失，重启后回到 off**：根因有二：① `setSessionPrefs`（Composer 改 model/thinking 时调用）会把整个 session prefs 覆盖到全局 defaults——切到老会话改 model 时，老会话的 thinking（off）被误写进 defaults，污染新会话默认值；② defaults 持久化用 IndexedDB，在 Electron 打包态下 openDB 可能失败，getDefaults 永远返回兜底的 disabled，导致"只要重启就 off"。修复：① `setSessionPrefs` 只把用户本次显式修改的字段增量同步到 defaults；② defaults/recording/newSessionIds 改用 localStorage 持久化（同步、不依赖 IndexedDB 初始化，Electron 下更可靠），session 级 prefs（含 attachments）仍走 IndexedDB。
  - 影响范围：`packages/frontend/src/store/composer-prefs.ts`、`packages/frontend/src/store/composer-db.ts`、`packages/frontend/tests/composer-prefs.test.ts`、`packages/frontend/tests/composer-db.test.ts`

- **打包后固定端口 9778，被占用时启动页提示并支持一键重启**：端口变化会导致前端 IndexedDB origin 改变（`http://127.0.0.1:不同端口`），跨 origin 数据不可见，是多个"打包后状态丢失"问题的隐患源头。改为固定端口：端口空闲直接用；被占用时启动页显示提示 +「重启应用」按钮，点击后自动杀掉占用进程（跨平台 lsof/netstat 查 PID + kill）并 relaunch。
  - 影响范围：`packages/desktop/src/main.cjs`、`packages/desktop/src/preload.cjs`、`packages/desktop/src/util/port.cjs`、`packages/desktop/tests/port.cjs.test.ts`

- **Mermaid 图表在流式生成过程中闪现"Mermaid 渲染失败"**：流式生成时代码块内容频繁变化且中途不完整，mermaid 解析必然失败并立即显示错误。修复：render 失败时对错误做 400ms debounce，期间 code 变化会取消错误并回到"图表渲染中…"占位态；仅当 code 稳定后仍失败才显示真正的错误提示。
  - 影响范围：`packages/frontend/src/components/blocks/MermaidBlock.tsx`、`packages/frontend/tests/blocks/MermaidBlock.test.tsx`

- **打包后新建会话会跳转到列表里的某个旧会话，而非新建**：根因是 `NewSessionPane` 的 `newSessionIds`（按项目持久化的"新建会话候选 id"）在会话发送后未及时清理（依赖 kernel `session:created` 事件触发 `clearNewSessionId`，打包态响应慢或 app 重启后从 IndexedDB 读出残留值），导致下次新建会话时 `sessionId` 复用一个已存在的旧会话 id；`addSession` 因此去重 no-op，`selectSession` 把 `currentSessionId` 设成那个旧 id，表现为"跳到上一个会话"。修复：`handleSend` 检测到当前 `sessionId` 已被占用时，生成全新 id 并回填 `newSessionIds`，确保每次发送都是新会话。
  - 影响范围：`packages/frontend/src/components/NewSessionPane.tsx`、`packages/frontend/tests/NewSessionPane.test.tsx`

- **打包（生产安装包）后复制功能失效，点击复制提示"复制失败"**：根因是 Electron 20+ 默认开启 sandbox，preload 脚本 `require("electron")` 解构出的 `clipboard` 不在 sandbox 白名单模块内，导致 preload 加载失败、`window.waPiClipboard` 未注入，前端回退 `navigator.clipboard` 在打包环境的 HTTP 内核页面下失败。修复：在 splashWindow 与 mainWindow 的 `webPreferences` 显式设置 `sandbox: false`，使 preload 的 `clipboard` 桥接恢复正常；`nodeIntegration` 仍为 `false`、`contextIsolation` 仍为 `true`，安全档位不降。
  - 影响范围：`packages/desktop/src/main.cjs`、新增 `packages/desktop/tests/web-preferences.test.ts`

## 2026-07-30

### 修复

- **委托子智能体报 "No API key found for the selected model"**：「跟随主模型」（override/agent 未单独配 model）实际只传了 `null`，子进程没有 `--model` 回退到 pi 默认模型且无 key；且 spawn 时未加载 provider-extension，自定义 provider 在子进程根本不存在。修复：① prompt 时把主会话当前模型记录到 `SessionHandle.currentModel`，`resolveSpawnConfig` 在 model 为空时自动跟随；② `makeSpawnFn` 新增 `extensionPaths` 透传，spawn 子进程时加载 `provider-extension.ts`（含自定义 provider + apiKey）。
- 影响范围：`packages/kernel/src/agent-manager.ts`、`packages/kernel/src/delegate-tool.ts`、`packages/kernel/tests/agent-manager-subagent-overrides.test.ts`

- **聊天界面未选模型时，默认自动选择第一个可用模型**：`ModelSelector` 组件在 `value` 为 null 且存在可用模型时，自动选中第一个模型，避免发送按钮因未选模型而被禁用（原先显示 disabled placeholder "选择模型"，用户必须手动选择才能发送消息）。该行为每个组件实例仅触发一次，后续可由用户手动切换。
  - 影响范围：`packages/frontend/src/components/ui/ModelSelector.tsx`

### 新增功能

- **新增 README.md**：面向第三方的项目介绍——产品定位、核心特性（多智能体/会话/MCP/模型/技能/插件/记忆/双端）、快速开始、mermaid 架构图、项目结构、开发指南、路线图；配图 3 张真实界面截图（`docs/assets/readme/`：会话界面、MCP 连接器、模型管理）。
- 影响范围：`README.md`（新增）、`docs/assets/readme/`（新增 3 张截图）

## 2026-07-30

### 修复

- **打包后 MCP 连接报 "Executable not found: npx" 和 "-32000 Connection closed"**：
  1. `main.cjs` 的 `ensureRuntimeBinLinks` 新增 npx/npm 包装脚本（透传 `bun x`/`bun`）
  2. 新增 `findSystemNode()` 搜索 Homebrew/nvm/fnm 下的真实 Node.js，优先使用而非 bun 替代（MCP 服务器多为 Node 包，bun 不完全兼容）
  3. Windows 对应 .cmd 包装脚本同步支持
  - 影响范围：`packages/desktop/src/main.cjs`

- **已完成 thinking 块因新 thinking 到达而误展开**：thinking 段不再合并（每段独立成卡）；合并行通过 `streamingStartIdx` 区分 finalized/streaming 内容
  - 影响范围：`packages/frontend/src/components/MessageList.tsx`

- **过程卡片展开/弱化逻辑统一**：`useAutoCollapse` 新增 `executingMode` 参数——该模式下 `autoOpen = !isDone`。所有工具/委托卡片统一规则：未完成→展开不透明；已完成→折叠半透明
  - 影响范围：`useAutoCollapse.ts`、`DelegateCard.tsx`、`FleetCard.tsx`、`ToolCallCard.tsx`

- **全项目重命名 HiAgent → WA PI Agent / wa-pi**：产品展示名改为「WA PI Agent」（窗口标题、侧边栏、托盘、productName）；标识符统一 `wa-pi`（npm 包名 `@hiagent/*` → `@wa-pi/*`、数据目录 `~/.hiagent` → `~/.wa-pi`、项目级 `.hiagent/` → `.wa-pi/`、环境变量 `HIAGENT_*` → `WA_PI_*`、二进制 `hiagent-kernel` → `wa-pi-kernel`、`hiagent-bridge.extension.ts` → `wa-pi-bridge.extension.ts`、代码标识符 HiAgent*→ WaPi*、settings 字段 hiagent_packages → waPiPackages 等）。约 290 个文件。不迁移旧数据：`~/.hiagent` 保留但不再读取，WA PI Agent 从全新数据目录启动。
- 未改：cocode-master（内嵌第三方仓库）、CHANGELOG 历史条目、gitee 远端仓库名（需平台侧另行改名）、`.workflow/release.yml` 的 OWNER/REPO（指向 gitee 仓库，待仓库改名后同步）。
- 影响范围：全仓库（详见 git diff）

## 2026-07-30

### 修复

- **已完成 thinking 块因新 thinking 到达而误展开**：多段 thinking 合并为一段 + 合并行内所有 segment 共享 `isStreaming`，导致新的 thinking 流式到达时已完成的 thinking 段也被标记为流式、重新展开。改为：1) thinking 段不再合并（每段独立成卡）；2) 合并行通过 `streamingStartIdx` 区分 finalized/streaming 内容，仅 streaming 段获得 `isStreaming=true`。
- 影响范围：`packages/frontend/src/components/MessageList.tsx`（segmentBlocks + 渲染 + RenderedRow 类型）

- **过程卡片（toolCall/delegate/fleet）展开/弱化逻辑统一**：原逻辑 `autoOpen = isStreaming && !isDone` 导致工具调用、委托在"执行中"阶段（block 已定稿但 result 未返回）自动折叠，用户看不到执行进度。改为 `useAutoCollapse` 支持 `executingMode` 参数——该模式下 `autoOpen = !isDone`，所有卡片统一规则：未完成（无 result 或流式中）→ 展开不透明；已完成（有 result）→ 折叠半透明；手动展开后完成 → 展开半透明。ThinkingCard 保持原逻辑不变（`executingMode=false`）。
- 影响范围：`packages/frontend/src/components/blocks/useAutoCollapse.ts`、`DelegateCard.tsx`、`FleetCard.tsx`、`ToolCallCard.tsx`

---

## 2026-07-29

### 配置变更

- **前后端依赖整体升级**：pi-coding-agent 0.80.10→0.82.1、pi-ai→0.82.1、pi-mcp-adapter 2.13.0→2.15.0、pi-web-access→0.15.0、pi-cache-optimizer→2.6.25、pi-memory→0.1.6、@modelcontextprotocol/sdk→1.30.0、vite 6→8、@vitejs/plugin-react 4→6、electron 33→43、electron-builder 25→26、@playwright/test→1.62 等；两个补丁按新版本重建（pi-coding-agent 0.82.1 的 PI_TUI_ONLY 两个 hunk、pi-mcp-adapter 2.15.0 的 mcp-auth.ts exports hunk——上游仍未原生导出）。typebox 因 pi 系包内嵌 1.1.38，保持 1.1.38 对齐（升 1.3.8 会导致泛型实例化过深 TS2589）。typescript 停留 5.x（TS7 为原生预览版暂不跟进）、tailwind 停留 3.x（v4 配置体系重写另行评估）。pi 0.82 契约变化适配：`AgentToolResult.details` 改必填（hiagent-bridge.extension.ts 类型对齐）。
- 影响范围：各 `package.json`、`bun.lock`、`patches/`、`packages/kernel/src/hiagent-bridge.extension.ts`

## 2026-07-29

### 配置变更

- **pi-coding-agent 补丁移除 bash 默认超时 hunk**：应要求恢复上游行为（bash 工具无默认 120s 超时，超时参数可缺省）。补丁现仅含 RPC `custom()` 抛错（PI_TUI_ONLY）与命令分发降级两个 hunk。注意：长耗时 bash 命令不再被 120s 默认超时打断，若出现挂起类问题需另行评估。
- 影响范围：`patches/@earendil-works%2Fpi-coding-agent@0.80.10.patch`

## 2026-07-29

### 修复

- **`/mcp-auth` 在 hiagent 卡死**：pi RPC 模式 `ctx.ui.custom()` 是静默 no-op（renderFn 永不调用），pi-mcp-adapter 的裸 `/mcp-auth` 面板命令 `await new Promise(...)` 永久挂起。根因修复改为两层通用方案（替代原 pi-mcp-adapter 定向补丁，该补丁的 commands.ts 守卫 hunk 已移除，仅保留 `mcp-auth.ts` exports hunk）：
  1. **pi 侧兜底**：`patches/@earendil-works%2Fpi-coding-agent@0.80.10.patch` 新增 hunk——RPC 模式 `custom()` 改为同步抛错，任何插件的 TUI 面板命令都快速失败（经 pi 命令分发 catch → emitError），永不挂死会话。
  2. **`/` 菜单静态预扫描屏蔽**：kernel 新增 `tui-command-filter.ts`，`AgentManager.getCommands` 对 pi 返回的 extension 命令按 `sourceInfo.path` 扫描扩展包源码，命中 `ui.custom(` 即判定 TUI-only 并从菜单过滤（按扩展粒度，同扩展非 TUI 命令会被一并隐藏，为已接受的取舍）。
- **手动发送扩展命令后前端永远"思考中"且无法停止**：扩展命令被 pi 拦截后不产生 agent_start/agent_end，前端 `optimisticSend` 的 thinking + loading 占位等不到终态。修复：kernel `_sendPromptNow` 的 50ms 无 agent_start 检查复位 busy 时，合成 `agent_end` 广播让前端退出思考态；前端 `agent_end` 处理同步清理 `stopReason==="pending"` 的乐观占位与回声标记（正常流程为 no-op）。
- **TUI-only 命令降级为大模型普通输入**（最终产品决策，替代中途的"报错横幅"方案——该方案已回退）：两层覆盖——① kernel `prompt()` 发送前检查命令名是否属于已识别的 TUI-only 集合（菜单过滤时记录），命中则加前导空格绕过 pi 的 `/` 命令分发（解决 handler"静默成功"不触发 custom() 时前端什么都看不到的问题）；② pi 补丁中 `_tryExecuteExtensionCommand` 捕获 `PI_TUI_ONLY` 错误时 `return false`（覆盖集合未建立或 handler 运行时才触及 custom() 的路径）。原始 `/xxx` 文本按未知命令的既有路径流入大模型，与"菜单屏蔽=命令不存在"的定位一致。`/mcp-auth <server>` 等不触发 `custom()` 的正常路径不受影响。
- 影响范围：`packages/kernel/src/tui-command-filter.ts`（新增）、`packages/kernel/src/agent-manager.ts`（getCommands 拉取点合并 + 合成 agent_end）、`packages/frontend/src/store/session.ts`（agent_end 清理 pending 占位）、`packages/kernel/tests/tui-command-filter.test.ts`（新增）、`packages/kernel/tests/agent-manager.test.ts`、`packages/kernel/tests/fixtures/fake-session-client.ts`、`packages/frontend/tests/store-session.test.ts`、`patches/pi-mcp-adapter@2.13.0.patch`、`patches/@earendil-works%2Fpi-coding-agent@0.80.10.patch`（原 `patches/@earendil-works/pi-coding-agent@0.80.10.patch` 由 bun 1.3 重生成并改名）

## 2025-08-02

### 修复

- **`/mcp-auth` 卡住**：`RpcClient.handleUiRequest` 中 `UI_DIALOG_METHODS` 缺少 `custom` 方法，导致 pi-mcp-adapter 的 `ctx.ui.custom()` 面板请求无回复，pi 进程永久挂起。将 `custom` 加入对话方法集合，无 handler 时自动回 `cancelled`。
- **数据清理**：`~/.hiagent/subagent-overrides.json` 中测试遗留的 `"test-model"` 无效模型已清除；引用不存在工作目录的过期会话文件 `s-518cb4ab-...jsonl` 已删除。
- 影响范围：`packages/kernel/src/rpc-client.ts`

## 2025-07-28

### 修复

- **思考文本不换行**：ThinkingCard/ThinkingPanel 加 `break-words`，ProcessCard 加 `min-w-0`
- **工具来源标签细化**：`listGlobalTools()` 来源从"扩展"细化为 `内置` / `MCP` / 插件包名
- **打包后启动白屏**：`runtime-deps.cjs` 的 `SEED_FILES` 补上 `tool-schemas.ts` 和 `hiagent-bridge.extension.ts`

## 2026-07-29

### 修复

- **文件预览 ENOENT 自动搜索回退**：文件不存在时从祖先目录递归搜索同名文件
- **文件预览胶囊仅对可解析路径显示**：`FilePill` 异步校验存在性，不存在回退为纯文本
- **切回会话时 ask_user_question 被错误取消**：`reconcileDanglingAsks` 新增 `isSessionActive` 参数，活跃会话跳过对账

### 配置变更

- **web_search 默认参数**：启动时写入配置 `workflow: "auto-summary"`，bridge 拦截器强制 `numResults=8`
- **web_search provider 修复**：provider 从硬编码 `exa` 改为 `auto`

---

## 2026-07-28（晚）

### 修复

- **委托提示词 v14 定稿**：deepseek-v4-flash 无思考模式 60/60 通过，提示词总量约 -60%
- **派发评测脚本加固**：每用例前重新生成扩展文件，启动即退出自动重试，评测改在隔离 worktree

---

## 2026-07-28

### 修复

- **新建会话 `/` 菜单不显示动态插件命令**：`getCommands` 支持新会话场景自动创建 session + 启动 pi 进程
- **`/goal` 等命令执行后界面永久显示"思考中"**：50ms 延迟检查自动复位 busy 状态
- **扩展安装/升级/卸载永久卡"安装中"**：终态事件改为 `broadcast` 而非 `reply`

### 新增功能

- **内联 `/` 命令菜单动态注册 pi 的 slash 命令**：新增 `get_commands` 全链路，支持插件贡献命令

### 修复

- **MCP 连接器永久卡"测试中"**：结果事件改为 `broadcast` 而非 `reply`
- **MCP 工具列表弹窗尺寸**：改为 60vw / 80vh

---

## 2025-01-22

### 新增功能

- **Token 消耗进度条**：百分比胶囊改为进度条，宽度 = 累计 token / 模型 contextWindow

---

## 2026-07-27

### 修复

- **委托提示词 v3 融合版定稿**：A/B 实测驱动，explore 88.9%、simple 0% 误派
- **派发评测脚本扩容**：用例 30→60 条，新增 `--repeat N` 多轮采样

### 新增

- **Mermaid 图表渲染**：mermaid 代码块渲染为可视化图表，支持缩放/拖拽/PNG 导出
- **刷新页面后会话未还原进行中状态**：`setMessages` 自动检测未完成的 assistant 消息
- **工具卡片展开/收起宽度跳变**：含过程卡片的列改为固定 `w-[78%]`
- **Token 显示 6 项缺陷修复**：大小写/箭头方向/缓存/子 agent usage/全 0 跳过/存量无胶囊
- **内置 pi-cache-optimizer**：Token/缓存显示，子 agent usage 累加
- **首次打开存量会话慢（5-10s → ~0.3s）**：`session:messages` 改为直接解析 JSONL 文件
- **高级项目经理 + 会议纪要专家角色**
- **角色设置工具 Tab 一直加载中**：改为读 HTTP 响应体
- **编辑角色时 SkillsTab 崩溃**：防御性 `skills ?? []`
- **`get is not defined` 记忆/指令/配置加载失败**：补 `get` 参数
- **归档记忆删除不掉**：entryId 做 `encodeURIComponent`
- **指令文件扫描对齐 pi 框架**：候选文件名/祖先目录遍历/去重
- **指令文件 Tab 无项目上下文时加载失败**：移除 `activeProjectId` 守卫

---

## 2026-07-26

### 设计

- **排队系统重构设计**：采用 pi 原生 `steer()` + HiAgent 本地列表管理

### 修复

- **流式输出 fallback**：`message_update` 缺失 partial 时用 `event.message` 兜底
- **SSE 事件帧修复**：帧格式从命名事件改为无名事件
- **REST 响应体丢失**：8 个 store 的 `load()` 补上 `.then(data => set(...))`
- **Composer 错误兜底**：失败时 `failTurn()` 复位 UI

### 重构

- **阶段一卡顿修复**：kernel 端 50ms 节流 + 前端 rAF 合帧
- **去 WS 化阶段二**：全量迁移到 HTTP REST + SSE
- **去 WS 化测试迁移**：所有测试适配 HTTP fetch + SSE

---

## 2026-07-25

### 新增

- **智能体编辑窗口放大**：80vw × 80vh，禁用遮罩关闭

### 修复

- **代码块内 markdown 表格逐格竖排**：CSS 作用域防护
- **AI 回复中表格/列表行间距异常**：lineHeight 从 3.1 改为 1.55

---

## 2026-07-25

### 修复

- **动态扩展与 agent 目录双重加载**：动态包优先 runtimeRequire
- **pi-mcp-adapter 升级 2.13.0**：bun patch 补 exports
- **发送按钮因过期模型 prefs 置灰**：自愈逻辑按 id 兜底匹配

---

## 2026-07-24

### 修复

- **角色提示词未注入系统提示词**：replace 模式正文替代默认 base
- **主智能体不主动派发子代理**：恢复 Proactive Delegation / Fleet 两节
- **FilePicker 搜索结果目录无法展开**：搜索态下 `listDir` 加载真实子目录
- **DirTreePicker 搜索切换隐藏目录不触发**：补齐 `showHidden` 依赖
- **工具调用卡弱化时机**：拿到 result 即弱化，不再区分成功/失败
- **阻止加载 Pi 默认 skill 目录**：传 `--no-skills` + 显式 `--skill`
- **聊天界面时间线渲染顺序**：按事件到达顺序交错渲染
- **子代理无效模型导致进程崩溃**：校验 override model 格式
- **pi-lens 双重加载 + 工具被过滤**：路径归属判定 + 白名单放行
- **关系网 tab 开关样式**：改为统一 Switch 组件

### 新增

- **首启预置 7 个专家角色**：前端/后端/PM/测试分析师/数据分析师/代码审查/UX 设计师
- **子代理派发遥测 + 评测脚本**：`subagent-telemetry.jsonl` + `eval-delegate-trigger.ts`
- **聊天界面 cocode 显示模式对齐**：ProcessCard 体系 + 折叠/语法高亮/FilePill
- **系统设置-技能页面优化**：搜索框 + 按钮 icon 化
- **CoCode vs HiAgent 差异对比文档**

### 变更

- **移除 4 个旧默认角色**

### 重构

- **bridge 扩展静态化**：`tool-schemas.ts` 作为唯一真源
- **delegate 工具描述移除硬编码内置类型名**

---

## 2026-07-23

### 修复

- **清理 kernel/tests 残留临时文件**
- **frontend 测试套件 11 个既有失败**：zustand store 污染修复
- **引导消息重复发送**：`_promptLocks` 只覆盖 `ensureStarted`

### 新增

- **RPC 迁移验收 E2E**
- **bridge 扩展层**：pi RPC 子进程架构的宿主工具桥
- **技能触发符支持 ¥**

### 重构

- **kernel 测试套件适配 pi RPC 子进程架构**：6 个测试文件重写
- **kernel 从 pi SDK 内嵌迁移到 pi RPC 子进程架构**：`rpc-client.ts` + `agent-manager.ts` 重写

---

## 2026-07-22

### 修复

- **主智能体不主动调用子智能体**：提示词引导重构（OpenCode 式强制策略）
- **按 R 重启端口冲突**：POSIX 递归杀整棵进程树
- **同一回合文本被拆成多个气泡**：重写 `segmentBlocks`

### 新增

- **内置智能体设置支持保存 model 和思考强度**
- **委派引导可配置化**：AgentConfig 新增 `delegationHints` 字段

### 修复（测试基础设施）

- **测试架构隔离**：kernel 不再被强加 happy-dom
- **store-subagents 测试跨文件 mock 泄漏**
- **SessionView 违反 React Hooks 规则**

### 移除

- **死字段 `partners.askFrom`**
- **死字段 `inheritProjectContext`**

---

## 2026-07-21

### 新增

- **默认工作区虚拟项目**：常驻"🏠 默认工作区"（`id="__system__"`）
- **系统提示词可配置化组装框架**：6 段拼装 + `prompts.json` 配置
- **内置 subagent 类型（general-purpose / Explore / Plan）全链路**
- **@ 智能体 chip 渲染 + 按钮选择器自适应**

### 修复

- **宫格弹窗左键内置 subagent 无效**：改为打开只读详情
- **多行发送换行丢失**：contenteditable 块级元素转 `\n`
- **内置 subagent 无 askTo 时无法调起**：始终注册 delegate/fleet 工具
- **@ 内置 subagent 中文 token 识别失败**：token 改用英文 name

### 设计

- **知识库检索技术方案调研**
- **@ 智能体语义改造 spec**

---

## 2026-07-20

### 新增

- **@ 候选菜单只显示 askTo 名单内**
- **系统提示词加 @[agentName] 委托规则**
- **askTo 非空时同时注册 fleet 工具**

### 重构

- **彻底移除 AgentConfig.name 字段**：displayName 成为唯一标识符
- **Composer 发送路径不剥离 @[xxx]**

### 修复

- **历史消息中 @[智能体] 渲染为 chip**
- **委托后刷新出现空气泡**：兼容 `role: "custom"` 判断

---

## 2026-07-19

### 新增

- **多智能体矩阵重写**：动态增删改查 + 关系网调起 + @/$/# 触发符 + DelegateCard
- **新建会话页智能体选择器**：搜索下拉 + 默认选中最近使用

---

## 2026-07-17

### 修复

- **动态插件升级无反馈**：新增 upgrading 状态 + 进度推送
- **未配置模型也能发送**：闸门改为验证模型真实存在
- **agent 启动失败后会话卡"思考中"**：`failTurn()` 复位状态
- **打包后 `modelRuntime.getModels` 报错**：改用包根动态 import
- **Quick Invoke 菜单过窄**：加宽至 560px + 自动滚入视野
- **quick-invoke E2E 全部不可用**：5 个既有缺陷修复

### 新增

- **@ 文件选择支持文件夹**：📁/📄 图标区分

### 修复

- **记忆页开关失效**：kernel 注入链路补消费点
- **Plugin 技能描述显示为 "|"**：支持 YAML 块标量解析
- **大文件上传超时**：`maxPayloadLength` 参数名修正 + WS 自动重连
- **会话状态点永远显示"空闲"**：改用活的会话级状态
- **业务校验错误崩掉 kernel 进程**：dispatch 边界加 try/catch

---

## 2026-07-16

### 新增

- **Quick Invoke 聊天栏快速调用**：@ 文件选择 + $ 技能选择 + contenteditable
- **模型供应商预设快捷选择**：10 条主流预设

### 修复

- **新会话发送后白屏**：kernel 创建 session 后立即回传用户消息
- **停止/队列按钮无响应**：session 注册时机提前
- **会话列表时间不更新**：`message_end` 也调 `touchSession`

### 变更

- **思考过程合并 + 工具调用分组折叠**：两层折叠面板

---

## 2026-07-15

### 重构

- **MCP 连接器改用直连 MCP SDK**：连接测试/工具列举不再经 Pi agent session

### 修复

- **HTTP MCP 鉴权失败**：url 分支透传 headers
- **已连接 MCP 仍保留连接测试按钮**

### 新增

- **切换 MCP 项目作用域后自动连接测试**
- **MCP 编辑改为模态弹窗**
- **MCP 查看工具加载过渡**

---

## 2026-07-14

### 修复

- **动态插件工具自动发现**：改为遍历扩展的 `.tools` Map
- **SDK 自动发现冲突**：改用自有字段 `hiagent_packages`
- **包管理器鲁棒性**：`process.execPath` 替代 `bun`、自动创建 package.json
- **Dev 模式运行时包解析**：新增 `runtimeRequire` 兜底

---

## 2026-07-13

### 新增

- **动态插件系统**：安装/卸载/升级/启用/禁用 npm 插件

### 重构

- **桌面 shell 从 tray-binary 迁到 Electron**：为录音系统声音铺基座

---

## 2026-07-12

### 重构

- **桌面分发定为文件夹模型**：bun build 打包 kernel.js + node_modules
- **前后端端口支持 `.env` 动态配置**

### 新增

- **ask_user_question 结构化澄清提问工具**
- **agent 系统提示词注入执行环境信息**
- **kernel 可导入 + 可选静态前端伺服**

### 修复

- **pi-lens 双重加载 + 工具白名单过滤**
- **记忆页作用域选择器状态丢失**

---

## 2026-07-11

### 重构

- **FilePicker 手风琴展开 + 限定范围搜索**

### 新增

- **记忆管理**：集成 pi-hermes-memory，增删改查 + 指令文件加载

---

## 2026-07-10

### 修复

- **dev 脚本按 R 重启端口漂移**：`strictPort: true` 固守 5180

### 新增

- **grep/find/ls 与 web_search/fetch_content 工具**

---

## 2026-07-09

### 新增

- **Composer 重构**：胶囊输入 + per-session 偏好持久化 + 模型切换/思考强度/附件
- **技能管理**：目录管理 + 启用/禁用 + 热生效
- **系统设置页 + 模型供应商管理**
- **DirTreePicker 搜索过滤**

---

## 2026-07-08

### 新增

- **Steer 消息队列控制**：followUp 排队 + 引导/立即/取消/清空
- **项目列表右键菜单**：查看文件夹 + 删除项目

### 重构

- **Pi SDK 模式重构**：从 spawn RPC 子进程改为同进程 SDK 直连

### 修复

- **pi-intercom 打包为项目依赖**、**Composer 发送防抖**、**会话列表重复**、**首条消息丢失**、**多 session 共享进程问题**、**dev 端口清理**等多项

---

## 2026-07-07

### 架构重构

- **移除 Rust 窗口层**：bun 一键启动前后端，全 bun:test
- **Pi 原生消息模型重构**：收敛到 Pi 富消息模型，删除 broker-proxy 旁路系统

### 新增

- **编排画布**：React Flow 4 agent 节点 + 连线
- **会话列表交互**：右键菜单 + 删除确认
- **多智能体委派**（后随消息模型重构废弃）

### 修复

- **消息流全链路打通**、**会话消息重复**、**E2E 白屏**等多项

### 测试

- **E2E 基础设施 + 7 spec**
- **MVP 四层测试全绿**：kernel 47 + frontend 42 + E2E 4

---

## 2026-07-06

### 新增

- **前端数据层**：WS 客户端 + 4 个 Zustand store
