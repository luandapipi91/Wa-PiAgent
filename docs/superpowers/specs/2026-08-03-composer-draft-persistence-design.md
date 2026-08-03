# 设计：输入框草稿按会话持久化

**日期**：2026-08-03
**状态**：Approved（设计已与用户确认）
**范围**：packages/frontend

---

## 1. 问题陈述

用户在输入框输入部分内容后，切换到其他会话窗口再切回来，输入内容丢失。具体现状：

- `Composer.tsx` 的文本用组件本地 `useState("")` 管理，未持久化。
- 由于 `App.tsx` / `SessionView` 渲染 `<Composer sessionId={...} />` 时不带 `key`，**切换会话时组件实例被复用**——文本意外地在内存中跨会话残留（切到 B 会话会看到 A 会话打了一半的内容）。
- 刷新 / 重启应用后，所有未发送文本全部丢失。
- `NewSessionPane.tsx` 的输入框同样用本地 `useState("")`，新建页切走后文本即丢。

**代价**：用户辛苦输入的长文本（代码、分析、提问草稿）在切换/刷新后丢失，需重新输入。这是高频操作路径上的信任破坏。

**已有基础**：项目已有成熟的"按 sessionId 持久化输入相关状态"机制：

- `store/composer-db.ts`：IndexedDB `wa-pi-composer` 的 `sessions` store，按 `sessionId` 存 `{model, thinking, attachments, updatedAt}`（附件等大数据走 IDB；全局小偏好如 defaults/recording/new-session-ids 走 localStorage——有意的可靠性权衡）。
- `store/composer-prefs.ts`：zustand store，含 `loadSession` / `setSessionPrefs` 与 **hydration 守卫**（`loadedSessions` + `gapWrites`），防止 load 前写入覆盖已存记录。
- `NewSessionPane` 已有"草稿会话"机制：`newSessionIds` 把每个 projectId 映射到一个持久草稿 `sessionId`，挂载时即 `loadSession(sessionId)` 恢复附件草稿。
- `deleteSessionPrefs` 已存在（删除会话清理挂点），当前无人调用。

## 2. 目标与成功标准

| 目标 | 成功标准 |
| --- | --- |
| 会话输入框草稿持久化 | 在会话 A 输入部分内容 → 切到 B → 切回 A，文本原样恢复；刷新/重启后仍恢复 |
| 新建页输入框草稿持久化 | 在新建页输入部分内容 → 切到其他会话 → 切回新建页，文本恢复；刷新后仍恢复 |
| 发送后清空 | 发送成功后切走再切回，输入框为空 |
| 手动清空 = 放弃草稿 | 用户主动清空输入框 → 切走再切回，输入框为空（不复活） |
| 附件切换还原 | 会话 A 挂附件草稿 → 切到 B → 切回 A，附件列表还原（含 reload 后） |
| 删除会话清理 | 删除会话时，其草稿一并删除 |
| 消除跨会话文本残留 | 切到 B 会话不再看到 A 会话打了一半的内容 |

**非目标（Non-Goals）**：

- 不做跨设备草稿同步。
- 不做草稿列表管理 UI（不展示"所有草稿"）。
- 不动 `composer-db.ts` 里 IndexedDB `defaults` 死 store（创建未用，属历史遗留，本次不清理）。
- 不做草稿撤销/历史。
- 不改 kernel 侧任何代码（无 API 变更）。
- 不动附件持久化逻辑：附件已由现有 composer-prefs 机制按会话持久化（添加/删除立即写回、发送后清空、reload 恢复、新建页草稿会话恢复），本次仅新增文本维度。

附件与文本草稿的行为差异仅为写回频率：附件操作低频、立即写回；文本输入高频、防抖写回。两者共用同一记录与同一清空/恢复语义。

## 3. 方案选型

**选定方案 A：扩展现有 composer 持久层**（用户已确认）。

对比过的备选：

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| A. 在 `ComposerSessionRecord` 增加 `text` 字段 | ✅ 选定 | 复用现有按 sessionId 索引 + hydration 守卫；草稿与 model/thinking/attachments 同一记录，生命周期天然一致（发送清空/删除清理同一处逻辑）；IndexedDB 容量足够长文本 |
| B. 独立 localStorage 草稿表 | ❌ | ~5MB 上限，粘贴大段代码/文档可能触顶；与现有 composer 持久层两套机制，删除会话/清空语义难保持一致 |
| C. kernel 侧文件持久化（~/.wa-pi/drafts.json） | ❌ | 为纯前端 UI 状态引入 kernel API 与跨进程通信，过度设计（YAGNI） |

**关键结论**：新建页文本草稿无需新存储路径——它已有持久草稿 `sessionId`（`newSessionIds` 映射），文本直接进同一个 `sessions` store 记录，与附件同级。

## 4. 数据模型

`packages/frontend/src/store/composer-db.ts`：

```ts
interface ComposerSessionRecord {
  sessionId: string;
  model: string | null;
  thinking: ThinkingLevel;
  attachments: AttachmentDraft[];
  text?: string;        // 新增：未发送的输入框草稿；缺省/空串 = 无草稿
  updatedAt: number;
}
```

`packages/frontend/src/store/composer-prefs.ts`：

```ts
export interface SessionPrefs {
  model: string | null;
  thinking?: ThinkingLevel;
  attachments: AttachmentDraft[];
  text?: string;        // 新增
}
```

