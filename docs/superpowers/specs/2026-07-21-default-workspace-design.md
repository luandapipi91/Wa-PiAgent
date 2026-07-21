# 会话列表新增「默认工作区」虚拟项目

**日期**: 2026-07-21
**状态**: 设计中

## 概述

在会话列表顶部新增一个常驻的 **🏠 默认工作区** 虚拟项目（本质是一个 `ProjectEntity`，`id = "__system__"`，`cwd = ~/.hiagent/workdir/`）。该项目不可删除、不可改名，作为"没有具体工程目录时的默认聊天空间"。

默认工作区下的每个会话有独立的 cwd：**`~/.hiagent/workdir/<session.createdAt>/`**，新建会话时 `mkdir -p`，确保 agent 的文件操作都被隔离在自己会话的子目录里。

默认工作区的会话**可以删除**（流程同普通项目会话），但删除后**保留** `<createdAt>/` 子目录，由后台清理任务 **7 天后** 自动清理（带"被现存 session 引用则不删"的保护）。

skill / mcp **完全继承全局配置**：skill 天然全局（无需改动）；mcp 通过"不在 `<createdAt>/` 下创建 `.mcp.json`"，让 SDK 自动只发现 `~/.hiagent/mcp.json` 全局配置（无需新增逻辑）。

## 设计目标

1. 会话列表有一个常驻的"默认工作区"入口，新建会话流程与普通项目**完全一致**
2. 默认工作区的每个会话有**独立隔离的 pwd**（`~/.hiagent/workdir/<createdAt>/`），互不干扰
3. **完全不动数据模型**（`SessionEntity` / `ProjectEntity` 不加任何字段），向后兼容老数据
4. 删会话时 `<createdAt>/` 目录保留 7 天后再清理，用户有后悔期
5. skill / mcp 继承全局，无需新增独立管理
6. 系统项目不可删除/改名，普通项目操作不受任何影响

## 非目标

- 不支持用户自定义 `workdir` 根目录位置（固定 `~/.hiagent/workdir/`）
- 不支持普通项目会话的 per-session pwd（仅默认工作区享有隔离）
- 不支持用户手动配置 `<createdAt>/` 子目录的命名格式（固定时间戳）
- 不实现 `inheritSkills` / `inheritProjectContext` 字段（死字段，后端无消费，保持现状）

## 现状（不改动的地方）

- `SessionEntity`（`shared/src/types.ts:65-73`）：**不新增 cwd 字段**。所有 cwd 判断运行时从 `session.createdAt` 推导
- `ProjectEntity`（`shared/src/types.ts:58-63`）：**不新增 isSystem 字段**。所有判断走 `project.id === SYSTEM_PROJECT_ID` 常量
- `skill-manager.ts`：skill 配置文件 `~/.hiagent/settings.json` + 内置目录 `~/.hiagent/skills/`，所有会话共享同一份——天然全局，无需改动
- `mcp-store.ts`：全局 MCP 配置 `~/.hiagent/mcp.json`，项目级 MCP 配置 `<project.cwd>/.mcp.json`。默认工作区的 `<createdAt>/` 目录下**不创建** `.mcp.json`，SDK 自动只继承全局
- `projects.json` 结构 `{ projects: [], sessions: [] }` 不变
- WS 协议事件不变：复用 `projects:list` / `session:created` / `agent:prompt` / `session:delete` 等

## 改造点

### ① shared 常量（`packages/shared/src/constants.ts`）

新增 4 个常量：

```ts
export const SYSTEM_PROJECT_ID = "__system__";
export const SYSTEM_PROJECT_NAME = "默认工作区";
export const SYSTEM_PROJECT_CWD = join(HIAGENT_DIR, "workdir");    // ~/.hiagent/workdir
export const WORKDIR_TTL_DAYS = 7;
```

### ② 启动时 seed 系统项目（`packages/kernel/src/index.ts`）

在 `migrateLegacySessions` 之后调用一个新的幂等函数：

```ts
// 伪代码
async function ensureSystemProject(projectStore: ProjectStore): Promise<void> {
  const { projects } = await projectStore.load();
  const exists = projects.some(p => p.id === SYSTEM_PROJECT_ID);
  if (!exists) {
    await projectStore.createSystemProject({
      id: SYSTEM_PROJECT_ID,
      name: SYSTEM_PROJECT_NAME,
      cwd: SYSTEM_PROJECT_CWD,
    });
  }
  await mkdir(SYSTEM_PROJECT_CWD, { recursive: true });
}
```

