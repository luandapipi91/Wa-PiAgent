# 会话回收站设计文档

**Status**: Approved  
**Author**: Alex (产品经理)  
**Date**: 2026-08-09  
**Version**: 1.0  

---

## 1. 问题陈述

当前会话删除是物理删除——一旦删除，会话元数据和关联的 jsonl 消息文件立即从系统中消失，用户无法找回误删的会话。

**具体痛点：**

- 误删会话无法恢复，用户需要重新开始对话
- 大量长期不活动的会话堆积在侧边栏列表中，干扰日常使用
- 没有自动归档机制，用户需要手动逐个清理

**证据：**

- 现有 `session:delete` 直接从 `projects.json` 数组中移除记录（`project-store.ts:140-144`）
- 无软删除、无回收站、无撤销机制
- 已有 workdir 定时清理机制（`index.ts:141-147`），但仅清理目录不清理会话记录

---

## 2. 目标与成功指标

| 目标 | 指标 | 当前基线 | 目标值 | 度量窗口 |
| ------ | ------ | --------- | -------- | --------- |
| 误删会话可恢复 | 删除后 7 天内恢复率 | 0%（不可恢复） | 提供 100% 恢复能力 | 上线后持续 |
| 减少侧边栏噪音 | 自动归档的会话数 | 0（无自动归档） | 7天未活动自动归档 | 上线后 30 天 |
| 回收站操作流畅 | 回收站弹窗打开到完成操作时间 | N/A | < 3 秒 | 上线后 30 天 |

---

## 3. Non-Goals

- 不做会话的自定义标签/分类系统（角色 tag 仅展示现有 `primaryAgent` 和 `projectId` 信息）
- 不做回收站内继续对话功能（只读查看，恢复后才能继续）
- 不做跨设备回收站同步（本地 JSON 文件，不涉及云端）
- 不做回收站容量限制（通过"彻底删除"和"清空回收站"由用户管理）

---

## 4. 数据模型

### 4.1 SessionEntity 变更

在 `shared/src/types.ts` 的 `SessionEntity` 接口新增 2 个可选字段：

```typescript
export interface SessionEntity {
    id: string;
    projectId: string;
    primaryAgent: AgentName;
    title: string;
    createdAt: number;
    lastActivity: number;
    piSessionFile: string;
    // —— 新增 ——
    deletedAt?: number;                    // 删除时间戳（毫秒），有值 = 在回收站
    deletedReason?: "manual" | "auto";     // "manual" = 用户手动删除, "auto" = 自动归档
}
```

两个字段都是可选的，旧数据（无这两个字段）自动视为活跃会话，无需数据迁移。

### 4.2 存储机制

不改变 `ProjectsFile` 结构（仍为 `{ projects, sessions }` 两个数组）。回收站会话与活跃会话共用 `sessions` 数组，通过 `deletedAt` 字段区分。

### 4.3 性能策略

- `projects.json` 只存元数据（每个会话约 200-300 字节），实际消息在独立 jsonl 文件中
- 10,000 个会话 ≈ 3MB，全量 load/save 约 30ms，无性能瓶颈
- WS 广播分离：`projects:list` 只发活跃会话，`trash:list` 按需分页拉取
- 可选的"自动清理回收站"设置（默认关闭），防止文件无限膨胀

---

## 5. 后端设计

### 5.1 ProjectStore 变更（`kernel/src/project-store.ts`）

#### 修改的方法

| 方法 | 变更 |
|------|------|
| `deleteSession(id)` | 改为软删除：设置 `deletedAt = Date.now()`, `deletedReason = "manual"`，不真正移除记录 |

#### 新增的方法

```typescript
// 恢复会话：清除 deletedAt 和 deletedReason
async restoreSession(id: string): Promise<void>

// 批量彻底删除：从数组中真正移除（不可恢复）
async permanentlyDeleteSessions(ids: string[]): Promise<void>

// 清空回收站：移除所有 deletedAt != null 的会话
async emptyTrash(): Promise<void>

// 自动归档：扫描 lastActivity < threshold 且未在回收站的会话，批量设为 auto 归档
// 返回被归档的会话列表
async archiveStaleSessions(thresholdMs: number): Promise<SessionEntity[]>

// 加载回收站会话（分页 + 项目过滤）
async loadTrash(opts?: {
    projectId?: string;
    offset?: number;
    limit?: number;
}): Promise<{ sessions: SessionEntity[]; total: number }>

// 自动清理回收站：永久删除 deletedAt < purgeBefore 的会话
// 返回被清理的数量
async purgeOldTrashSessions(purgeBefore: number): Promise<number>
```