`text` 用可选字段：老记录无该字段 = 无草稿，无需迁移。空串 `""` 语义等同无草稿（读取时 falsy 不恢复），用于表达"已发送 / 已手动清空"。

## 5. 行为时机

| 事件 | 行为 | 实现位置 |
| --- | --- | --- |
| 会话/新建页挂载 | 从 `bySession[sessionId]?.text` 恢复初始值 | Composer.tsx / NewSessionPane.tsx |
| 用户输入 | 防抖 ~300ms 写回 `text`（**含清空 → 写 `""`**） | 两处输入框组件 |
| 切走/卸载 | cleanup 时 flush 防抖中未写回的最后文本 | 两处组件 effect cleanup |
| 发送成功 | `setText("")` + `setSessionPrefs(sessionId, { text: "" })` | `doSend` / `handleSend` |
| 删除会话 | 调 `deleteSessionPrefs`（接上现有挂点） | 删除会话的调用点（如 ProjectItem） |
| 会话切换（组件复用） | sessionId 变化 → 立即 `setText("")` 清掉旧会话残留 → 草稿恢复 effect 填充新会话草稿 | Composer.tsx |

## 6. 组件改动

### 6.1 `Composer.tsx`（已有会话输入框）

- 新增 `draftRestoredRef`（按 sessionId 重置的恢复标记）与 `textRef`（始终同步最新 text，供 cleanup flush）。
- 新增防抖写回：`handleTextChange(next)` 中 `setText(next)` + 防抖调 `setSessionPrefs(sessionId, { text: next })`。
- 新增恢复 effect：`prefsLoaded && draftText` 时恢复一次；`sessionId` 变化时重置 `draftRestoredRef` 并 `setText("")`（消除跨会话残留闪烁）。
- 新增 cleanup：`clearTimeout` + 用 `textRef.current` flush 一次（若与已存不同）。
- `doSend` 成功后 `setSessionPrefs(sessionId, { text: "" })`。

### 6.2 `NewSessionPane.tsx`（新建会话页输入框）

- 同样增加恢复 effect + 防抖写回 + cleanup flush（挂在现有草稿 `sessionId` 上）。
- 需要读取 `loadedBySession[sessionId]` 作为恢复门控（当前组件未读，需补）。
- `handleSend` 成功后 `setSessionPrefs(sessionId, { text: "" })`。

### 6.3 `store/composer-prefs.ts`

- `loadSession` 合并逻辑增加 `text` 字段：`gap?.text ?? stored?.text ?? existing.text`（`??` 对 `""` 生效，手动清空的空串能正确胜出）；`dbSetSessionPrefs` 调用带上 `text: merged.text`。
- `setSessionPrefs` 的 gap 合并（`gapWrites.set(sessionId, { ...prev, ...prefs })`）无需改动，`{ text }` 自然进入。

### 6.4 删除会话清理

- 找到删除会话的调用点（侧栏删除菜单），补调 `useComposerPrefsStore.getState()` 侧清理或 `deleteSessionPrefs(sessionId)`（IndexedDB 删除整条记录，text 随之删除）。具体接线在实现计划中确认。

## 7. 测试策略

### 单元测试（`tests/composer-db.test.ts`、`tests/composer-prefs.test.ts`）

- `setSessionPrefs` / `getSessionPrefs` 读写 `text` 字段（含 `""`）。
- `loadSession` 恢复 `text`；gap 期间写入的 `text` 在合并中胜出。
- 发送清空（`{ text: "" }`）后 `loadSession` 不恢复文本。
- 老记录（无 `text` 字段）加载后 `text` 为 `undefined`。

### 组件测试（`tests/Composer.test.tsx`、`tests/NewSessionPane.test.tsx`）

- prefs 含 `text` 时挂载后恢复初始值。
- 输入触发防抖写回 `{ text }`；清空输入框写回 `{ text: "" }`。
- 发送成功后 store 中该 session 的 `text` 为 `""`。
- 切换 sessionId 后输入框清空并恢复新会话草稿（组件复用场景）。

### API 接口测试

不适用——纯前端功能，无 kernel API 变更。

### E2E（`e2e/composer.spec.ts` 新增用例，参照现有 IndexedDB 注入方式）

- 会话 A 输入草稿 → 切到 B → 切回 A → 草稿恢复。
- 发送后切走再切回 → 输入框为空。
- 手动清空输入框 → 切走切回 → 为空。
- 新建页输入 → 切走切回新建页 → 恢复。
- 会话 A 挂附件草稿 → 切走切回 → 附件列表还原；reload 后仍还原。
- reload 后草稿恢复。
- 删除会话后其草稿不再恢复。

## 8. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| `loadSession` 合并遗漏 `text` → 草稿被初始值覆盖 | 合并逻辑显式加 `text` 字段 + 单元测试覆盖 gap 场景 |
| 防抖定时器与卸载竞态 → 丢最后一段输入 | cleanup `clearTimeout` + `textRef` flush |
| 组件复用导致恢复瞬间旧文本闪烁 | sessionId 变化立即 `setText("")`，再恢复 |
| IndexedDB openDB 失败（打包态） | 现有 try/catch 兜底：草稿静默丢失，不影响主流程（可接受） |
| 打字过程中 loadSession 完成覆盖输入 | hydration 守卫已有 gap 合并；`draftRestoredRef` 保证恢复只执行一次 |