### ③ `ProjectStore` 新增方法（`packages/kernel/src/project-store.ts`）

新增 `createSystemProject`，**绕过现有 `createProject` 的 cwd 去重检查和 id 生成**（系统项目要固定 id）：

```ts
async createSystemProject(input: {
  id: string; name: string; cwd: string;
}): Promise<ProjectEntity> {
  const data = await this.load();
  // 已存在则跳过（幂等）
  if (data.projects.some(p => p.id === input.id)) {
    return data.projects.find(p => p.id === input.id)!;
  }
  const project: ProjectEntity = {
    id: input.id, name: input.name, cwd: input.cwd,
    createdAt: Date.now(),
  };
  data.projects.push(project);
  await this.save(data);
  return project;
}
```

### ④ WS handler 保护与 cwd 注入（`packages/kernel/src/ws-server.ts`）

#### 4.1 项目删除/改名保护

`project:delete` / `project:update` handler 入口加判断：

```ts
if (projectId === SYSTEM_PROJECT_ID) {
  broadcast({ type: "error", message: "默认工作区不可修改/删除" });
  return;
}
```

#### 4.2 会话创建时生成 `<createdAt>/` 目录

`agent:prompt` handler 的 `isNew = !existing` 分支内：

```ts
if (projectId === SYSTEM_PROJECT_ID) {
  // 1. 先生成 ts 作为目录名，同时作为 createSession 的 createdAt
  const ts = Date.now();
  // 2. 调 createSession({ ..., createdAt: ts }) 让 SessionEntity.createdAt === ts
  // 3. mkdir(join(SYSTEM_PROJECT_CWD, String(ts)))
  // 这样后续从 session.createdAt 推导 cwd 时能对上目录名
}
```

详细说明见下方"关键细节（一致性）"。

**关键细节（一致性）**：

为了让"目录名"和"`session.createdAt`（运行时推导 cwd 的依据）"严格一致，必须让 `createSession` 接收外部传入的 createdAt。具体做法：

- `createSession` 的**输入参数对象**新增可选字段 `createdAt?: number`（注意：是 input 参数，**不**修改 `SessionEntity` 类型本身，也不持久化为"新字段"——`SessionEntity.createdAt` 本来就有）。`ws-server` 先取 `ts = Date.now()`，传给 `createSession({ createdAt: ts })`，同时 `mkdir(join(SYSTEM_PROJECT_CWD, String(ts)))`。这样 `session.createdAt === ts === 目录名`，重启后推导一致。

> 说明：这**不算"加字段"**。`SessionEntity.createdAt` 早已存在（`types.ts:70`），这里只是让 `createSession` 的 input 允许显式传入该值（默认仍用内部 `Date.now()`），普通项目会话调用方式完全不变。

**同毫秒冲突**：理论上用户点击不可能同毫秒触发两个全局会话。本设计**不专门处理**（`mkdir` 默认 recursive，若两个会话撞到同一目录会共享，但概率可忽略）。实施时如担心，可在 mkdir 前 `existsSync` 检查，存在则重生成 ts 重试。

### ⑤ agent-manager pwd 取值（`packages/kernel/src/agent-manager.ts`）

**`resolveSessionCwd` 定义在第 ⑩ 节 `shared/src/pure.ts`，前后端共享同一份。**

在 `_createSession`（行 307-311、395-438、454-464、477）把所有 `project.cwd` 替换为 `resolveSessionCwd(session, project)`：

- 行 307-311：取 project 后，同时取 session 实体（`projectStore.findSession` 或参数透传）
- 行 396：`DefaultResourceLoader({ cwd: resolveSessionCwd(...), ... })`
- 行 455：`createFn({ cwd: resolveSessionCwd(...), ... })`
- 行 477：`this.sessionCwd.set(sessionId, resolveSessionCwd(...))`

附件相对路径转换（`buildPromptContent`，行 783-808）也基于 `sessionCwd.get(sessionId)`，自动跟随。

### ⑥ 上传目录（`packages/kernel/src/ws-server.ts`）

现状：`ws-server.ts:563/587/663/676/689` 全部写死 `join(project.cwd, ".hiagent", "uploads")`。