### 5.2 WebSocket 事件（`kernel/src/ws-server.ts`）

#### 修改的事件

| 事件 | 变更 |
|------|------|
| `session:delete` | 底层调用改为软删除（`deleteSession` 内部已改），前端行为不变 |
| `projects:list` | 广播前过滤 `sessions.filter(s => !s.deletedAt)`，只发活跃会话 |

#### 新增的事件

| 事件 | 入参 | 返回 | 说明 |
| ------ | ------ | ------ | ------ |
| `trash:list` | `{ projectId?: string; offset?: number; limit?: number }` | `{ sessions: SessionEntity[]; projects: ProjectEntity[]; total: number }` | 分页拉取回收站会话 |
| `trash:restore` | `{ sessionIds: string[] }` | `{ success: boolean }` | 批量恢复会话 |
| `trash:delete` | `{ sessionIds: string[] }` | `{ success: boolean }` | 批量彻底删除 |
| `trash:empty` | `{}` | `{ success: boolean; deleted: number }` | 清空整个回收站 |
| `trash:messages` | `{ sessionId: string; offset?: number; limit?: number }` | `{ messages: SessionMessage[]; total: number }` | 只读加载会话消息 |

### 5.3 HTTP 路由（`kernel/src/routes/projects-sessions.ts`）

新增 REST 端点（与 WS 事件一一对应，供 API 调用）：

```
GET    /api/trash/sessions           → 列表（query: projectId, offset, limit）
POST   /api/trash/sessions/restore   → 批量恢复（body: { sessionIds }）
DELETE /api/trash/sessions           → 批量删除/清空（body: { sessionIds? } 空则清空全部）
GET    /api/trash/sessions/:id/messages → 只读消息（query: offset, limit）
```

### 5.4 自动归档调度器（`kernel/src/index.ts`）

新增 `setInterval`，复用已有的 workdir 清理调度模式：

```typescript
const ARCHIVE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 每 6 小时

// 启动时立即执行一次 + 定时执行
const runArchive = () => {
    const settings = loadAppSettings();
    if (!settings.autoArchiveEnabled) return;

    const thresholdMs = settings.autoArchiveDays * DAY_MS;
    projectStore.archiveStaleSessions(thresholdMs).then(archived => {
        if (archived.length > 0) {
            // 广播更新后的活跃会话列表（减少的）
            broadcastActiveSessions();
        }
    });
};

runArchive(); // 启动时立即检查
setInterval(runArchive, ARCHIVE_CHECK_INTERVAL_MS);
```

如果 `autoPurgeEnabled` 也开启，在同一次调度中先执行归档，再执行清理：

```typescript
if (settings.autoPurgeEnabled) {
    const purgeThresholdMs = settings.autoPurgeDays * DAY_MS;
    const purgeBefore = Date.now() - purgeThresholdMs;
    projectStore.purgeOldTrashSessions(purgeBefore).then(purged => {
        if (purged > 0) console.log(`[kernel] 自动清理了 ${purged} 个过期回收站会话`);
    });
}
```

### 5.5 边界处理

| 场景 | 处理 |
| ------ | ------ |
| 恢复会话时原项目已被删除 | 会话 `projectId` 改为 `SYSTEM_PROJECT_ID`（默认工作区） |
| 自动归档时用户正在使用某会话 | `touchSession` 已更新 `lastActivity`，不会误归档活跃会话 |
| IM 会话被恢复 | `restoreSession` 后通过 `projects:list` 广播自然回到活跃列表；IM 页签列表因重新包含该 `im-` 前缀会话而自动显示 |
| jsonl 消息文件已被手动删除 | 消息查看器显示"消息文件不存在"，元数据仍可见、可恢复 |
| `trash:restore` 中包含不存在/非回收站的 sessionId | 跳过无效 ID，不报错，返回 `success: true` |
| `trash:delete` 空数组 | 无操作，返回 `success: true` |

---

## 6. 前端设计

### 6.1 入口（`Sidebar.tsx`）

底部栏从单个 `SettingsButton` 改为两个并排按钮：

```
┌─────────────────────────────────┐
│  ...会话列表（滚动区域）...     │
├─────────────────────────────────┤
│  🗑️ 回收站 [12]    ⚙️ 设置     │
└─────────────────────────────────┘
```

- `RecycleBinButton`：与 `SettingsButton` 等宽并排
- 回收站有内容时显示红色数量徽标
- 点击打开 `RecycleBinModal`

### 6.2 回收站弹窗（`RecycleBinModal.tsx`）

