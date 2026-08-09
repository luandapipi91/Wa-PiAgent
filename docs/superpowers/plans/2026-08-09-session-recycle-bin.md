# 会话回收站实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为会话增加回收站功能——删除的会话进入回收站而非永久消失，支持自动归档、批量恢复/彻底删除/清空，以及只读查看会话内容。

**架构：** 在 SessionEntity 上加 `deletedAt`/`deletedReason` 软删除字段。ProjectStore 新增 restore/permanentDelete/emptyTrash/loadTrash/archiveStale/purgeOld 方法。WS 层新增 trash:list/restore/delete/empty 事件 + projects:list 过滤已删除会话。前端新建 RecycleBinModal（80%宽高）+ TrashMessageViewer（只读）+ store/trash.ts。

**技术栈：** TypeScript, Bun (kernel), React + Zustand + Tailwind (frontend), i18next, Vitest + bun:test

**规格文档：** `docs/superpowers/specs/2026-08-09-session-recycle-bin-design.md`

---

## 文件结构

### 新建文件

| 文件 | 职责 |
| ------ | ------ |
| `packages/kernel/src/__tests__/project-store-trash.test.ts` | ProjectStore 回收站方法单元测试 |
| `packages/kernel/src/__tests__/settings-trash.test.ts` | 回收站设置存储单元测试 |
| `packages/frontend/src/store/trash.ts` | 回收站 Zustand store |
| `packages/frontend/src/components/RecycleBinButton.tsx` | 侧边栏入口按钮 |
| `packages/frontend/src/components/RecycleBinModal.tsx` | 回收站弹窗（80% 宽高） |
| `packages/frontend/src/components/TrashSessionRow.tsx` | 回收站会话行 |
| `packages/frontend/src/components/TrashMessageViewer.tsx` | 只读消息查看面板 |

### 修改文件

| 文件 | 改动 |
| ------ | ------ |
| `packages/shared/src/types.ts` | SessionEntity 加 deletedAt/deletedReason；新增 trash WS 事件类型；WSClientEvent/WSServerEvent 联合类型追加 |
| `packages/kernel/src/project-store.ts` | deleteSession 改软删除；新增 restoreSession/permanentlyDeleteSessions/emptyTrash/loadTrash/archiveStaleSessions/purgeOldTrashSessions/loadActive |
| `packages/kernel/src/settings-store.ts` | 新增 loadTrashSettings/saveTrashSettings + TRASH_DEFAULTS |
| `packages/kernel/src/ws-server.ts` | projects:list 过滤 deletedAt；session:delete 广播活跃列表；新增 trash:list/restore/delete/empty handlers |
| `packages/kernel/src/routes/projects-sessions.ts` | 新增 trash HTTP 路由 |
| `packages/kernel/src/routes/settings.ts` | 新增 trash 设置路由 |
| `packages/kernel/src/index.ts` | 新增自动归档调度器 |
| `packages/frontend/src/components/Sidebar.tsx` | 底部栏加 RecycleBinButton |
| `packages/frontend/src/store/projects.ts` | sessions 防御性过滤 deletedAt |
| `packages/frontend/src/components/settings/GeneralSection.tsx` | 新增回收站设置分区 |
| `packages/frontend/src/i18n/locales/zh.ts` | 回收站中文文案 |
| `packages/frontend/src/i18n/locales/en.ts` | 回收站英文文案 |

---

## 任务 1：Shared 类型定义

**文件：**

- 修改：`packages/shared/src/types.ts`

- [ ] **步骤 1：SessionEntity 新增软删除字段**

在 `SessionEntity` 接口（约第 146 行）末尾追加两个字段：

```typescript
export interface SessionEntity {
    id: string;
    projectId: string;
    primaryAgent: AgentName;
    title: string;
    createdAt: number;
    lastActivity: number;
    piSessionFile: string;
    deletedAt?: number;
    deletedReason?: "manual" | "auto";
}
```

- [ ] **步骤 2：新增 TrashSettings 类型**

在 `RetrySettings` 接口附近（约第 489 行）新增：

```typescript
export interface TrashSettings {
    autoArchiveEnabled: boolean;
    autoArchiveDays: number;
    autoPurgeEnabled: boolean;
    autoPurgeDays: number;
}
```

- [ ] **步骤 3：新增回收站 WS 事件请求类型**

在 `SessionDeleteEvent` 附近新增（约第 470 行之后）：

```typescript
export interface TrashListRequest {
    type: "trash:list";
    projectId?: string;
    offset?: number;
    limit?: number;
}

export interface TrashRestoreEvent {
    type: "trash:restore";
    sessionIds: string[];
}

export interface TrashDeleteEvent {
    type: "trash:delete";
    sessionIds: string[];
}

export interface TrashEmptyEvent {
    type: "trash:empty";
}
```

- [ ] **步骤 4：新增回收站 WS 事件响应类型**

在 `ProjectsListEvent` 附近新增：

```typescript
export interface TrashListResult {
    type: "trash:list";
    sessions: SessionEntity[];
    projects: ProjectEntity[];
    total: number;
}

export interface TrashOpResult {
    type: "trash:op";
    success: boolean;
    deleted?: number;
}
```

- [ ] **步骤 5：将新事件类型追加到联合类型**

在 `WSClientEvent` 联合类型（约第 627 行）追加：

```typescript
    | TrashListRequest
    | TrashRestoreEvent
    | TrashDeleteEvent
    | TrashEmptyEvent
```

在 `WSServerEvent` 联合类型（约第 1216 行）追加：

```typescript
    | TrashListResult
    | TrashOpResult
```

- [ ] **步骤 6：验证类型编译**

运行：`cd H:/workspace/hiagent && bun run --filter @wa-pi/shared build` 或 `bun build packages/shared/src/index.ts`
预期：无类型错误

- [ ] **步骤 7：Commit**

```bash
cd H:/workspace/hiagent
git add packages/shared/src/types.ts
git commit -m "feat(shared): 会话回收站类型定义 - SessionEntity 软删除字段 + WS 事件类型"
```

---

## 任务 2：ProjectStore 软删除 + 恢复 + 彻底删除 + 清空

**文件：**

- 修改：`packages/kernel/src/project-store.ts`
- 创建：`packages/kernel/src/__tests__/project-store-trash.test.ts`

- [ ] **步骤 1：编写失败的单元测试**

创建 `packages/kernel/src/__tests__/project-store-trash.test.ts`：

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ProjectStore } from "../project-store";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_FILE = join(tmpdir(), `test-trash-${Date.now()}.json`);

function makeStore() {
    return new ProjectStore(TEST_FILE);
}

async function seed(s: ProjectStore) {
    await s.createSystemProject({ id: "__system__", name: "默认工作区", cwd: "/tmp" });
    const p = await s.createProject({ name: "ProjA", cwd: "/tmp/a" });
    const s1 = await s.createSession({ projectId: "__system__", primaryAgent: "coder", title: "S1" });
    const s2 = await s.createSession({ projectId: p.id, primaryAgent: "coder", title: "S2" });
    return { p, s1, s2 };
}

