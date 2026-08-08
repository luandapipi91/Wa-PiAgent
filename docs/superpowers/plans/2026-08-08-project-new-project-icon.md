# 「新建项目」入口改为标题行右侧 + 图标 — 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将「新建项目」入口从侧边栏列表底部文字按钮，改为「项目」分组标题行右侧的 + 图标按钮；无用户项目时保持现状（底部文字按钮显示、标题行不显示）。

**架构：** 仅改动 `ProjectList.tsx` 一个业务组件。标题行（`userProjects.length > 0` 时渲染）由 `<div>` 改为 flex 容器，左侧标题文字、右侧 + 图标按钮（复用项目已有的 `Icon` 组件 `plus` 图标）；底部文字按钮加 `userProjects.length === 0` 条件后才渲染。两个按钮共用 `data-testid="new-project-btn"`（同一入口两种形态，不同时出现）。i18n 新增 `newProjectHint` 文案用于图标按钮的 `title`/`aria-label`。

**技术栈：** React 19 + Tailwind CSS utility + zustand + bun:test + @testing-library/react（happy-dom）。测试环境语言锁定 `WA_PI_LANG=zh`（.env.test）。

---

## 文件结构

- 修改：`packages/frontend/src/components/ProjectList.tsx` — 标题行加 + 图标按钮、底部按钮加条件、import Icon
- 修改：`packages/frontend/src/i18n/locales/zh.ts` — `projectList` 新增 `newProjectHint: "新建项目"`
- 修改：`packages/frontend/src/i18n/locales/en.ts` — `projectList` 新增 `newProjectHint: "New project"`
- 修改：`packages/frontend/tests/ProjectList.test.tsx` — 新增有项目场景测试、强化无项目场景断言

**测试运行命令**（在 `packages/frontend` 下）：

```bash
bun --env-file=.env.test test tests/ProjectList.test.tsx
# 全量：
bun --env-file=.env.test test
```

**提交纪律：** 当前工作区有其他未提交改动（NewSessionPane、agent-manager、ws-server 等），与本计划无关。每个 commit 只 `git add` 本计划涉及的文件，绝不用 `git add -A`。

---

## 任务 1：i18n 新增图标提示文案

**文件：**

- 修改：`packages/frontend/src/i18n/locales/zh.ts:446`
- 修改：`packages/frontend/src/i18n/locales/en.ts:446`

- [ ] **步骤 1：zh.ts 新增文案**

把第 446 行：

```ts
projectList: {
 sectionTitle: "项目", newProject: "＋ 新建项目",
 systemProjectName: "默认工作区",
},
```

改为：

```ts
projectList: {
 sectionTitle: "项目", newProject: "＋ 新建项目", newProjectHint: "新建项目",
 systemProjectName: "默认工作区",
},
```

- [ ] **步骤 2：en.ts 新增文案**

把第 446 行：

```ts
projectList: {
 sectionTitle: "Projects", newProject: "＋ New project",
 systemProjectName: "Default workspace",
},
```

改为：

```ts
projectList: {
 sectionTitle: "Projects", newProject: "＋ New project", newProjectHint: "New project",
 systemProjectName: "Default workspace",
},
```

- [ ] **步骤 3：运行 ProjectList 现有测试确认未破坏**

运行：`bun --env-file=.env.test test tests/ProjectList.test.tsx`
预期：13 pass, 1 skip, 0 fail（与改动前一致）

- [ ] **步骤 4：Commit**

```bash
git add packages/frontend/src/i18n/locales/zh.ts packages/frontend/src/i18n/locales/en.ts
git commit -m "i18n: 新增 projectList.newProjectHint 文案（+ 图标按钮提示）"
```

---

## 任务 2：有项目时标题行右侧 + 图标，隐藏底部按钮（TDD）

**文件：**

- 修改：`packages/frontend/src/components/ProjectList.tsx`
- 修改：`packages/frontend/tests/ProjectList.test.tsx`

- [ ] **步骤 1：编写失败的测试**

在 `tests/ProjectList.test.tsx` 中、"新建项目按钮"测试之后追加：