**尺寸**：80% 视口宽高（`width: 80vw; height: 80vh;`）

**结构**（从上到下）：

1. **Header**：标题 "🗑️ 回收站" + 总数 + 关闭按钮
2. **Toolbar**：项目筛选 tabs（全部 + 各项目名）+ 搜索框
3. **列表区域**（flex: 1, 可滚动）：
   - 全选行（checkbox + "已选 N/M"）
   - 每行：checkbox + 智能体 emoji&名称 + 项目标签 + 删除来源&时间 + 查看按钮(👁)
4. **分页栏**：总数 + 当前页 + 每页 100 条 + 上一页/下一页
5. **Footer 操作栏**：恢复选中(N) · 彻底删除选中 · 清空回收站

**每行信息展示**：

- 智能体 emoji + 名称（`primaryAgent` → `AGENT_DEFS` 查找 emoji，无匹配显示 🤖）
- 项目名称标签（从 `projects` 数组查找 `projectId` → `project.name`）
- IM 会话（`id.startsWith("im-")`）额外显示 📱 + "IM会话" 标签
- 删除来源徽标：红色"手动删除" / 黄色"自动归档"
- 相对时间（"3天前"、"1周前"）

### 6.3 只读消息查看器（`TrashMessageViewer.tsx`）

点击会话行的 👁 按钮 → 弹窗内面板切换（不新开弹窗）：

- **顶部**：‹ 返回回收站 | 智能体 emoji + 会话标题 + 项目标签
- **警告条**（黄色）：⚠️ 此会话在回收站中，为只读模式。[恢复会话] 后可继续对话
- **消息列表**：复用现有 `ChatBlocks` 组件渲染消息，分页加载（通过 `trash:messages` 事件）
- **底部状态栏**：📖 只读模式 — 恢复会话后可继续对话（无输入框、无发送按钮）

### 6.4 回收站行组件（`TrashSessionRow.tsx`）

独立组件，接收 `session` + `project` + `selected` + `onToggleSelect` + `onView` props。

### 6.5 状态管理（`store/trash.ts`）

新建 Zustand store：

```typescript
interface TrashStore {
    sessions: SessionEntity[];
    projects: ProjectEntity[];
    total: number;
    currentPage: number;
    pageSize: number;          // 固定 100
    activeProjectId: string | null;  // null = 全部
    selectedIds: Set<string>;
    loading: boolean;
    viewerSessionId: string | null;  // 当前查看消息的会话

    // Actions
    loadTrash: (opts?) => Promise<void>;
    setPage: (page: number) => void;
    setProjectFilter: (projectId: string | null) => void;
    toggleSelect: (id: string) => void;
    selectAll: () => void;
    clearSelection: () => void;
    restore: (ids: string[]) => Promise<void>;
    permanentlyDelete: (ids: string[]) => Promise<void>;
    emptyTrash: () => Promise<void>;
    openViewer: (sessionId: string) => void;
    closeViewer: () => void;
}
```

### 6.6 store/projects.ts 变更

`useProjectsStore` 的 `setAll` 接收的 sessions 已经被后端过滤（不含 `deletedAt`），无需前端额外过滤。但为防御性编程，`sessions` 的 getter 可加 filter：

```typescript
sessions: (state) => state._allSessions.filter(s => !s.deletedAt)
```

### 6.7 新增前端文件清单

| 文件 | 职责 |
| ------ | ------ |
| `components/RecycleBinButton.tsx` | 侧边栏入口按钮（含数量徽标） |
| `components/RecycleBinModal.tsx` | 回收站弹窗主容器 |
| `components/TrashSessionRow.tsx` | 回收站会话行 |
| `components/TrashMessageViewer.tsx` | 只读消息查看面板 |
| `store/trash.ts` | 回收站 Zustand store |

### 6.8 修改的前端文件清单

| 文件 | 改动 |
| ------ | ------ |
| `components/Sidebar.tsx` | 底部栏加 `RecycleBinButton` |
| `store/projects.ts` | sessions 过滤防御性处理 |
| `i18n/locales/en.ts` | 英文文案 |
| `i18n/locales/zh.ts` | 中文文案 |

---

## 7. 设置项

在 General 设置面板新增"会话回收站"分区：

| 设置项 | 类型 | 默认值 | 说明 |
| -------- | ------ | -------- | ------ |
| 自动归档未活动的会话 | toggle | **true** | 超过阈值天未使用的会话自动移入回收站 |
| 归档阈值 | number | **7** | 未活动多少天后自动归档（天） |
| 自动清理回收站 | toggle | **false** | 回收站中超过阈值的会话自动永久删除 |
| 清理阈值 | number | **30** | 回收站中超过多少天后永久删除（天） |