describe("ProjectStore soft delete", () => {
    afterEach(async () => { await rm(TEST_FILE, { force: true }); });

    test("deleteSession sets deletedAt instead of removing", async () => {
        const s = makeStore();
        const { s1 } = await seed(s);
        await s.deleteSession(s1.id);
        const data = await s.load();
        const found = data.sessions.find(x => x.id === s1.id);
        expect(found).toBeDefined();
        expect(found!.deletedAt).toBeGreaterThan(0);
        expect(found!.deletedReason).toBe("manual");
    });

    test("restoreSession clears deletedAt", async () => {
        const s = makeStore();
        const { s1 } = await seed(s);
        await s.deleteSession(s1.id);
        await s.restoreSession(s1.id);
        const data = await s.load();
        const found = data.sessions.find(x => x.id === s1.id);
        expect(found!.deletedAt).toBeUndefined();
        expect(found!.deletedReason).toBeUndefined();
    });

    test("restoreSession on non-deleted session is no-op", async () => {
        const s = makeStore();
        const { s1 } = await seed(s);
        await s.restoreSession(s1.id);
        const data = await s.load();
        expect(data.sessions.find(x => x.id === s1.id)).toBeDefined();
    });

    test("permanentlyDeleteSessions removes records", async () => {
        const s = makeStore();
        const { s1, s2 } = await seed(s);
        await s.deleteSession(s1.id);
        await s.permanentlyDeleteSessions([s1.id, s2.id]);
        const data = await s.load();
        expect(data.sessions.find(x => x.id === s1.id)).toBeUndefined();
        expect(data.sessions.find(x => x.id === s2.id)).toBeUndefined();
    });

    test("permanentlyDeleteSessions with non-existent id is no-op", async () => {
        const s = makeStore();
        await seed(s);
        await s.permanentlyDeleteSessions(["nonexistent"]);
        const data = await s.load();
        expect(data.sessions.length).toBeGreaterThan(0);
    });

    test("emptyTrash removes all deleted sessions", async () => {
        const s = makeStore();
        const { s1, s2 } = await seed(s);
        await s.deleteSession(s1.id);
        await s.deleteSession(s2.id);
        const removed = await s.emptyTrash();
        expect(removed).toBe(2);
        const data = await s.load();
        expect(data.sessions.length).toBe(0);
    });

    test("emptyTrash with no deleted sessions returns 0", async () => {
        const s = makeStore();
        await seed(s);
        const removed = await s.emptyTrash();
        expect(removed).toBe(0);
    });

    test("loadActive returns only non-deleted sessions", async () => {
        const s = makeStore();
        const { s1, s2 } = await seed(s);
        await s.deleteSession(s1.id);
        const data = await s.loadActive();
        expect(data.sessions.length).toBe(1);
        expect(data.sessions[0].id).toBe(s2.id);
    });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd H:/workspace/hiagent/packages/kernel && bun test __tests__/project-store-trash.test.ts`
预期：FAIL — `restoreSession is not a function` / `permanentlyDeleteSessions is not a function` 等

- [ ] **步骤 3：修改 deleteSession 为软删除**

在 `project-store.ts` 中，将 `deleteSession` 方法（约第 140 行）替换为：

```typescript
async deleteSession(id: string): Promise<void> {
    const data = await this.load();
    const session = data.sessions.find(s => s.id === id);
    if (session) {
        session.deletedAt = Date.now();
        session.deletedReason = "manual";
    }
    await this.save(data);
}
```

- [ ] **步骤 4：新增 loadActive、restoreSession、permanentlyDeleteSessions、emptyTrash 方法**

在 `deleteSession` 方法之后添加：

```typescript
async loadActive(): Promise<ProjectsFile> {
    const data = await this.load();
    return {
        projects: data.projects,
        sessions: data.sessions.filter(s => !s.deletedAt),
    };
}

async restoreSession(id: string): Promise<void> {
    const data = await this.load();
    const session = data.sessions.find(s => s.id === id);
    if (session) {
        // 如果原项目已被删除，恢复到默认工作区
        if (!data.projects.find(p => p.id === session.projectId)) {
            session.projectId = SYSTEM_PROJECT_ID;
        }
        session.deletedAt = undefined;
        session.deletedReason = undefined;
    }
    await this.save(data);
}

async permanentlyDeleteSessions(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const data = await this.load();
    data.sessions = data.sessions.filter(s => !idSet.has(s.id));
    await this.save(data);
}

async emptyTrash(): Promise<number> {
    const data = await this.load();
    const before = data.sessions.length;
    data.sessions = data.sessions.filter(s => !s.deletedAt);
    const removed = before - data.sessions.length;
    await this.save(data);
    return removed;
}
```

注意：需要在文件顶部 import `SYSTEM_PROJECT_ID`：

```typescript
import { SYSTEM_PROJECT_ID } from "@wa-pi/shared";
```

- [ ] **步骤 5：运行测试验证通过**

运行：`cd H:/workspace/hiagent/packages/kernel && bun test __tests__/project-store-trash.test.ts`
预期：PASS（全部 8 个测试通过）

- [ ] **步骤 6：Commit**

```bash
cd H:/workspace/hiagent
git add packages/kernel/src/project-store.ts packages/kernel/src/__tests__/project-store-trash.test.ts
git commit -m "feat(kernel): ProjectStore 软删除/恢复/彻底删除/清空回收站 + loadActive"
```

---

## 任务 3：ProjectStore 查询与归档方法

**文件：**

- 修改：`packages/kernel/src/project-store.ts`
- 修改：`packages/kernel/src/__tests__/project-store-trash.test.ts`（追加测试）

- [ ] **步骤 1：追加失败的单元测试**

在 `project-store-trash.test.ts` 的 `describe` 块中追加：

```typescript
test("loadTrash returns only deleted sessions with total", async () => {
    const s = makeStore();
    const { s1, s2 } = await seed(s);
    await s.deleteSession(s1.id);
    await s.deleteSession(s2.id);
    const result = await s.loadTrash();
    expect(result.total).toBe(2);
    expect(result.sessions.length).toBe(2);
});

test("loadTrash filters by projectId", async () => {
    const s = makeStore();
    const { p, s1, s2 } = await seed(s);
    await s.deleteSession(s1.id);
    await s.deleteSession(s2.id);
    const result = await s.loadTrash({ projectId: p.id });
    expect(result.total).toBe(1);
    expect(result.sessions[0].id).toBe(s2.id);
});

test("loadTrash paginates with offset/limit", async () => {
    const s = makeStore();
    const { s1, s2 } = await seed(s);
    await s.deleteSession(s1.id);
    await s.deleteSession(s2.id);
    const page1 = await s.loadTrash({ offset: 0, limit: 1 });
    expect(page1.sessions.length).toBe(1);
    expect(page1.total).toBe(2);
    const page2 = await s.loadTrash({ offset: 1, limit: 1 });
    expect(page2.sessions.length).toBe(1);
    expect(page2.sessions[0].id).not.toBe(page1.sessions[0].id);
});

test("loadTrash returns empty when no deleted sessions", async () => {
    const s = makeStore();
    await seed(s);
    const result = await s.loadTrash();
    expect(result.total).toBe(0);
    expect(result.sessions.length).toBe(0);
});

test("archiveStaleSessions archives inactive sessions", async () => {
    const s = makeStore();
    const { s1 } = await seed(s);
    // 手动设置 lastActivity 为 10 天前
    const data = await s.load();
    const session = data.sessions.find(x => x.id === s1.id);
    session!.lastActivity = Date.now() - 10 * 24 * 60 * 60 * 1000;
    await s.save(data);
    // 7 天阈值
    const archived = await s.archiveStaleSessions(7 * 24 * 60 * 60 * 1000);
    expect(archived.length).toBe(1);
    expect(archived[0].id).toBe(s1.id);
    expect(archived[0].deletedReason).toBe("auto");
});

test("archiveStaleSessions does not archive already-deleted sessions", async () => {
    const s = makeStore();
    const { s1, s2 } = await seed(s);
    await s.deleteSession(s1.id);
    const data = await s.load();
    data.sessions.find(x => x.id === s2.id)!.lastActivity = Date.now() - 10 * 24 * 60 * 60 * 1000;
    await s.save(data);
    const archived = await s.archiveStaleSessions(7 * 24 * 60 * 60 * 1000);
    expect(archived.length).toBe(1);
    expect(archived[0].id).toBe(s2.id);
});

test("archiveStaleSessions respects threshold", async () => {
    const s = makeStore();
    const { s1 } = await seed(s);
    const data = await s.load();
    data.sessions.find(x => x.id === s1.id)!.lastActivity = Date.now() - 3 * 24 * 60 * 60 * 1000;
    await s.save(data);
    const archived = await s.archiveStaleSessions(7 * 24 * 60 * 60 * 1000);
    expect(archived.length).toBe(0);
});

test("purgeOldTrashSessions permanently deletes old trash", async () => {
    const s = makeStore();
    const { s1 } = await seed(s);
    await s.deleteSession(s1.id);
    // 手动设置 deletedAt 为 40 天前
    const data = await s.load();
    data.sessions.find(x => x.id === s1.id)!.deletedAt = Date.now() - 40 * 24 * 60 * 60 * 1000;
    await s.save(data);
    const purged = await s.purgeOldTrashSessions(Date.now() - 30 * 24 * 60 * 60 * 1000);
    expect(purged).toBe(1);
    const after = await s.load();
    expect(after.sessions.find(x => x.id === s1.id)).toBeUndefined();
});

test("purgeOldTrashSessions keeps recent trash", async () => {
    const s = makeStore();
    const { s1 } = await seed(s);
    await s.deleteSession(s1.id); // deletedAt = now
    const purged = await s.purgeOldTrashSessions(Date.now() - 30 * 24 * 60 * 60 * 1000);
    expect(purged).toBe(0);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd H:/workspace/hiagent/packages/kernel && bun test __tests__/project-store-trash.test.ts`
预期：FAIL — `loadTrash is not a function` 等

- [ ] **步骤 3：实现 loadTrash、archiveStaleSessions、purgeOldTrashSessions**

在 `emptyTrash` 方法之后添加：

```typescript
async loadTrash(opts?: {
    projectId?: string;
    offset?: number;
    limit?: number;
}): Promise<{ sessions: SessionEntity[]; total: number }> {
    const data = await this.load();
    let deleted = data.sessions.filter(s => s.deletedAt);
    if (opts?.projectId) {
        deleted = deleted.filter(s => s.projectId === opts.projectId);
    }
    // 按 deletedAt 倒序（最近删除的在前）
    deleted.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
    const total = deleted.length;
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 100;
    const sessions = deleted.slice(offset, offset + limit);
    return { sessions, total };
}

async archiveStaleSessions(thresholdMs: number): Promise<SessionEntity[]> {
    const data = await this.load();
    const cutoff = Date.now() - thresholdMs;
    const archived: SessionEntity[] = [];
    for (const session of data.sessions) {
        if (!session.deletedAt && session.lastActivity < cutoff) {
            session.deletedAt = Date.now();
            session.deletedReason = "auto";
            archived.push(session);
        }
    }
    if (archived.length > 0) await this.save(data);
    return archived;
}

async purgeOldTrashSessions(purgeBefore: number): Promise<number> {
    const data = await this.load();
    const before = data.sessions.length;
    data.sessions = data.sessions.filter(
        s => !s.deletedAt || s.deletedAt >= purgeBefore
    );
    const removed = before - data.sessions.length;
    if (removed > 0) await this.save(data);
    return removed;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd H:/workspace/hiagent/packages/kernel && bun test __tests__/project-store-trash.test.ts`
预期：PASS（全部测试通过）

- [ ] **步骤 5：Commit**

```bash
cd H:/workspace/hiagent
git add packages/kernel/src/project-store.ts packages/kernel/src/__tests__/project-store-trash.test.ts
git commit -m "feat(kernel): ProjectStore loadTrash 分页查询 + archiveStaleSessions + purgeOldTrashSessions"
```

---

## 任务 4：后端回收站设置存储

**文件：**

- 修改：`packages/kernel/src/settings-store.ts`
- 创建：`packages/kernel/src/__tests__/settings-trash.test.ts`

- [ ] **步骤 1：编写失败的单元测试**

创建 `packages/kernel/src/__tests__/settings-trash.test.ts`：

```typescript
import { describe, test, expect, afterEach } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTrashSettings, saveTrashSettings, TRASH_DEFAULTS } from "../settings-store";

const TEST_DIR = join(tmpdir(), `test-settings-trash-${Date.now()}`);
const TEST_FILE = join(TEST_DIR, "settings.json");

// settings-store.ts 内部路径写死了 WA_PI_DIR/settings.json，
// 测试通过设 WA_PI_DIR 环境变量来隔离
const ORIG_DIR = process.env.WA_PI_DIR;

describe("Trash settings", () => {
    afterEach(async () => {
        process.env.WA_PI_DIR = ORIG_DIR;
        await rm(TEST_DIR, { force: true, recursive: true });
    });

    test("loadTrashSettings returns defaults when no file", async () => {
        process.env.WA_PI_DIR = TEST_DIR;
        const settings = await loadTrashSettings();
        expect(settings).toEqual(TRASH_DEFAULTS);
    });

    test("saveTrashSettings persists and loadTrashSettings reads back", async () => {
        process.env.WA_PI_DIR = TEST_DIR;
        const custom = {
            autoArchiveEnabled: false,
            autoArchiveDays: 14,
            autoPurgeEnabled: true,
            autoPurgeDays: 60,
        };
        await saveTrashSettings(custom);
        const loaded = await loadTrashSettings();
        expect(loaded).toEqual(custom);
    });

    test("saveTrashSettings preserves other settings.json fields", async () => {
        process.env.WA_PI_DIR = TEST_DIR;
        // 先写入一个 retry 字段
        const { writeFile, mkdir } = await import("node:fs/promises");
        await mkdir(TEST_DIR, { recursive: true });
        await writeFile(TEST_FILE, JSON.stringify({ retry: { maxRetries: 5 } }), "utf8");
        // 保存 trash 设置
        await saveTrashSettings(TRASH_DEFAULTS);
        // 验证 retry 字段仍然存在
        const raw = JSON.parse(await (await import("node:fs/promises")).readFile(TEST_FILE, "utf8"));
        expect(raw.retry).toEqual({ maxRetries: 5 });
        expect(raw.trash).toBeDefined();
    });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd H:/workspace/hiagent/packages/kernel && bun test __tests__/settings-trash.test.ts`
预期：FAIL — `loadTrashSettings is not a function`

- [ ] **步骤 3：实现 loadTrashSettings / saveTrashSettings / TRASH_DEFAULTS**

在 `settings-store.ts` 末尾添加。需要 import `SessionEntity` 不必要，但需要 import `readFile`, `writeFile`, `mkdir`（如果文件顶部还没 import 完整）。

```typescript
import type { TrashSettings } from "@wa-pi/shared";

export const TRASH_DEFAULTS: TrashSettings = {
    autoArchiveEnabled: true,
    autoArchiveDays: 7,
    autoPurgeEnabled: false,
    autoPurgeDays: 30,
};

export async function loadTrashSettings(): Promise<TrashSettings> {
    const settings = await readSettingsJson(SETTINGS_FILE);
    const trash = settings.trash;
    if (!trash || typeof trash !== "object") return { ...TRASH_DEFAULTS };
    return {
        autoArchiveEnabled: typeof trash.autoArchiveEnabled === "boolean" ? trash.autoArchiveEnabled : TRASH_DEFAULTS.autoArchiveEnabled,
        autoArchiveDays: typeof trash.autoArchiveDays === "number" ? trash.autoArchiveDays : TRASH_DEFAULTS.autoArchiveDays,
        autoPurgeEnabled: typeof trash.autoPurgeEnabled === "boolean" ? trash.autoPurgeEnabled : TRASH_DEFAULTS.autoPurgeEnabled,
        autoPurgeDays: typeof trash.autoPurgeDays === "number" ? trash.autoPurgeDays : TRASH_DEFAULTS.autoPurgeDays,
    };
}

export async function saveTrashSettings(trash: TrashSettings): Promise<void> {
    const settings = await readSettingsJson(SETTINGS_FILE);
    settings.trash = trash;
    await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8");
}
```

注意：`SETTINGS_FILE` 和 `readSettingsJson` 已在文件中定义。如果 `writeFile` 未 import 则补充。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd H:/workspace/hiagent/packages/kernel && bun test __tests__/settings-trash.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
cd H:/workspace/hiagent
git add packages/kernel/src/settings-store.ts packages/kernel/src/__tests__/settings-trash.test.ts
git commit -m "feat(kernel): 回收站设置存储 loadTrashSettings/saveTrashSettings"
```

---

## 任务 5：WS 事件处理 + HTTP 路由

**文件：**

- 修改：`packages/kernel/src/ws-server.ts`
- 修改：`packages/kernel/src/routes/projects-sessions.ts`
- 修改：`packages/kernel/src/routes/settings.ts`

- [ ] **步骤 1：添加 broadcastProjectsList 辅助方法**

在 `ws-server.ts` 中，找到现有的 `broadcast` 方法附近，新增一个私有辅助方法：

```typescript
private async broadcastProjectsList(): Promise<void> {
    const data = await this.opts.projectStore.loadActive();
    this.broadcast({
        type: "projects:list",
        projects: data.projects,
        sessions: data.sessions,
    });
}
```

- [ ] **步骤 2：修改 projects:list handler 过滤已删除会话**

找到 `case "projects:list"` 处理器（约第 568 行），将 `this.opts.projectStore.load()` 改为 `this.opts.projectStore.loadActive()`：

```typescript
case "projects:list": {
    const { projects, sessions } = await this.opts.projectStore.loadActive();
    reply({ type: "projects:list", projects, sessions });
    break;
}
```

- [ ] **步骤 3：修改 session:delete handler 使用软删除广播**

找到 `case "session:delete"` 处理器（约第 740 行），将手动 load + broadcast 替换为 `broadcastProjectsList()`：

```typescript
case "session:delete": {
    await this.opts.agentManager.disposeSession(event.sessionId);
    await this.opts.projectStore.deleteSession(event.sessionId);
    await this.broadcastProjectsList();
    if (this.opts.channelManager) {
        await this.opts.channelManager.onSessionDeleted(event.sessionId);
    }
    break;
}
```

- [ ] **步骤 4：全局替换其他 broadcastProjectsList 调用点**

搜索 `ws-server.ts` 中所有 `this.opts.projectStore.load()` 后跟 `this.broadcast({ type: "projects:list"` 的模式，替换为 `await this.broadcastProjectsList()`。这些出现在 `project:create`、`project:delete`、`session:rename` 等处理器中。逐个替换。

- [ ] **步骤 5：新增 trash:list handler**

在 `handle()` 方法的 switch 中添加（放在 `case "session:delete"` 之后）：

```typescript
case "trash:list": {
    const result = await this.opts.projectStore.loadTrash({
        projectId: event.projectId,
        offset: event.offset,
        limit: event.limit ?? 100,
    });
    const { projects } = await this.opts.projectStore.load();
    reply({
        type: "trash:list",
        sessions: result.sessions,
        projects,
        total: result.total,
    });
    break;
}
```

- [ ] **步骤 6：新增 trash:restore handler**

```typescript
case "trash:restore": {
    for (const id of event.sessionIds) {
        await this.opts.projectStore.restoreSession(id);
    }
    await this.broadcastProjectsList();
    reply({ type: "trash:op", success: true });
    break;
}
```

- [ ] **步骤 7：新增 trash:delete handler**

```typescript
case "trash:delete": {
    await this.opts.projectStore.permanentlyDeleteSessions(event.sessionIds);
    reply({ type: "trash:op", success: true });
    break;
}
```

- [ ] **步骤 8：新增 trash:empty handler**

```typescript
case "trash:empty": {
    const deleted = await this.opts.projectStore.emptyTrash();
    reply({ type: "trash:op", success: true, deleted });
    break;
}
```

- [ ] **步骤 9：新增 trash HTTP 路由**

在 `routes/projects-sessions.ts` 的 `registerProjectSessionRoutes` 函数中，在现有路由之后添加：

```typescript
r.add("GET", "/api/trash/sessions", async (req) => {
    const url = new URL(req.url, "http://localhost");
    const projectId = url.searchParams.get("projectId") ?? undefined;
    const offset = url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : undefined;
    const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined;
    return callApi({ type: "trash:list", projectId, offset, limit });
});
r.add("POST", "/api/trash/sessions/restore", async (req) => {
    const b = await readJsonBody(req);
    return callApi({ type: "trash:restore", sessionIds: b.sessionIds ?? [] });
});
r.add("DELETE", "/api/trash/sessions", async (req) => {
    const b = await readJsonBody(req);
    if (b.sessionIds && Array.isArray(b.sessionIds)) {
        return callApi({ type: "trash:delete", sessionIds: b.sessionIds });
    }
    return callApi({ type: "trash:empty" });
});
```

- [ ] **步骤 10：新增 trash 设置 HTTP 路由**

在 `routes/settings.ts` 中添加：

```typescript
r.add("GET", "/api/settings/trash", async () => {
    const trash = await loadTrashSettings();
    return Response.json({ trash });
});
r.add("PUT", "/api/settings/trash", async (req) => {
    const b = await readJsonBody(req);
    await saveTrashSettings(b.trash);
    return Response.json({ trash: b.trash });
});
```

需要在 `settings.ts` 顶部 import `loadTrashSettings`, `saveTrashSettings`。

- [ ] **步骤 11：验证编译**

运行：`cd H:/workspace/hiagent && bun run --filter @wa-pi/kernel build` 或 `tsc --noEmit`
预期：无类型错误

- [ ] **步骤 12：Commit**

```bash
cd H:/workspace/hiagent
git add packages/kernel/src/ws-server.ts packages/kernel/src/routes/projects-sessions.ts packages/kernel/src/routes/settings.ts
git commit -m "feat(kernel): 回收站 WS 事件处理器 + HTTP 路由 + projects:list 过滤已删除会话"
```

---

## 任务 6：自动归档调度器

**文件：**

- 修改：`packages/kernel/src/index.ts`

- [ ] **步骤 1：添加自动归档调度器**

在 `index.ts` 中，找到现有的 workdir 清理 `setInterval`（约第 141 行）附近，添加回收站自动归档调度器：

```typescript
import { loadTrashSettings } from "./settings-store";

// —— 会话自动归档调度器 ——
const ARCHIVE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 小时

async function runAutoArchive() {
    try {
        const settings = await loadTrashSettings();
        if (!settings.autoArchiveEnabled) return;

        const DAY_MS = 24 * 60 * 60 * 1000;
        const thresholdMs = settings.autoArchiveDays * DAY_MS;
        const archived = await projectStore.archiveStaleSessions(thresholdMs);

        if (archived.length > 0) {
            console.log(`[kernel] 自动归档了 ${archived.length} 个未活动会话到回收站`);
            await server.broadcastProjectsList();
        }

        // 如果启用了自动清理回收站
        if (settings.autoPurgeEnabled) {
            const purgeBefore = Date.now() - settings.autoPurgeDays * DAY_MS;
            const purged = await projectStore.purgeOldTrashSessions(purgeBefore);
            if (purged > 0) {
                console.log(`[kernel] 自动清理了 ${purged} 个过期回收站会话`);
            }
        }
    } catch (e) {
        console.warn("[kernel] 回收站自动归档失败:", e);
    }
}

// 启动时立即检查一次 + 定时执行
void runAutoArchive();
const archiveTimer = setInterval(() => void runAutoArchive(), ARCHIVE_CHECK_INTERVAL_MS);
```

- [ ] **步骤 2：在 shutdown 函数中清理 timer**

找到 `shutdown()` 函数（约第 323 行），添加 `clearInterval(archiveTimer)`：

```typescript
clearInterval(archiveTimer);  // 回收站自动归档
```

注意：`broadcastProjectsList` 是 WSServer 的私有方法。需要将其改为公开方法，或在 index.ts 中调用 `server.broadcast()` + 手动加载。最简方案：在 WSServer 上新增公开方法 `broadcastProjectsList()`（去掉 private 修饰符）。

- [ ] **步骤 3：验证编译**

运行：`cd H:/workspace/hiagent && bun run --filter @wa-pi/kernel build`
预期：无类型错误

- [ ] **步骤 4：Commit**

```bash
cd H:/workspace/hiagent
git add packages/kernel/src/index.ts packages/kernel/src/ws-server.ts
git commit -m "feat(kernel): 自动归档调度器 - 6小时检查未活动会话 + 可选自动清理回收站"
```

---

## 任务 7：前端 i18n + Store + 侧边栏按钮

**文件：**

- 修改：`packages/frontend/src/i18n/locales/zh.ts`
- 修改：`packages/frontend/src/i18n/locales/en.ts`
- 创建：`packages/frontend/src/store/trash.ts`
- 修改：`packages/frontend/src/store/projects.ts`
- 创建：`packages/frontend/src/components/RecycleBinButton.tsx`
- 修改：`packages/frontend/src/components/Sidebar.tsx`

- [ ] **步骤 1：添加中文 i18n 文案**

在 `zh.ts` 的对象中（`sidebar` 分组附近）添加：

```typescript
trash: {
    title: "回收站",
    empty: "回收站是空的",
    total: "共 {{count}} 个会话",
    filterAll: "全部",
    selectAll: "全选",
    selected: "已选 {{selected}}/{{total}}",
    restore: "恢复选中",
    restoreCount: "恢复选中 ({{count}})",
    delete: "彻底删除选中",
    emptyAll: "清空回收站",
    reasonManual: "手动删除",
    reasonAuto: "自动归档",
    viewerNotice: "此会话在回收站中，为只读模式。",
    viewerRestoreLink: "恢复会话",
    viewerRestoreHint: "恢复后可继续对话",
    viewerReadonly: "只读模式 — 恢复会话后可继续对话",
    viewerBack: "返回回收站",
    confirmEmptyTitle: "清空回收站",
    confirmEmptyMsg: "确定要永久删除回收站中的全部 {{count}} 个会话吗？此操作不可撤销。",
    confirmDeleteTitle: "彻底删除选中会话",
    confirmDeleteMsg: "确定要永久删除选中的 {{count}} 个会话吗？删除后将无法恢复。",
    messagesNotFound: "消息文件不存在",
    imTag: "IM会话",
},
```

在 `settings` 分组中添加：

```typescript
trashSection: "会话回收站",
trashAutoArchive: "自动归档未活动的会话",
trashArchiveDays: "超过 {{days}} 天未活动",
trashAutoPurge: "自动清理回收站",
trashPurgeDays: "超过 {{days}} 天自动删除",
```

- [ ] **步骤 2：添加英文 i18n 文案**

在 `en.ts` 中添加对应英文（结构完全一致）：

```typescript
trash: {
    title: "Recycle Bin",
    empty: "Recycle bin is empty",
    total: "{{count}} sessions",
    filterAll: "All",
    selectAll: "Select All",
    selected: "{{selected}}/{{total}} selected",
    restore: "Restore Selected",
    restoreCount: "Restore ({{count}})",
    delete: "Delete Permanently",
    emptyAll: "Empty Recycle Bin",
    reasonManual: "Manual",
    reasonAuto: "Auto-archived",
    viewerNotice: "This session is in the recycle bin (read-only).",
    viewerRestoreLink: "Restore session",
    viewerRestoreHint: "to continue chatting",
    viewerReadonly: "Read-only mode — restore to continue",
    viewerBack: "Back to Recycle Bin",
    confirmEmptyTitle: "Empty Recycle Bin",
    confirmEmptyMsg: "Permanently delete all {{count}} sessions? This cannot be undone.",
    confirmDeleteTitle: "Delete Selected Sessions",
    confirmDeleteMsg: "Permanently delete {{count}} selected sessions? This cannot be undone.",
    messagesNotFound: "Message file not found",
    imTag: "IM",
},
```

settings 分组：

```typescript
trashSection: "Session Recycle Bin",
trashAutoArchive: "Auto-archive inactive sessions",
trashArchiveDays: "After {{days}} days inactive",
trashAutoPurge: "Auto-purge recycle bin",
trashPurgeDays: "After {{days}} days in trash",
```

- [ ] **步骤 3：创建 store/trash.ts**

创建 `packages/frontend/src/store/trash.ts`：

```typescript
import { create } from "zustand";
import type { SessionEntity, ProjectEntity } from "@wa-pi/shared";
import { api } from "../api-client";

interface TrashState {
    sessions: SessionEntity[];
    projects: ProjectEntity[];
    total: number;
    currentPage: number;
    pageSize: number;
    activeProjectId: string | null;
    selectedIds: Set<string>;
    loading: boolean;
    viewerSessionId: string | null;

    loadTrash: () => Promise<void>;
    setPage: (page: number) => void;
    setProjectFilter: (projectId: string | null) => void;
    toggleSelect: (id: string) => void;
    selectAllOnPage: () => void;
    clearSelection: () => void;
    restore: (ids: string[]) => Promise<void>;
    permanentlyDelete: (ids: string[]) => Promise<void>;
    emptyTrash: () => Promise<number>;
    openViewer: (sessionId: string) => void;
    closeViewer: () => void;
}

export const useTrashStore = create<TrashState>((set, get) => ({
    sessions: [],
    projects: [],
    total: 0,
    currentPage: 0,
    pageSize: 100,
    activeProjectId: null,
    selectedIds: new Set(),
    loading: false,
    viewerSessionId: null,

    loadTrash: async () => {
        const { currentPage, pageSize, activeProjectId } = get();
        set({ loading: true });
        try {
            const params = new URLSearchParams();
            if (activeProjectId) params.set("projectId", activeProjectId);
            params.set("offset", String(currentPage * pageSize));
            params.set("limit", String(pageSize));
            const res = await api.get(`/api/trash/sessions?${params}`) as {
                sessions: SessionEntity[];
                projects: ProjectEntity[];
                total: number;
            };
            set({
                sessions: res.sessions ?? [],
                projects: res.projects ?? [],
                total: res.total ?? 0,
                loading: false,
            });
        } catch {
            set({ loading: false });
        }
    },

    setPage: (page) => { set({ currentPage: page }); void get().loadTrash(); },
    setProjectFilter: (projectId) => { set({ activeProjectId: projectId, currentPage: 0 }); void get().loadTrash(); },

    toggleSelect: (id) => set((s) => {
        const next = new Set(s.selectedIds);
        if (next.has(id)) next.delete(id); else next.add(id);
        return { selectedIds: next };
    }),

    selectAllOnPage: () => set((s) => {
        const allSelected = s.sessions.every(x => s.selectedIds.has(x.id));
        const next = new Set(s.selectedIds);
        if (allSelected) {
            s.sessions.forEach(x => next.delete(x.id));
        } else {
            s.sessions.forEach(x => next.add(x.id));
        }
        return { selectedIds: next };
    }),

    clearSelection: () => set({ selectedIds: new Set() }),

    restore: async (ids) => {
        await api.post("/api/trash/sessions/restore", { sessionIds: ids });
        set((s) => {
            const next = new Set(s.selectedIds);
            ids.forEach(id => next.delete(id));
            return { selectedIds: next };
        });
        await get().loadTrash();
    },

    permanentlyDelete: async (ids) => {
        await api.del("/api/trash/sessions", { sessionIds: ids });
        set((s) => {
            const next = new Set(s.selectedIds);
            ids.forEach(id => next.delete(id));
            return { selectedIds: next };
        });
        await get().loadTrash();
    },

    emptyTrash: async () => {
        const res = await api.del("/api/trash/sessions") as { deleted?: number };
        set({ selectedIds: new Set() });
        await get().loadTrash();
        return res.deleted ?? 0;
    },

    openViewer: (sessionId) => set({ viewerSessionId: sessionId }),
    closeViewer: () => set({ viewerSessionId: null }),
}));
```

- [ ] **步骤 4：修改 store/projects.ts 防御性过滤**

在 `useProjectsStore` 的 state 中，找到 sessions 相关字段。在 `setAll` 方法中添加过滤：

```typescript
setAll: (projects, sessions) => set((s) => {
    const active = sessions.filter(x => !x.deletedAt);
    const stillExists = s.currentSessionId && active.some(x => x.id === s.currentSessionId);
    return { projects, sessions: active, currentSessionId: stillExists ? s.currentSessionId : null };
}),
```

- [ ] **步骤 5：创建 RecycleBinButton 组件**

创建 `packages/frontend/src/components/RecycleBinButton.tsx`：

```tsx
import { useTranslation } from "../i18n/useTranslation";

interface Props {
    onClick: () => void;
    count?: number;
}

export function RecycleBinButton({ onClick, count }: Props) {
    const { t } = useTranslation();
    return (
        <button
            onClick={onClick}
            aria-label={t("trash.title")}
            title={t("trash.title")}
            className="w-full text-left px-2 py-1.5 text-xs text-tertiary transition-colors hover:text-brand inline-flex items-center gap-1"
            data-testid="recycle-bin-btn"
        >
            <span className="text-[calc(16px*var(--font-scale))]">🗑️</span>{" "}
            {t("trash.title")}
            {count != null && count > 0 && (
                <span
                    className="ml-1 text-[10px] bg-danger text-on-danger rounded-full px-1.5 leading-4"
                    data-testid="recycle-bin-badge"
                >
                    {count > 99 ? "99+" : count}
                </span>
            )}
        </button>
    );
}
```

- [ ] **步骤 6：修改 Sidebar.tsx 底部栏**

在 `Sidebar.tsx` 中，找到底部的 `SettingsButton`（约第 70 行），将其改为两个按钮并排。添加 state 控制 RecycleBinModal 的开关：

```tsx
// 在组件顶部添加 state
const [showTrash, setShowTrash] = useState(false);

// 底部栏改为：
<div className="flex gap-1 px-1 pb-1">
    <RecycleBinButton onClick={() => setShowTrash(true)} />
    <SettingsButton onClick={() => useSettingsStore.getState().open()} />
</div>

// 在组件 return 的末尾，与其他 Modal 同级添加：
{showTrash && (
    <RecycleBinModal onClose={() => setShowTrash(false)} />
)}
```

需要在文件顶部 import：

```tsx
import { useState } from "react";
import { RecycleBinButton } from "./RecycleBinButton";
import { RecycleBinModal } from "./RecycleBinModal";
```

注意：RecycleBinModal 组件在任务 8 中创建。此处先 import，如果编译报错可暂时注释，任务 8 完成后取消注释。

- [ ] **步骤 7：Commit**

```bash
cd H:/workspace/hiagent
git add packages/frontend/src/i18n/locales/zh.ts packages/frontend/src/i18n/locales/en.ts packages/frontend/src/store/trash.ts packages/frontend/src/store/projects.ts packages/frontend/src/components/RecycleBinButton.tsx packages/frontend/src/components/Sidebar.tsx
git commit -m "feat(frontend): 回收站 i18n + store/trash.ts + RecycleBinButton + Sidebar 集成"
```

---

## 任务 8：回收站弹窗 + 会话行组件

**文件：**

- 创建：`packages/frontend/src/components/TrashSessionRow.tsx`
- 创建：`packages/frontend/src/components/RecycleBinModal.tsx`

- [ ] **步骤 1：创建 TrashSessionRow 组件**

创建 `packages/frontend/src/components/TrashSessionRow.tsx`：

```tsx
import { memo } from "react";
import type { SessionEntity, ProjectEntity } from "@wa-pi/shared";
import { AGENT_DEFS, agentDefOf, SYSTEM_PROJECT_NAME } from "@wa-pi/shared";
import { useTranslation } from "../i18n/useTranslation";

interface Props {
    session: SessionEntity;
    project: ProjectEntity | undefined;
    selected: boolean;
    onToggleSelect: (id: string) => void;
    onView: (id: string) => void;
}

function relativeTime(ts: number): string {
    const diff = Date.now() - ts;
    const day = 24 * 60 * 60 * 1000;
    if (diff < day) return `${Math.floor(diff / (60 * 60 * 1000))}小时前`;
    if (diff < 7 * day) return `${Math.floor(diff / day)}天前`;
    return `${Math.floor(diff / (7 * day))}周前`;
}

export const TrashSessionRow = memo(function TrashSessionRow({
    session, project, selected, onToggleSelect, onView,
}: Props) {
    const { t } = useTranslation();
    const isIM = session.id.startsWith("im-");
    const def = agentDefOf(session.primaryAgent);
    const emoji = def?.emoji ?? "🤖";
    const projectName = project?.name ?? SYSTEM_PROJECT_NAME;
    const reason = session.deletedReason === "auto"
        ? t("trash.reasonAuto")
        : t("trash.reasonManual");

    return (
        <div
            className={`flex items-center gap-3 px-3 py-2.5 rounded cursor-pointer transition-colors border border-transparent hover:bg-surface-hover ${selected ? "bg-brand-bg border-brand-border" : ""}`}
            data-testid={`trash-row-${session.id}`}
            onClick={() => onToggleSelect(session.id)}
        >
            <input
                type="checkbox"
                checked={selected}
                onChange={() => onToggleSelect(session.id)}
                onClick={(e) => e.stopPropagation()}
                className="accent-brand"
                data-testid={`trash-checkbox-${session.id}`}
            />
            <span className="text-base shrink-0">{emoji}</span>
            <span className="text-sm font-medium truncate w-40 shrink-0">
                {isIM && "📱 "}
                {session.primaryAgent}
            </span>
            {isIM && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-warning-bg text-warning border border-warning-border shrink-0">
                    {t("trash.imTag")}
                </span>
            )}
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-brand-bg text-brand border border-brand-border shrink-0">
                {projectName}
            </span>
            <span className="flex-1 text-xs text-tertiary flex items-center gap-1">
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${session.deletedReason === "auto" ? "bg-warning-bg text-warning" : "bg-danger-bg text-danger"}`}>
                    {reason}
                </span>
                {session.deletedAt && <span>· {relativeTime(session.deletedAt)}</span>}
            </span>
            <button
                onClick={(e) => { e.stopPropagation(); onView(session.id); }}
                className="w-7 h-7 rounded border border-hairline bg-surface hover:border-brand text-xs shrink-0"
                title={t("trash.viewerBack")}
                data-testid={`trash-view-${session.id}`}
            >
                👁
            </button>
        </div>
    );
});
```

- [ ] **步骤 2：创建 RecycleBinModal 组件**

创建 `packages/frontend/src/components/RecycleBinModal.tsx`：

```tsx
import { useEffect, useState } from "react";
import { Modal } from "./ui/Modal";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { TrashSessionRow } from "./TrashSessionRow";
import { TrashMessageViewer } from "./TrashMessageViewer";
import { useTrashStore } from "../store/trash";
import { useTranslation } from "../i18n/useTranslation";

interface Props {
    onClose: () => void;
}

export function RecycleBinModal({ onClose }: Props) {
    const { t } = useTranslation();
    const store = useTrashStore();
    const [confirmEmpty, setConfirmEmpty] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);

    useEffect(() => {
        void store.loadTrash();
    }, []);

    // 消息查看器模式
    if (store.viewerSessionId) {
        return (
            <Modal onClose={() => { store.closeViewer(); }} width="80vw" height="80vh" closeOnOverlayClick={true}>
                <TrashMessageViewer
                    sessionId={store.viewerSessionId}
                    onBack={() => store.closeViewer()}
                />
            </Modal>
        );
    }

    const selectedCount = store.selectedIds.size;
    const totalPages = Math.max(1, Math.ceil(store.total / store.pageSize));

    return (
        <Modal onClose={onClose} width="80vw" height="80vh" data-testid="recycle-bin-modal">
            <div className="flex flex-col h-full">
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-3 border-b border-hairline">
                    <div className="flex items-center gap-2">
                        <span className="text-lg">🗑️</span>
                        <span className="text-base font-semibold">{t("trash.title")}</span>
                        {store.total > 0 && (
                            <span className="text-xs text-tertiary">
                                {t("trash.total", { count: store.total })}
                            </span>
                        )}
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded bg-surface-hover text-tertiary" data-testid="trash-close">✕</button>
                </div>

                {/* Toolbar: project tabs */}
                <div className="flex items-center justify-between px-5 py-2 border-b border-hairline gap-3">
                    <div className="flex gap-1 flex-wrap">
                        <button
                            onClick={() => store.setProjectFilter(null)}
                            className={`text-xs px-3 py-1 rounded-full border ${store.activeProjectId === null ? "bg-brand text-white border-brand" : "bg-surface border-hairline text-tertiary"}`}
                        >
                            {t("trash.filterAll")}
                        </button>
                        {store.projects.map((p) => (
                            <button
                                key={p.id}
                                onClick={() => store.setProjectFilter(p.id)}
                                className={`text-xs px-3 py-1 rounded-full border ${store.activeProjectId === p.id ? "bg-brand text-white border-brand" : "bg-surface border-hairline text-tertiary"}`}
                            >
                                {p.name}
                            </button>
                        ))}
                    </div>
                </div>

                {/* List */}
                <div className="flex-1 overflow-y-auto px-5 py-2">
                    {store.loading ? (
                        <div className="flex items-center justify-center h-full text-tertiary">...</div>
                    ) : store.sessions.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full text-tertiary gap-2">
                            <span className="text-4xl">📭</span>
                            <span>{t("trash.empty")}</span>
                        </div>
                    ) : (
                        <>
                            <div className="flex items-center gap-2 py-2 text-xs text-tertiary border-b border-hairline mb-1">
                                <button onClick={() => store.selectAllOnPage()} className="hover:text-brand">
                                    {t("trash.selectAll")}
                                </button>
                                {selectedCount > 0 && (
                                    <span>({t("trash.selected", { selected: selectedCount, total: store.total })})</span>
                                )}
                            </div>
                            {store.sessions.map((s) => (
                                <TrashSessionRow
                                    key={s.id}
                                    session={s}
                                    project={store.projects.find((p) => p.id === s.projectId)}
                                    selected={store.selectedIds.has(s.id)}
                                    onToggleSelect={store.toggleSelect}
                                    onView={store.openViewer}
                                />
                            ))}
                        </>
                    )}
                </div>

                {/* Pagination */}
                {store.total > store.pageSize && (
                    <div className="flex items-center justify-between px-5 py-2 border-t border-hairline text-xs text-tertiary">
                        <span>{t("trash.total", { count: store.total })} · {store.currentPage + 1}/{totalPages}</span>
                        <div className="flex gap-2">
                            <button
                                onClick={() => store.setPage(store.currentPage - 1)}
                                disabled={store.currentPage === 0}
                                className="px-3 py-1 rounded border border-hairline bg-surface disabled:opacity-40"
                            >
                                ‹ {t("trash.filterAll") === "All" ? "Prev" : "上一页"}
                            </button>
                            <button
                                onClick={() => store.setPage(store.currentPage + 1)}
                                disabled={store.currentPage >= totalPages - 1}
                                className="px-3 py-1 rounded border border-hairline bg-surface disabled:opacity-40"
                            >
                                {t("trash.filterAll") === "All" ? "Next" : "下一页"} ›
                            </button>
                        </div>
                    </div>
                )}

                {/* Footer actions */}
                <div className="flex items-center gap-3 px-5 py-3 border-t border-hairline bg-surface">
                    <button
                        onClick={() => selectedCount > 0 && void store.restore([...store.selectedIds])}
                        disabled={selectedCount === 0}
                        className="px-4 py-2 rounded bg-success text-on-success text-sm disabled:opacity-40"
                        data-testid="trash-restore-btn"
                    >
                        ↩️ {selectedCount > 0 ? t("trash.restoreCount", { count: selectedCount }) : t("trash.restore")}
                    </button>
                    <button
                        onClick={() => selectedCount > 0 && setConfirmDelete(true)}
                        disabled={selectedCount === 0}
                        className="px-4 py-2 rounded border border-danger text-danger text-sm disabled:opacity-40"
                        data-testid="trash-delete-btn"
                    >
                        🗑️ {t("trash.delete")}
                    </button>
                    <button
                        onClick={() => store.total > 0 && setConfirmEmpty(true)}
                        disabled={store.total === 0}
                        className="ml-auto px-4 py-2 rounded border border-hairline text-tertiary hover:border-danger hover:text-danger text-sm disabled:opacity-40"
                        data-testid="trash-empty-btn"
                    >
                        ⚡ {t("trash.emptyAll")}
                    </button>
                </div>
            </div>

            {confirmEmpty && (
                <ConfirmDialog
                    title={t("trash.confirmEmptyTitle")}
                    message={t("trash.confirmEmptyMsg", { count: store.total })}
                    confirmText={t("trash.emptyAll")}
                    danger
                    onConfirm={async () => { await store.emptyTrash(); setConfirmEmpty(false); }}
                    onCancel={() => setConfirmEmpty(false)}
                />
            )}
            {confirmDelete && (
                <ConfirmDialog
                    title={t("trash.confirmDeleteTitle")}
                    message={t("trash.confirmDeleteMsg", { count: selectedCount })}
                    confirmText={t("trash.delete")}
                    danger
                    onConfirm={async () => { await store.permanentlyDelete([...store.selectedIds]); setConfirmDelete(false); }}
                    onCancel={() => setConfirmDelete(false)}
                />
            )}
        </Modal>
    );
}
```

- [ ] **步骤 3：Commit（RecycleBinModal 引用了 TrashMessageViewer，任务 9 创建）**

```bash
cd H:/workspace/hiagent
git add packages/frontend/src/components/TrashSessionRow.tsx packages/frontend/src/components/RecycleBinModal.tsx
git commit -m "feat(frontend): TrashSessionRow + RecycleBinModal 弹窗组件（含分页/多选/确认对话框）"
```

---

## 任务 9：只读消息查看器 + 设置面板

**文件：**

- 创建：`packages/frontend/src/components/TrashMessageViewer.tsx`
- 修改：`packages/frontend/src/components/settings/GeneralSection.tsx`

- [ ] **步骤 1：创建 TrashMessageViewer 组件**

创建 `packages/frontend/src/components/TrashMessageViewer.tsx`：

```tsx
import { useEffect, useState } from "react";
import { api } from "../api-client";
import { useTrashStore } from "../store/trash";
import { useSessionStore } from "../store/session";
import { MessageList } from "./MessageList";
import { useTranslation } from "../i18n/useTranslation";
import type { SessionMessage } from "@wa-pi/shared";

