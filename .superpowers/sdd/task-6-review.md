# Task 6 Review: ProjectStore

**Reviewer:** ZCode (task reviewer)
**Date:** 2026-07-06
**Commit reviewed:** `cd4494e` (base `6d8aeba`)
**Files:** `packages/kernel/src/project-store.ts` (+94), `packages/kernel/tests/project-store.test.ts` (+61)

---

## 判定摘要

| 维度 | 结论 |
|---|---|
| **Spec 合规** | ✅ PASS |
| **代码质量** | ✅ PASS |
| **Bug 修复有效性** | ✅ 已独立复现验证 —— 真实有效且必要 |
| **是否需修复** | ❌ 无需修复，可直接合入 |

---

## 一、Spec 合规

### 1. 八方法签名一致性 —— ✅ 全部匹配

逐方法对比 brief 第 10 行的接口约定与实现源码：

| 方法 | brief 签名 | 实现 | 一致 |
|---|---|---|---|
| `load()` | `Promise<{projects, sessions}>` | `Promise<ProjectsFile>`（同构） | ✅ |
| `createProject({name, cwd})` | `Promise<ProjectEntity>` | ✅ | ✅ |
| `updateProject(id, patch)` | `Promise<void>` | ✅ | ✅ |
| `deleteProject(id)` | `Promise<void>` | ✅ | ✅ |
| `createSession({projectId, primaryAgent, title})` | `Promise<SessionEntity>` | ✅ | ✅ |
| `renameSession(id, title)` | `Promise<void>` | ✅ | ✅ |
| `deleteSession(id)` | `Promise<void>` | ✅ | ✅ |
| `touchSession(id)` | `Promise<void>` | ✅ | ✅ |
| `constructor(filePath?)` | 默认 `PROJECTS_FILE` | `constructor(private filePath: string = PROJECTS_FILE)` | ✅ |

- `id` 全部用 `crypto.randomUUID()`（`node:crypto`），`createdAt`/`lastActivity` 用 `Date.now()` —— 符合 brief 第 11 行。
- 消费的共享符号 `PROJECTS_FILE` / `ProjectEntity` / `SessionEntity` / `AgentName` 均确认从 `@hiagent/shared` 导出（`packages/shared/src/constants.ts:8`、`types.ts:30/37/3`）。
- 字段契约对齐：`ProjectEntity{id,name,cwd,createdAt}`、`SessionEntity{id,projectId,primaryAgent,title,createdAt,lastActivity}` 与 shared 定义逐字段吻合。

### 2. 测试实跑结果 —— ✅ 独立复跑确认

- `bun test packages/kernel/tests/project-store.test.ts` → **5 pass / 0 fail / 10 expect()**。
- 全 kernel 套件 `bun test packages/kernel/` → **14 pass / 0 fail / 26 expect()**（agent-md 5 + config-store 4 + project-store 5）。
- 实跑输出与报告 §测试摘要 的数字完全一致。

### 3. deleteProject 级联 —— ✅

`project-store.ts:53-58`：`data.projects.filter(p => p.id !== id)` + `data.sessions.filter(s => s.projectId !== id)`，按 id 删项目、按 projectId 删其下属 session。测试用例「deleteProject 级联删 session」断言两个数组均 `toEqual([])` 实跑通过。

---

## 二、代码质量（含 bug 修复核实）

### 1. ★ 核心核实：EMPTY→工厂函数 bug 修复是否真实有效

**结论：修复真实、必要、且为最小化改动。已独立复现验证。**

**修复内容（diff 第 29-31 行 vs brief 第 97 行）：**
```typescript
// brief 原版（有 bug）
const EMPTY: ProjectsFile = { projects: [], sessions: [] };
// catch 分支：return { ...EMPTY };  ← 浅拷贝，内层数组共享引用

// 修复版（cd4494e）
function empty(): ProjectsFile { return { projects: [], sessions: [] }; }
// catch 分支：return empty();       ← 每次全新对象 + 全新数组
```

**根因分析正确：** `EMPTY` 是模块级常量，`{ ...EMPTY }` 仅做顶层对象浅拷贝，`projects`/`sessions` 仍是 `EMPTY.projects`/`EMPTY.sessions` 这两个**同一份共享数组**。文件不存在时（首个写入前），各实例的 `load()` catch 分支返回的对象都指向这同一对数组；`createProject`/`createSession` 的 `push` 把数据累积到共享数组，跨实例/跨测试串污。

