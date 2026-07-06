# Task 6 Report: ProjectStore（读写 projects.json）

## 状态
✅ 完成 — TDD 全流程通过，`bun test packages/kernel/tests/project-store.test.ts` → **5 passed / 0 fail**。

## Commit
- **hash:** `cd4494e`
- **message:** `feat(kernel): ProjectStore 读写 projects.json（项目+会话 CRUD）`
- **branch:** `master`（沿用前 5 个 Task 的提交约定，直接在 master 提交）

## 交付物
- `packages/kernel/src/project-store.ts`（新增，ProjectStore 类）
- `packages/kernel/tests/project-store.test.ts`（新增，5 个测试）

## 测试摘要
```
(pass) load 空状态返回空数组
(pass) createProject 持久化
(pass) createSession 归属项目
(pass) deleteProject 级联删 session
(pass) updateProject 改名
 5 pass / 0 fail / 10 expect() calls
```
- 全 kernel 套件回归：`bun test packages/kernel/` → **14 pass / 0 fail**（agent-md + config-store + project-store）。
- `tsc --noEmit`（typecheck）→ exit 0。
- 测试运行后无残留临时文件（每次 `rmSync` 正常清理）。

## 实现要点
- `ProjectStore` 构造函数默认 `filePath = PROJECTS_FILE`（@hiagent/shared 导出），测试用临时文件注入。
- `load()`：`readFile` + `JSON.parse`，失败（文件不存在/损坏）返回空状态；对 `projects`/`sessions` 字段做 `?? []` 兜底。
- `save()`：`mkdir(dirname, {recursive:true})` + `writeFile`（2 空格缩进 JSON）。
- `id` 用 `crypto.randomUUID()`（node:crypto），时间戳 `Date.now()`。
- `deleteProject` 级联：同时过滤 `projects`（按 id）和 `sessions`（按 projectId）。
- `createSession` 初始化 `createdAt === lastActivity`。
- `touchSession` 仅当 session 存在时更新 `lastActivity`（不抛错）。
- `renameSession`/`updateProject` 在找不到目标时抛错（`项目不存在` / `会话不存在`）。

## ⚠️ Concerns（关键发现）

### 1. Brief 的实现源码存在共享可变状态 Bug —— 已修复
brief 第 97 行 `const EMPTY: ProjectsFile = { projects: [], sessions: [] };` 是模块级常量，
`load()` 失败分支 `catch { return { ...EMPTY }; }` 用的是**浅拷贝**——`data.projects` 与
`data.sessions` 指向**同一个共享数组引用**。

后果：每个 `ProjectStore` 实例在文件不存在时 `load()` 返回的对象，其 `projects`/`sessions`
都引用同一个 `EMPTY.projects` 数组。`createProject`/`createSession` 的 `push` 会**跨实例、跨测试**
累积数据到这个共享数组，导致后一个测试读到前一个测试写入的项目。

**症状**（首次跑 5 passed 期望、实得 3 pass / 2 fail）：
- `deleteProject 级联删 session` 期望 `projects=[]`，实际收到 `[项目A, P]`（项目A 来自另一个测试）。
- `updateProject 改名` 期望 `name="新"`，实际收到 `"项目A"`。
- 排查证据：隔离运行单个测试全 pass；失败测试遗留的临时文件里出现**完全相同的 UUID 和纳秒级时间戳**
  （如 `fb3bffb3-...` / `createdAt: 1783348944056`），证明是状态共享而非并发竞态。

**修复**：把模块级 `EMPTY` 常量改为工厂函数 `function empty(): ProjectsFile { return { projects: [], sessions: [] }; }`，
每次返回**全新对象 + 全新数组**。修复后 brief 的 5 个测试逐字运行即可全 pass，无需改测试、无需 `describe.serial`。

> 排查时一度怀疑过 Bun worker 的 `Math.random`/`randomUUID` 跨线程种子相同，或单文件测试并发竞态。
> 已逐一排除：`Math.random` 5 次取值唯一、`randomBytes` 路径唯一、Bun 在单文件内**串行**跑测试
> （50ms await 测试先于后序测试完成）。根因确认为上述共享可变状态。

### 2. 其余说明
- brief 测试源码逐字采用，未做任何改动（最终提交的 `tempFile()` 即 brief 原版的 `Math.random`）。
- 实现源码与 brief **唯一差异**：`EMPTY` 常量 → `empty()` 工厂函数（功能性 bug 修复，API 与行为不变）。
- Windows + Git Bash 下 `bun test` 正常；git 提交有 LF→CRLF 换行符警告（无害）。
- 未发现其他问题。