interface Props {
    sessionId: string;
    onBack: () => void;
}

export function TrashMessageViewer({ sessionId, onBack }: Props) {
    const { t } = useTranslation();
    const [loading, setLoading] = useState(true);
    const [notFound, setNotFound] = useState(false);

    useEffect(() => {
        setLoading(true);
        // 复用现有的 /api/sessions/:id/messages 端点
        // 软删除不删 jsonl 文件，直接读取历史
        void api.get(`/api/sessions/${encodeURIComponent(sessionId)}/messages`)
            .then((res) => {
                const data = res as { messages: SessionMessage[] };
                useSessionStore.getState().setMessages(sessionId, data.messages ?? []);
                setLoading(false);
            })
            .catch(() => {
                setNotFound(true);
                setLoading(false);
            });
    }, [sessionId]);

    const handleRestore = async () => {
        await useTrashStore.getState().restore([sessionId]);
        onBack();
    };

    if (notFound) {
        return (
            <div className="flex flex-col h-full">
                <div className="flex items-center gap-2 px-5 py-3 border-b border-hairline">
                    <button onClick={onBack} className="text-brand text-sm">‹ {t("trash.viewerBack")}</button>
                </div>
                <div className="flex-1 flex items-center justify-center text-tertiary">
                    {t("trash.messagesNotFound")}
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="flex items-center gap-2 px-5 py-3 border-b border-hairline">
                <button onClick={onBack} className="text-brand text-sm" data-testid="trash-viewer-back">
                    ‹ {t("trash.viewerBack")}
                </button>
            </div>

            {/* Notice */}
            <div className="mx-5 my-2 px-3 py-2 rounded bg-warning-bg border border-warning-border text-xs text-warning flex items-center gap-2">
                <span>⚠️</span>
                <span>
                    {t("trash.viewerNotice")}
                    <button onClick={() => void handleRestore()} className="text-brand underline ml-1">
                        {t("trash.viewerRestoreLink")}
                    </button>
                    <span className="ml-1">{t("trash.viewerRestoreHint")}</span>
                </span>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-5">
                {loading ? (
                    <div className="flex items-center justify-center h-full text-tertiary">...</div>
                ) : (
                    <MessageList sessionId={sessionId} />
                )}
            </div>

            {/* Footer */}
            <div className="px-5 py-2 border-t border-hairline text-center text-xs text-tertiary">
                📖 {t("trash.viewerReadonly")}
            </div>
        </div>
    );
}
```

- [ ] **步骤 2：修改 GeneralSection.tsx 添加回收站设置**

在 `GeneralSection.tsx` 中，在现有设置项之后添加回收站配置区块。需要先在组件顶部加载设置：

```tsx
// 在组件函数体中添加：
const [autoArchive, setAutoArchive] = useState(true);
const [archiveDays, setArchiveDays] = useState("7");
const [autoPurge, setAutoPurge] = useState(false);
const [purgeDays, setPurgeDays] = useState("30");

useEffect(() => {
    api.get("/api/settings/trash")
        .then((res) => {
            const trash = (res as any)?.trash;
            if (trash) {
                setAutoArchive(trash.autoArchiveEnabled);
                setArchiveDays(String(trash.autoArchiveDays));
                setAutoPurge(trash.autoPurgeEnabled);
                setPurgeDays(String(trash.autoPurgeDays));
            }
        })
        .catch(() => {});
}, []);

const saveTrashSettings = async () => {
    await api.put("/api/settings/trash", {
        trash: {
            autoArchiveEnabled: autoArchive,
            autoArchiveDays: Number(archiveDays) || 7,
            autoPurgeEnabled: autoPurge,
            autoPurgeDays: Number(purgeDays) || 30,
        },
    });
};
```

在 `handleSave` 函数中追加 `await saveTrashSettings();`。

在 JSX 渲染中（现有设置项之后，保存按钮之前）添加：

```tsx
<div className="border-t border-hairline pt-4 mt-4">
    <h3 className="text-sm font-semibold mb-3">🗑️ {t("settings.trashSection")}</h3>
    <div className="space-y-3">
        <div className="flex items-start justify-between">
            <div>
                <div className="text-sm">{t("settings.trashAutoArchive")}</div>
            </div>
            <button
                onClick={() => setAutoArchive(!autoArchive)}
                className={`w-10 h-5 rounded-full relative transition-colors ${autoArchive ? "bg-success" : "bg-hairline"}`}
            >
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${autoArchive ? "left-5" : "left-0.5"}`} />
            </button>
        </div>
        <div className={`flex items-center gap-2 ${autoArchive ? "" : "opacity-40"}`}>
            <span className="text-xs text-tertiary">{t("settings.trashArchiveDays", { days: archiveDays })}</span>
            <input
                type="number" min={1} max={365} value={archiveDays}
                onChange={(e) => setArchiveDays(e.target.value)}
                disabled={!autoArchive}
                className="w-16 px-2 py-1 rounded border border-hairline bg-surface text-sm text-center"
            />
            <span className="text-xs text-tertiary">天</span>
        </div>
        <div className="flex items-start justify-between">
            <div>
                <div className="text-sm">{t("settings.trashAutoPurge")}</div>
            </div>
            <button
                onClick={() => setAutoPurge(!autoPurge)}
                className={`w-10 h-5 rounded-full relative transition-colors ${autoPurge ? "bg-success" : "bg-hairline"}`}
            >
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${autoPurge ? "left-5" : "left-0.5"}`} />
            </button>
        </div>
        <div className={`flex items-center gap-2 ${autoPurge ? "" : "opacity-40"}`}>
            <span className="text-xs text-tertiary">{t("settings.trashPurgeDays", { days: purgeDays })}</span>
            <input
                type="number" min={1} max={365} value={purgeDays}
                onChange={(e) => setPurgeDays(e.target.value)}
                disabled={!autoPurge}
                className="w-16 px-2 py-1 rounded border border-hairline bg-surface text-sm text-center"
            />
            <span className="text-xs text-tertiary">天</span>
        </div>
    </div>