**独立复现（我亲手做的验证，非采信报告）：**
1. 备份当前修复版源码。
2. 把源码临时改回 brief 原版（`const EMPTY` + `return { ...EMPTY }`）。
3. 运行 **未改任何一行** 的测试文件 → 实得 **3 pass / 2 fail**，两个失败：
   - 「deleteProject 级联删 session」期望 `[]`，实得 `[项目A, P]`（项目A 来自前一个测试）。
   - 「updateProject 改名」期望 `"新"`，实得 `"项目A"`。
   - 失败堆栈、`项目A` 串污症状与报告 §Concerns.1 描述**逐字吻合**。
4. 还原修复版 → 重新 5 pass；`git diff HEAD` 无差异，工作树干净（并清理了失败遗留的临时文件）。

→ 这**确证** brief 原版会产生 3 pass/2 fail，修复后才 5 pass。修复有效且必要。

### 2. 偏离 brief 是否合理 —— ✅ 合理

- 偏离**仅此一处**（EMPTY→工厂），是修一个会让 brief 自家测试失败的**功能性 bug**。
- API 与对外行为完全不变（构造、返回类型、异常都一致），不引入新依赖。
- 属于「让 brief 给定的测试真正能 pass」的最小修复，没有擅自改测试去迁就坏实现 —— 这是正确的 TDD 修复方向（改实现不改测试）。
- 报告对偏离有完整记录（§Concerns.1 + §2），透明度达标。

### 3. 测试源码是否未改 —— ✅ 未改

逐行比对 brief 第 16-77 行与提交的测试文件，**完全一致**：
- `tempFile()` 仍用 `Math.random().toString(36).slice(2)`（非 randomBytes/randomUUID）。
- 5 个测试用例、断言、`rmSync(f, { force: true })` 清理、中文断言串全部逐字相同。
- 实现者未通过改测试、加 `.serial`、改 `tempFile` 等方式绕过 bug —— bug 确实是改实现修好的。

### 4. randomUUID 用对 —— ✅

`import { randomUUID } from "node:crypto"`（第 3 行），`createProject`（第 36 行）与 `createSession`（第 65 行）两处 `id: randomUUID()`，符合 brief 第 11 行「id 用 crypto.randomUUID()」。

### 5. 不存在时抛错 —— ✅ 合理

- `updateProject`（第 47 行）：`if (!p) throw new Error("项目不存在: ${id}")`。
- `renameSession`（第 78 行）：`if (!s) throw new Error("会话不存在: ${id}")`。
- 对比 `touchSession`（第 92 行）刻意**不抛错**（`if (s) {...}`）—— 与 brief 行为一致；语义合理：update/rename 操作必须能定位到目标，touch 只是「顺便刷新时间戳，不存在则空操作」。
- 异常为 `Error` 子类、带 id 信息，便于上层捕获与定位，没有静默吞错。

### 6. 其他质量点

- `load()` 成功分支对缺失字段做 `data.projects ?? []` / `data.sessions ?? []` 兜底（第 23 行），健壮处理半空文件。
- `save()` 先 `mkdir(dirname, {recursive:true})` 再写，避免父目录缺失。
- `createSession` 初始化 `createdAt === lastActivity`（第 66-68 行），语义正确。
- 2 空格缩进 JSON（`JSON.stringify(data, null, 2)`），可读持久化。
- 类型严格：`Partial<Pick<ProjectEntity, "name" | "cwd">>` 精确约束 patch 可改字段，无 `any`。
- `tsc --noEmit` exit 0（报告声明，未独立跑；测试通过即间接证明类型 OK）。

---

## 三、是否需修复

**无需修复。** 全部 spec 项通过、测试独立复跑 5 pass + 套件 14 pass、bug 修复经独立复现确认有效、测试源码未改、实现偏离 brief 仅一处且为正当 bug 修复。

---

## 四、Bug 修复有效性确认（重点结论）

> **确认：实现者发现的「EMPTY 浅拷贝共享数组」bug 真实存在，工厂函数修复正确有效。**
>
> 证据链：
> 1. **diff 证据** —— `EMPTY` 常量 → `empty()` 工厂函数（diff 第 29-31 行），catch 分支 `return { ...EMPTY }` → `return empty()`。
> 2. **测试未改证据** —— 提交的测试文件与 brief 逐字一致（含 `Math.random` 的 `tempFile`、5 个用例）。
> 3. **独立复现证据** —— 我临时把源码还原成 brief 原版、跑**同一份未改测试**，复现 **3 pass / 2 fail**，失败症状（`[项目A, P]` / `name="项目A"`）与报告描述逐字吻合；还原修复版后恢复 5 pass。
>
> 因此实现者「brief 会 3pass/2fail，修复后才 5pass」的判断**属实**，该偏离 brief 合理、必要、最小化，应予接受。