改动：新增辅助函数，按 session 推导：

```ts
function resolveUploadDir(project: ProjectEntity, session: SessionEntity): string {
  const base = resolveSessionCwd(session, project);
  return join(base, ".hiagent", "uploads");
}
```

所有上传相关 handler 改用这个函数。普通项目会话行为完全不变（base = project.cwd）。

### ⑦ 删除会话：保留 `<createdAt>/` 目录

`session:delete` handler 的现有流程**只删 session 记录，不动磁盘**——天然满足"保留目录"。清理由下节 ⑧ 的定时任务负责。

### ⑧ workdir 7 天清理任务（新增 `packages/kernel/src/workdir-cleaner.ts`）

```ts
import { rm, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { SYSTEM_PROJECT_CWD, WORKDIR_TTL_DAYS } from "@hiagent/shared";
import type { ProjectStore } from "./project-store";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 扫描 SYSTEM_PROJECT_CWD 下的子目录：
 *   - 目录名是纯数字（时间戳）
 *   - 仍被现存 session 引用（session.cwd 推导后等于该路径）→ 跳过
 *   - mtime 超过 WORKDIR_TTL_DAYS 天 → rm -rf
 * 返回清理的目录数。
 */
export async function cleanupExpiredWorkdirs(
  projectStore: ProjectStore
): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(SYSTEM_PROJECT_CWD);
  } catch {
    return 0;  // 根目录不存在
  }

  const { sessions } = await projectStore.load();
  // 计算所有现存 session 的推导 cwd（仅系统项目）
  const activeDirs = new Set<string>();
  for (const s of sessions) {
    if (s.projectId === SYSTEM_PROJECT_ID) {
      activeDirs.add(join(SYSTEM_PROJECT_CWD, String(s.createdAt)));
    }
  }

  const now = Date.now();
  let cleaned = 0;
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;  // 非时间戳目录跳过
    const dirPath = join(SYSTEM_PROJECT_CWD, name);
    if (activeDirs.has(dirPath)) continue;  // 被现存会话引用，跳过
    let st;
    try {
      st = await stat(dirPath);
    } catch {
      continue;
    }
    if (now - st.mtimeMs > WORKDIR_TTL_DAYS * DAY_MS) {
      await rm(dirPath, { recursive: true, force: true });
      cleaned++;
    }
  }
  return cleaned;
}
```

**启动时机**（`index.ts`）：

```ts
// 启动时跑一次
await cleanupExpiredWorkdirs(projectStore);
// 每天定时跑一次
setInterval(() => {
  cleanupExpiredWorkdirs(projectStore).catch(e => {
    console.warn("[kernel] workdir 清理失败:", e);
  });
}, DAY_MS);
```

### ⑨ 前端改动

UI 决策汇总：

| 决策点 | 选择 |
|---|---|
| 侧栏位置 | **独立区**（在智能体区下方、项目区上方，小标题"默认"） |
| 组件复用 | 复用 `ProjectItem`，对 `id === SYSTEM_PROJECT_ID` 做差异化 |
| 项目右键菜单 | 仅"查看文件夹"（不显示重命名/删除项目） |
| 会话右键菜单 | 重命名 + 删除 + **额外加"打开工作目录"** |
| 项目下拉显示 | `🏠 默认工作区`（不显示 `~/.hiagent/workdir`） |
| 项目下拉默认选中 | 默认工作区优先选中（任何首次进入新建会话页时） |
| SessionView header | **友好文案**：`默认工作区 · 工作目录`（不暴露内部路径） |
| 点击项目名 | 进 NewSessionPane（同普通项目流程） |

#### 9.1 Sidebar 新增"默认"独立区（`packages/frontend/src/components/Sidebar.tsx`）

在 `AgentListSection` 与 `ProjectList` 之间插入一个独立分区：

```tsx
<AgentListSection ... />
{/* 默认工作区独立区 */}
<div className="flex-1 overflow-y-auto overflow-x-hidden">
  <div className="text-[11px] font-bold text-tertiary px-2 py-1 border-t border-hairline mt-2 uppercase tracking-wide">
    默认
  </div>
  {systemProject && (
    <ProjectItem
      project={systemProject}
      sessions={sessions}
      currentSessionId={currentSessionId}
      selected={systemProject.id === currentProjectId}
      isNewSessionView={isNewSessionView}
      onSelectSession={onSelectSession}
      onNewSessionInProject={onNewSessionInProject}
      onSelectProject={onSelectProject}
    />
  )}
</div>
<ProjectList ... />
```