开关关闭时，对应的阈值输入框置灰不可编辑。

设置变更实时保存到 app settings 持久化存储，下次定时任务（6 小时间隔）生效。

---

## 8. 国际化文案

| Key | 中文 | 英文 |
| ----- | ------ | ------ |
| `trash.title` | 回收站 | Recycle Bin |
| `trash.empty` | 回收站是空的 | Recycle bin is empty |
| `trash.total` | 共 {count} 个会话 | {count} sessions in total |
| `trash.filter.all` | 全部 | All |
| `trash.selectAll` | 全选 | Select All |
| `trash.selected` | 已选 {selected}/{total} | {selected}/{total} selected |
| `trash.restore` | 恢复选中 | Restore Selected |
| `trash.delete` | 彻底删除选中 | Delete Permanently |
| `trash.emptyAll` | 清空回收站 | Empty Recycle Bin |
| `trash.reason.manual` | 手动删除 | Manual |
| `trash.reason.auto` | 自动归档 | Auto-archived |
| `trash.viewer.notice` | 此会话在回收站中，为只读模式。恢复后可继续对话 | This session is in the recycle bin (read-only). Restore to continue chatting. |
| `trash.viewer.readonly` | 只读模式 — 恢复会话后可继续对话 | Read-only mode — restore the session to continue |
| `trash.confirm.empty` | 确定要永久删除回收站中的全部 {count} 个会话吗？此操作不可撤销。 | Permanently delete all {count} sessions? This cannot be undone. |
| `trash.confirm.delete` | 确定要永久删除选中的 {count} 个会话吗？删除后将无法恢复。 | Permanently delete {count} selected sessions? This cannot be undone. |
| `trash.messages.notFound` | 消息文件不存在 | Message file not found |
| `settings.trash.section` | 会话回收站 | Session Recycle Bin |
| `settings.trash.autoArchive` | 自动归档未活动的会话 | Auto-archive inactive sessions |
| `settings.trash.archiveDays` | 归档阈值 | Archive threshold |
| `settings.trash.autoPurge` | 自动清理回收站 | Auto-purge recycle bin |
| `settings.trash.purgeDays` | 清理阈值 | Purge threshold |

---

## 9. 测试策略

### 单元测试（bun:test）

- `ProjectStore` 新增方法：`restoreSession`, `permanentlyDeleteSessions`, `emptyTrash`, `archiveStaleSessions`, `loadTrash`
- 边界：恢复已删除/未删除的会话、彻底删除不存在的 ID、归档阈值边界、分页 offset/limit
- `deleteSession` 改为软删除后：验证记录仍在数组中但 `deletedAt` 有值

### 组件测试（Vitest + @testing-library/react）

- `RecycleBinModal`：渲染列表、筛选 tab 切换、多选交互、分页翻页、空状态
- `TrashSessionRow`：选中/取消、点击查看、信息展示正确性
- `TrashMessageViewer`：消息渲染、只读模式（无 composer）

### API 集成测试（curl）

- `trash:list` 分页 + 项目过滤
- `trash:restore` 恢复后出现在活跃列表
- `trash:delete` 彻底删除后不可恢复
- `trash:empty` 清空后回收站为空
- `trash:messages` 加载消息内容

### E2E 测试（Playwright）

- 删除会话 → 打开回收站 → 看到该会话 → 恢复 → 回到侧边栏列表
- 多选 → 批量彻底删除 → 二次确认 → 确认
- 清空回收站 → 二次确认 → 确认
- 点击查看 → 消息列表渲染 → 返回

---

## 10. 关键设计决策

| 决策 | 选择 | 理由 | 取舍 |
| ------ | ------ | ------ | ------ |
| 数据模型 | 软删除（deletedAt 字段） | 改动最小、恢复原子操作、兼容现有 load/save | projects.json 体积需用户管理 |
| 广播策略 | 分离广播（活跃/回收站） | 活跃列表不受回收站影响 | 新增 trash:list 事件 |
| 分页方式 | 后端分页（offset/limit） | 避免 WS 传输大量回收站数据 | 前端需管理分页状态 |
| 消息查看 | 面板内切换（非新弹窗） | 保持 80% 弹窗上下文 | 需管理面板切换状态 |
| 自动归档间隔 | 6 小时 | 平衡及时性与性能 | 最长延迟 6 小时归档 |
| 自动清理 | 默认关闭 | 用户控制数据生命周期 | 重度用户需手动开启 |