```tsx
test("有用户项目时：新建入口为标题行右侧 + 图标，底部文字按钮隐藏", () => {
 useProjectsStore.setState({
  projects: [{ id: "p1", name: "项目A", cwd: "/a", createdAt: 0 }],
  sessions: [],
  currentProjectId: null,
  currentSessionId: null,
 });
 const fn = mock();
 render(
  <ProjectList
   onSelectSession={() => {}}
   onNewSessionInProject={() => {}}
   onSelectProject={() => {}}
   onNewProject={fn}
  />,
 );
 // + 图标按钮存在（与底部文字按钮共用 new-project-btn，但此时文字按钮不渲染）
 const iconBtn = screen.getByTestId("new-project-btn");
 expect(iconBtn).toBeTruthy();
 // 底部文字按钮不显示
 expect(screen.queryByText("＋ 新建项目")).toBeNull();
 // 点击 + 图标触发 onNewProject
 fireEvent.click(iconBtn);
 expect(fn).toHaveBeenCalledTimes(1);
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`bun --env-file=.env.test test tests/ProjectList.test.tsx`
预期：新增用例 FAIL —— 断言 `queryByText("＋ 新建项目")` 为 null 时实际拿到底部文字按钮（当前代码底部按钮始终渲染）。失败原因是功能缺失，不是拼写错误。

- [ ] **步骤 3：实现最少代码**

修改 `src/components/ProjectList.tsx`：

1. 顶部 import 增加 Icon：

```tsx
import { Icon } from "./ui/Icon";
```

1. 标题行（第 37-38 行）改为 flex 容器，右侧 + 图标按钮：

```tsx
{userProjects.length > 0 && (
 <div className="flex items-center justify-between text-[calc(11px*var(--font-scale))] font-bold text-tertiary px-2 py-1 border-t border-dashed border-hairline mt-2 uppercase tracking-wide">
  <span>{t("projectList.sectionTitle")}</span>
  <button
   onClick={props.onNewProject}
   title={t("projectList.newProjectHint")}
   aria-label={t("projectList.newProjectHint")}
   data-testid="new-project-btn"
   className="p-0.5 text-tertiary transition-colors hover:text-brand"
  >
   <Icon name="plus" size={14} />
  </button>
 </div>
)}
```

1. 底部按钮（第 47-53 行）加条件 `userProjects.length === 0`：

```tsx
{userProjects.length === 0 && (
 <button
  onClick={props.onNewProject}
  className="w-full text-left px-2 py-1.5 text-xs text-tertiary transition-colors hover:text-brand"
  data-testid="new-project-btn"
 >{t("projectList.newProject")}</button>
)}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`bun --env-file=.env.test test tests/ProjectList.test.tsx`
预期：14 pass, 1 skip, 0 fail。新增用例通过，其余用例（含"新建项目按钮"无项目场景）不受影响。

- [ ] **步骤 5：Commit**

```bash
git add packages/frontend/src/components/ProjectList.tsx packages/frontend/tests/ProjectList.test.tsx
git commit -m "feat: 新建项目入口移至项目标题行右侧 + 图标，无项目时保留底部按钮"
```

---

## 任务 3：无项目场景回归强化 + 全量验证

**文件：**

- 修改：`packages/frontend/tests/ProjectList.test.tsx`

- [ ] **步骤 1：强化现有「新建项目按钮」测试**

现有"新建项目按钮"测试（`projects: []` 场景）在 `fireEvent.click` 前追加两行断言，锁定无项目时标题行不渲染：

```tsx
 render(
  <ProjectList
   onSelectSession={() => {}}
   onNewSessionInProject={() => {}}
   onSelectProject={() => {}}
   onNewProject={fn}
  />,
 );
 // 无用户项目时不显示「项目」标题行，底部文字按钮是唯一新建入口
 expect(screen.queryByText("项目")).toBeNull();
 expect(screen.getByTestId("new-project-btn")).toBeTruthy();
 fireEvent.click(screen.getByTestId("new-project-btn"));
 expect(fn).toHaveBeenCalledTimes(1);
```

注：`queryByText("项目")` 匹配标题文字；无项目时标题行不渲染，返回 null。该断言当前代码已通过（回归保护，非红绿循环）。

- [ ] **步骤 2：运行全量 frontend 测试确认无回归**

运行：`bun --env-file=.env.test test`
预期：全量通过，0 fail。重点确认 ProjectList.test.tsx 14 pass + 其他文件无回归。

- [ ] **步骤 3：Commit**

```bash
git add packages/frontend/tests/ProjectList.test.tsx
git commit -m "test: 强化无项目场景断言（标题行不渲染、底部按钮为唯一入口）"
```

---

## 自检记录

- **规格覆盖度：** 设计要点全覆盖 —— 有项目时标题行 + 图标（任务 2）、无项目时底部按钮保持（任务 2 条件 + 任务 3 回归）、icon 复用现有 `Icon` 组件（无需改动 Icon.tsx）、hover 变 brand + title/aria-label 提示（任务 2 实现）。
- **占位符扫描：** 无 TODO/待定，每步含可运行代码与明确预期。
- **类型一致性：** 使用现有 API `Icon name="plus" size={14}`、`t("projectList.newProjectHint")`、`data-testid="new-project-btn"`，与现有代码风格一致。
- **Non-Goals 确认：** 不改 Icon.tsx、不改 createProjectFromDir 调用链、不做 tooltip 浮层（原生 title）、不改 App.tsx/Sidebar.tsx（props 已透传 onNewProject）。