`systemProject` 从 `useProjectsStore` 派生：`projects.find(p => p.id === SYSTEM_PROJECT_ID)`。

**注意**：`ProjectList` 内部需要过滤掉系统项目（避免重复出现），即 `projects.filter(p => p.id !== SYSTEM_PROJECT_ID)`。

#### 9.2 ProjectItem 差异化渲染（`packages/frontend/src/components/ProjectItem.tsx`）

引入 `SYSTEM_PROJECT_ID` 常量，按 `project.id === SYSTEM_PROJECT_ID` 做差异：

```tsx
const isSystem = project.id === SYSTEM_PROJECT_ID;

// ① 图标：系统项目折叠时显示 🏠（语义"home/默认"），展开后显示 📂（与普通项目一致）
{expanded ? "📂" : (isSystem ? "🏠" : "📁")}

// ② 项目名渲染：系统项目不加额外前缀（图标已区分），普通项目保持现状
{project.name}

// ③ 项目右键菜单（仅"查看文件夹"，系统项目不显示"删除项目"）
{projectMenu && createPortal(
  <div ...>
    <button onClick={handleOpenDir} ...>查看文件夹</button>
    {!isSystem && (
      <button onClick={handleProjectDeleteClick} ...>删除项目</button>
    )}
  </div>,
  document.body
)}

// ④ 会话右键菜单（系统项目多一项"打开工作目录"）
{sessionMenu && createPortal(
  <div ...>
    <button onClick={() => handleRename(sessionMenu.session)} ...>重命名会话</button>
    <button onClick={() => handleDeleteClick(sessionMenu.session)} ...>删除聊天</button>
    {isSystem && (
      <button
        onClick={() => handleOpenSessionDir(sessionMenu.session)}
        ...
      >打开工作目录</button>
    )}
  </div>,
  document.body
)}
```

新增 handler `handleOpenSessionDir`：通过 `project:open-dir` 事件，但传 session 级路径。新增 WS 事件或扩展 `project:open-dir` 入参为可选 `sessionId`：

```ts
// ws-server handler 扩展
if (e.type === "project:open-dir") {
  const project = projects.find(p => p.id === e.projectId);
  let dir = project?.cwd;
  if (e.sessionId) {
    const session = sessions.find(s => s.id === e.sessionId);
    if (session && session.projectId === SYSTEM_PROJECT_ID) {
      dir = resolveSessionCwd(session, project!);
    }
  }
  if (dir) openDir(dir);
}
```

或者更简单：新增一个独立 WS 事件 `session:open-dir`，前端对默认工作区会话用它。**writing-plans 阶段择一**。

#### 9.3 NewSessionPane 项目下拉（`packages/frontend/src/components/NewSessionPane.tsx:138`）

```tsx
{projects.map(p => (
  <option key={p.id} value={p.id}>
    {p.id === SYSTEM_PROJECT_ID ? "🏠 " : "📁 "}{p.name}
    {p.id === SYSTEM_PROJECT_ID ? "" : ` ${p.cwd}`}
  </option>
))}
```

系统项目作为选项出现，**不显示** cwd；普通项目照旧。

#### 9.4 NewSessionPane 默认选中（`NewSessionPane.tsx:40-41`）

现状：

```tsx
const initialProject = currentProjectId ?? projects[0]?.id ?? null;
```

改为优先选中系统项目：

```tsx
const initialProject =
  currentProjectId
  ?? projects.find(p => p.id === SYSTEM_PROJECT_ID)?.id
  ?? projects[0]?.id
  ?? null;
```

任何首次进入新建会话页时（无 `currentProjectId`），都默认选中默认工作区。

#### 9.5 SessionView header 显示（`packages/frontend/src/components/SessionView.tsx:99`）

现状：

```tsx
{project?.cwd ?? ""} · {AGENT_STATE_LABEL[headerStatus]}
```

改为按 session 归属差异化：

```tsx
{(session && session.projectId === SYSTEM_PROJECT_ID)
  ? "默认工作区 · 工作目录"
  : (project?.cwd ?? "")
} · {AGENT_STATE_LABEL[headerStatus]}
```