</div>
```

- [ ] **步骤 3：验证前端编译**

运行：`cd H:/workspace/hiagent/packages/frontend && bun run build` 或 `bunx tsc --noEmit`
预期：无类型错误

- [ ] **步骤 4：Commit**

```bash
cd H:/workspace/hiagent
git add packages/frontend/src/components/TrashMessageViewer.tsx packages/frontend/src/components/settings/GeneralSection.tsx
git commit -m "feat(frontend): TrashMessageViewer 只读消息查看器 + GeneralSection 回收站设置"
```

---

## 任务 10：集成验证 + CHANGELOG

**文件：**

- 修改：`CHANGELOG.md`

- [ ] **步骤 1：更新 CHANGELOG**

在 `CHANGELOG.md` 顶部添加：

```markdown
## 2026-08-09 — 新增功能

### 会话回收站
- 删除的会话自动进入回收站，支持恢复
- 支持自动归档：超过 N 天未活动的会话自动移入回收站（默认 7 天）
- 回收站支持按项目筛选、分页浏览（每页 100 条）
- 支持批量恢复、批量彻底删除、清空整个回收站
- 回收站内可只读查看会话消息内容
- 可选自动清理回收站（默认关闭），防止文件膨胀
- **影响范围：** `shared/types.ts`, `kernel/project-store.ts`, `kernel/ws-server.ts`, `kernel/index.ts`, `frontend/store/trash.ts`, `frontend/components/RecycleBinModal.tsx`, `frontend/components/Sidebar.tsx`
```

- [ ] **步骤 2：端到端手动验证清单**

启动应用后逐项验证：

1. [ ] 右键会话 → 删除 → 打开回收站 → 看到该会话
2. [ ] 回收站中勾选会话 → 点恢复 → 会话回到侧边栏列表
3. [ ] 回收站中勾选会话 → 点彻底删除 → 二次确认 → 确认 → 会话永久消失
4. [ ] 点清空回收站 → 二次确认 → 确认 → 回收站为空
5. [ ] 点击会话的 👁 → 看到只读消息列表 → 无输入框
6. [ ] 项目 tab 切换筛选正常
7. [ ] 设置面板 → 开关自动归档 → 修改天数 → 保存 → 重启后设置保留
8. [ ] 删除超过 100 个会话 → 分页正常

- [ ] **步骤 3：Commit**

```bash
cd H:/workspace/hiagent
git add CHANGELOG.md
git commit -m "docs: CHANGELOG 更新 - 会话回收站功能"
```

---

## 自检

### 规格覆盖度

| 规格章节 | 对应任务 | 状态 |
| --------- | --------- | ------ |
| §4 数据模型 SessionEntity | 任务 1 | ✅ |
| §5.1 ProjectStore 方法 | 任务 2-3 | ✅ |
| §5.2 WS 事件（trash:list/restore/delete/empty） | 任务 5 | ✅ |
| §5.2 projects:list 过滤 | 任务 5 | ✅ |
| §5.3 HTTP 路由 | 任务 5 | ✅ |
| §5.4 自动归档调度器 | 任务 6 | ✅ |
| §5.5 边界处理（恢复到默认工作区） | 任务 2 (restoreSession) | ✅ |
| §6.1 Sidebar 入口 | 任务 7 | ✅ |
| §6.2 RecycleBinModal | 任务 8 | ✅ |
| §6.3 TrashMessageViewer | 任务 9 | ✅ |
| §6.4 TrashSessionRow | 任务 8 | ✅ |
| §6.5 store/trash.ts | 任务 7 | ✅ |
| §6.6 store/projects.ts 过滤 | 任务 7 | ✅ |
| §7 设置项 | 任务 4 + 任务 9 | ✅ |
| §8 国际化文案 | 任务 7 | ✅ |
| ~~§5.2 trash:messages~~ | ~~任务 5~~ | ❌ 不需要 — 复用现有 `/api/sessions/:id/messages`（任务 9 步骤 1） |

### 占位符扫描

无 TODO、无"待定"、无"类似任务 N"引用。每个步骤都有完整代码。

### 类型一致性

- `TrashListRequest.projectId` / `offset` / `limit` — 任务 1 定义，任务 5 使用 ✅
- `TrashOpResult.success` / `deleted` — 任务 1 定义，任务 5 使用 ✅
- `ProjectStore.loadTrash` 返回 `{ sessions, total }` — 任务 3 定义，任务 5/7 使用 ✅
- `useTrashStore` 的 action 签名 — 任务 7 定义，任务 8 使用 ✅
- `TrashSessionRow` props — 任务 8 定义，任务 8 使用 ✅