默认工作区的会话 header 显示 `默认工作区 · 工作目录`，不暴露 `~/.hiagent/workdir/<createdAt>/` 路径。

### ⑩ shared/pure.ts 抽取共享函数

把 `resolveSessionCwd` 放到 `packages/shared/src/pure.ts`，前后端复用：

```ts
export function resolveSessionCwd(
  session: { projectId: string; createdAt: number },
  project: { cwd: string }
): string {
  if (session.projectId === SYSTEM_PROJECT_ID) {
    return join(SYSTEM_PROJECT_CWD, String(session.createdAt));
  }
  return project.cwd;
}
```

agent-manager、ws-server、SessionView、workdir-cleaner 全部引用同一个函数，单一事实来源。

## 错误处理

| 场景 | 处理 |
|---|---|
| 系统项目被请求删除/改名 | `ws-server` 返回 error 广播，前端 toast 显示"默认工作区不可修改/删除" |
| `workdir/<ts>/` mkdir 失败（磁盘满等） | createSession 抛错，`agent:prompt` handler catch 后返回 error 广播，前端提示"会话目录创建失败" |
| workdir cleaner 误删 | 三重防护：目录名纯数字 + 不在 session 表里 + mtime 超 7 天 |
| workdir cleaner 抛错 | 单次清理失败不影响主流程，console.warn 后继续 |
| agent 在默认工作区会话内写文件 | 走 `<createdAt>/.hiagent/uploads/` 之外的常规写文件工具，SDK 自动按 cwd 隔离到 `<createdAt>/` 下 |

## 测试计划（4 层厕所原则）

### 第一层：单元测试（bun:test）

**`packages/kernel/test/project-store.test.ts`**
- `createSystemProject` 首次插入：返回带 `id === SYSTEM_PROJECT_ID` 的实体
- `createSystemProject` 二次调用：幂等，不重复插入
- `createSystemProject` 不影响普通 `createProject` 的去重逻辑

**新增 `packages/kernel/test/workdir-cleaner.test.ts`**
- 扫到 8 天前的孤立数字目录 → 删除
- 扫到 8 天前但被现存 session 引用的目录 → 不删
- 扫到非数字命名的目录 → 不动
- SYSTEM_PROJECT_CWD 不存在 → 返回 0 不抛错
- 扫到 1 天前的目录 → 不删（未超 TTL）

**`packages/kernel/test/agent-manager.test.ts`**
- `resolveSessionCwd`：`projectId === SYSTEM_PROJECT_ID` 时返回 `workdir/<createdAt>/`
- `resolveSessionCwd`：普通项目时返回 `project.cwd`

**`packages/shared/test/pure.test.ts`**
- `resolveSessionCwd` 前后端共享函数的纯函数行为

### 第二层：组件测试（Vitest + Testing Library + happy DOM）

**`packages/frontend/src/components/Sidebar.test.tsx`**
- projects 同时含系统项目和普通项目时，系统项目渲染在"默认"独立区，普通项目仍在"项目"区
- 系统项目不出现在"项目"区（去重）

**`packages/frontend/src/components/ProjectItem.test.tsx`**
- `project.id === SYSTEM_PROJECT_ID` 时：
  - 折叠状态图标为 🏠（普通项目为 📁）
  - 项目右键菜单仅显示"查看文件夹"，**不显示**"删除项目"
  - 会话右键菜单显示"重命名会话"+"删除聊天"+**"打开工作目录"**
- 普通项目时行为不变（项目右键菜单有"查看文件夹"+"删除项目"，会话右键菜单只有重命名+删除）

**`packages/frontend/src/components/NewSessionPane.test.tsx`**
- 首次进入（无 currentProjectId）时项目下拉默认选中 `__system__`
- 项目下拉里出现 `🏠 默认工作区` 选项，option 文本不含 `~/.hiagent/workdir`
- 普通项目 option 文本仍含 cwd
- 选择默认工作区后 `handleSend` 能成功（不因缺少普通 projectId 被拦截）

**`packages/frontend/src/components/SessionView.test.tsx`**
- `session.projectId === SYSTEM_PROJECT_ID` 时 header 显示 `默认工作区 · 工作目录`
- 普通项目会话 header 仍显示 `project.cwd`

### 第三层：API 集成测试（WS）

- 发 `agent:prompt` 带 `projectId = "__system__"` → 收到的 `session:created` 事件里 session 正常；磁盘上 `~/.hiagent/workdir/<createdAt>/` 目录被创建
- 发 `project:delete` 带 `projectId = "__system__"` → 收到 `error` 广播，且 `projects:list` 里系统项目仍存在
- 发 `project:update` 带 `projectId = "__system__"` → 收到 `error` 广播，name 不变
- 发 `session:delete` 删除默认工作区下的会话 → session 从 `projects:list` 消失，但 `~/.hiagent/workdir/<createdAt>/` 目录**仍在磁盘**
- 启动 kernel 后扫描 `~/.hiagent/workdir/` 下 8 天前的孤立目录 → 被清理；被现存 session 引用的目录保留

### 第四层：E2E（Playwright + Chromium）

1. 在侧栏"默认"独立区点击 `🏠 默认工作区` → 右侧进入新建会话页，项目下拉默认选中 `🏠 默认工作区`
2. 在新建会话页选择智能体、输入消息 → 发送 → 进入会话视图
3. SessionView header 显示 `默认工作区 · 工作目录`
4. 在会话视图让 agent 调用 `write_to_file` 工具创建一个文件 → 断言磁盘上 `~/.hiagent/workdir/<createdAt>/文件名` 存在
5. 右键该会话 → 菜单显示"重命名会话"+"删除聊天"+"打开工作目录"（三项都在）
6. 点"打开工作目录" → 系统文件管理器打开 `~/.hiagent/workdir/<createdAt>/`（macOS 用 Finder，可断言 WS 事件发出）
7. 右键项目名 → 菜单**仅**显示"查看文件夹"（无"删除项目"）
8. 删除该会话 → 侧栏列表更新；断言 `<createdAt>/` 目录**仍存在**于磁盘
9. 手动改 `<createdAt>/` 目录的 mtime 为 8 天前，触发 `cleanupExpiredWorkdirs(projectStore)` → 断言目录被删除
10. 截图清理：测试中产生的截图（如有）全部删除，不保留在项目中

## 数据迁移与兼容

- **老用户**：首次启动时 `ensureSystemProject` 自动写入系统项目（幂等），无需手动迁移
- **存量 session**：无任何变化（普通项目会话照旧用 `project.cwd`）
- **projects.json 结构**：无变化（只是新增一条 id=`__system__` 的 project 记录）

## CHANGELOG

根目录 `CHANGELOG.md` 新增一条（顶部）：

```
- 2026-07-21 / 新增功能
- 摘要：会话列表新增"🏠 默认工作区"常驻虚拟项目；默认工作区下的每个会话在
        ~/.hiagent/workdir/<createdAt>/ 下隔离 pwd，互不干扰；删除会话保留目录 7 天后
        自动清理；skill/mcp 继承全局配置
- 影响范围：shared/constants.ts、shared/pure.ts、kernel/index.ts、kernel/project-store.ts、
            kernel/ws-server.ts、kernel/agent-manager.ts、kernel/workdir-cleaner.ts（新）、
            frontend/Sidebar.tsx、frontend/ProjectItem.tsx、frontend/ProjectList.tsx、
            frontend/NewSessionPane.tsx、frontend/SessionView.tsx
```

## 实施顺序建议（writing-plans 阶段细化）

1. shared 常量 + `resolveSessionCwd` 纯函数 + 单测
2. kernel：`createSystemProject` + `ensureSystemProject` seed + 单测
3. kernel：`agent-manager` pwd 取值切换 + 上传目录辅助函数 + 单测
4. kernel：`ws-server` 删除/改名保护 + `agent:prompt` 创建 `<createdAt>/` 目录 + 会话级"打开工作目录"WS 事件 + 单测
5. kernel：`workdir-cleaner` + 启动集成 + 单测
6. 前端：`ProjectItem` 差异化（图标/项目右键菜单/会话右键菜单/打开工作目录）+ 组件测试
7. 前端：`Sidebar` 新增"默认"独立区 + `ProjectList` 过滤系统项目 + 组件测试
8. 前端：`NewSessionPane` 下拉显示 + 默认选中 + 组件测试
9. 前端：`SessionView` header 友好文案 + 组件测试
10. 第三层：WS 集成测试
11. 第四层：E2E 测试 + 截图清理
12. CHANGELOG + 提交
