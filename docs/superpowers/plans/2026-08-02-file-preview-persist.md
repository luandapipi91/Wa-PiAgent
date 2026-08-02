# 文件预览窗不随流式/折叠自动关闭 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复 bug——TDD/子代理流式显示过程中，用户打开的文件预览窗会在流式结束、轮级折叠、组件卸载时被自动关闭。修复后预览窗只由用户手动关闭（✕ / ESC / 遮罩点击）才消失。

**架构：** 根因是预览窗开关状态放在组件本地 `useState`（`FilePill.preview`、`SessionView.previewPath`），宿主组件（DelegateCard 回复区、MessageList 轮级折叠段、消息行）随流式结束/折叠/卸载被 React 销毁 → state 丢失 → 预览窗"自动关闭"。修复方案：把预览状态提升到全局 session store（`filePreview: { path, sessionId } | null` + `openFilePreview` / `closeFilePreview`），并由 App 根常驻组件 `FilePreviewModal` 渲染 Modal + FileViewer。宿主组件卸载与否不再影响预览窗。

**技术栈：** React 19 / zustand / bun:test + @testing-library/react / TypeScript。仓库为 bun workspace monorepo（packages/frontend 为前端）。

**工作区：** 在 worktree `.worktrees/fix-file-preview-persist` 中实现（当前 HEAD = `aa793f4b`）。**注意：** master 工作区有未提交改动（CHANGELOG.md、packages/frontend/tests/store-session.test.ts、packages/shared/src/constants.ts、packages/shared/tests/constants.test.ts），这些文件中的 store-session.test.ts 与本计划无交集，**不要修改 master 工作区的任何文件**；本计划的改动全部在 worktree 内完成。为避免与 master 未提交的 store-session.test.ts 冲突，**不要修改 `packages/frontend/tests/store-session.test.ts`**——store 的 open/close 逻辑测试放在新建的 `tests/FilePreviewModal.test.tsx` 中。

**测试命令：** 在 `packages/frontend` 下运行 `bun test --isolate`（全量，基线 883 pass / 0 fail）；单文件运行 `bun test tests/FilePill.test.tsx tests/FilePreviewModal.test.tsx`。

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `packages/frontend/src/store/session.ts` | 修改 | 加 `filePreview` 状态 + `openFilePreview` / `closeFilePreview` |
| `packages/frontend/src/components/blocks/FilePreviewModal.tsx` | 创建 | 常驻全局预览弹窗，读 store 渲染 Modal + FileViewer |
| `packages/frontend/src/components/blocks/FilePill.tsx` | 修改 | 点击胶囊改为触发 `openFilePreview`，移除本地 preview state 与 Modal 渲染 |
| `packages/frontend/src/App.tsx` | 修改 | 根级渲染 `<FilePreviewModal />` |
| `packages/frontend/src/components/SessionView.tsx` | 修改 | 移除本地 previewPath，Explorer 双击文件改触发 `openFilePreview`，删除内嵌 Modal，清理 import |
| `packages/frontend/tests/FilePill.test.tsx` | 修改 | render 时同时挂 `<FilePreviewModal />`；新增宿主卸载后预览保持的回归测试 |
| `packages/frontend/tests/FilePreviewModal.test.tsx` | 创建 | 空态 / 打开渲染 / ✕、ESC、遮罩关闭 / store 行为 / 宿主卸载保持 |
| `CHANGELOG.md` | 修改（合并阶段由控制者处理） | 记录修复 |

---

### 任务 1：核心实现——预览状态提升到 store + 常驻 FilePreviewModal

**文件：**
- 修改：`packages/frontend/src/store/session.ts`
- 创建：`packages/frontend/src/components/blocks/FilePreviewModal.tsx`
- 修改：`packages/frontend/src/components/blocks/FilePill.tsx`
- 修改：`packages/frontend/src/App.tsx`
- 修改：`packages/frontend/src/components/SessionView.tsx`

- [ ] **步骤 1：session store 增加 filePreview 状态**

在 `packages/frontend/src/store/session.ts` 的 `SessionState` 接口中（`clearSubagentProgress` 声明附近）追加：

```ts
  // 全局文件预览窗（单例）：由 FilePill 胶囊 / Explorer 双击文件触发，渲染在 App 根的
  // FilePreviewModal（常驻挂载点）。状态放 store 而非组件本地——宿主组件（消息行/
  // 委派卡/轮级折叠段）随流式结束、折叠、卸载而销毁时，预览窗不会被连带关闭；
  // 只有用户手动关闭（✕ / ESC / 遮罩点击）才消失。
  filePreview: { path: string; sessionId: string } | null;
  openFilePreview: (path: string, sessionId: string) => void;
  closeFilePreview: () => void;
```

- [ ] **步骤 2：初始化与实现 open/close**

在 store 初始状态对象中（`progressByToolCall: {},` 附近）加初始值：

```ts
  filePreview: null,
```

在 store 方法区（`clearSubagentProgress` 实现之后、`handleSDKEvent` 之前）加实现：

```ts
  // 打开文件预览：path 为绝对路径（FilePill 传 resolveAbsolutePath 结果）或相对项目
  // cwd 的路径（Explorer 双击传 node.entry.path）；sessionId 供 FileViewer 内 readFile
  // 解析 cwd。幂等：同一文件重复打开不产生状态变更。
  openFilePreview: (path, sessionId) => {
    set((s) => {
      if (s.filePreview?.path === path && s.filePreview.sessionId === sessionId) return {};
      return { filePreview: { path, sessionId } };
    });
  },
  closeFilePreview: () => {
    set((s) => (s.filePreview ? { filePreview: null } : {}));
  },
```

在 `clear` 方法中追加 `filePreview: null`（与其它状态一起重置）：

```ts
  clear: () => set({ messagesBySession: {}, streamingBySession: {}, statusBySession: {}, thinkingSinceBySession: {}, optimisticEchoBySession: {}, historyLoadingBySession: {}, unreadBySession: {}, netStatusBySession: {}, filePreview: null }),
```

- [ ] **步骤 3：创建 FilePreviewModal 组件**

创建 `packages/frontend/src/components/blocks/FilePreviewModal.tsx`，内容如下（注意：文件使用项目现有的 2 空格缩进风格——但 store/session.ts 等部分文件已用 tab；本组件参照 blocks/ 目录下 FilePill.tsx 的 2 空格风格）：

```tsx
import { useSessionStore } from "../../store/session";
import { Modal } from "../ui/Modal";
import { FileViewer } from "./FileViewer";

/** 全局文件预览弹窗：渲染在 App 根（常驻挂载点），从 session store 读取 filePreview。
 *  状态提升到 store 而非 FilePill/SessionView 本地 useState——宿主组件（消息行、委派卡、
 *  轮级折叠段）在流式结束/折叠/卸载时销毁，预览窗不会被连带关闭；
 *  只有用户手动关闭（✕ / ESC / 遮罩点击）才消失。 */
export function FilePreviewModal() {
  const preview = useSessionStore((s) => s.filePreview);
  if (!preview) return null;
  const close = () => useSessionStore.getState().closeFilePreview();
  return (
    <Modal onClose={close} width="80vw" height="80vh" data-testid="file-preview-modal">
      <FileViewer path={preview.path} sessionId={preview.sessionId} onClose={close} />
    </Modal>
  );
}
```

- [ ] **步骤 4：FilePill 改为触发 openFilePreview**

修改 `packages/frontend/src/components/blocks/FilePill.tsx`：

1. 删除 import：`import { createPortal } from "react-dom";`、`import { Modal } from "../ui/Modal";`、`import { FileViewer } from "./FileViewer";`
2. 新增 import：`import { useSessionStore } from "../../store/session";`
3. 删除组件内的 `const [preview, setPreview] = useState(false);`（`useState` 保留给 `fileExists`）
4. onClick 改为：`onClick={() => useSessionStore.getState().openFilePreview(abs, sessionId)}`
5. 删除组件末尾的 `{preview && createPortal(<Modal ...>...</Modal>, document.body)}` 整块

修改后组件完整形态（保留原有 stat 探测逻辑）：

```tsx
import { useEffect, useState } from "react";
import { useProjectsStore } from "../../store/projects";
import { useSessionStore } from "../../store/session";
import { parseFilePath } from "./file-path";
import { statFile } from "../../fs-client";

/** 从会话找到项目 cwd（相对路径据此拼绝对路径）。ProjectEntity 的路径字段为 cwd */
export function resolveSessionCwd(sessionId: string): string | null {
  const { sessions, projects } = useProjectsStore.getState();
  const s = sessions.find(x => x.id === sessionId);
  const p = projects.find(x => x.id === s?.projectId);
  return p?.cwd ?? null;
}

/** 正斜杠归一化：把反斜杠全部转为正斜杠，合并连续斜杠 */
function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/");
}

export function resolveAbsolutePath(path: string, sessionId: string): string {
  if (path.startsWith("/") || path.startsWith("~")) return path;
  const cwd = resolveSessionCwd(sessionId);
  if (!cwd) return path;
  return normalizeSlashes(cwd.replace(/\/+$/, "") + "/" + path);
}

/** 文件路径胶囊：stat 探测文件存在性，不存在则回退纯文本。点击触发全局文件预览（FilePreviewModal）。 */
export function FilePill({ rawText, sessionId }: { rawText: string; sessionId: string }) {
  const [fileExists, setFileExists] = useState<boolean | null>(null);

  const parsed = parseFilePath(rawText);

  useEffect(() => {
    if (!parsed) return;
    const abs = resolveAbsolutePath(parsed.path, sessionId);
    let alive = true;
    statFile(abs)
      .then(exists => { if (alive) setFileExists(exists); })
      .catch(() => { if (alive) setFileExists(false); });
    return () => { alive = false; };
  }, [parsed?.path, sessionId]);

  if (!parsed) return <code>{rawText}</code>;
  if (fileExists === false) return <code>{rawText}</code>;

  const abs = resolveAbsolutePath(parsed.path, sessionId);
  const base = parsed.path.split("/").pop();
  return (
    <button
      type="button"
      data-testid="file-pill"
      title={abs}
      onClick={() => useSessionStore.getState().openFilePreview(abs, sessionId)}
      className="inline-flex items-center gap-1 px-1.5 py-0 rounded-md border border-hairline bg-surface-elevated text-[12px] font-mono text-accent hover:border-accent transition-colors align-baseline"
      style={{ cursor: "pointer" }}
    >
      📄 {base}{parsed.line != null ? `:${parsed.line}` : ""}
    </button>
  );
}
```

- [ ] **步骤 5：App 根渲染 FilePreviewModal**

修改 `packages/frontend/src/App.tsx`：

1. import 区加：`import { FilePreviewModal } from "./components/blocks/FilePreviewModal";`
2. 在 `<ToastContainer />` 之前加一行 `<FilePreviewModal />`（即原 331 行 `<ToastContainer />` 前）。

- [ ] **步骤 6：SessionView 移除本地预览并统一走 store**

修改 `packages/frontend/src/components/SessionView.tsx`：

1. 删除 L148 `const [previewPath, setPreviewPath] = useState<string | null>(null);`（注释行也一并删）
2. L316 `onOpenFile={setPreviewPath}` 改为：
   ```tsx
   onOpenFile={(path) => useSessionStore.getState().openFilePreview(path, sessionId)}
   ```
3. 删除文件底部 `{previewPath && (<Modal ...>...</Modal>)}` 整块（原 L322-327）
4. 删除 import：`import { FileViewer } from "./blocks/FileViewer";` 与 `import { Modal } from "./ui/Modal";`（Modal/FileViewer 已无其它使用处；`useState` 仍被 L98 stopping 与 L337 ThinkingTimer 使用，保留）

- [ ] **步骤 7：typecheck 验证**

运行（worktree 的 `packages/frontend` 下）：

```bash
bunx tsc --noEmit
```

预期：无类型错误（若有与改动无关的既有错误，记录即可，不修）。

- [ ] **步骤 8：Commit**

```bash
git add packages/frontend/src/store/session.ts packages/frontend/src/components/blocks/FilePreviewModal.tsx packages/frontend/src/components/blocks/FilePill.tsx packages/frontend/src/App.tsx packages/frontend/src/components/SessionView.tsx
git commit -m "fix(frontend): 文件预览窗状态提升到 store，流式结束/折叠不再自动关闭"
```

---

### 任务 2：测试——更新 FilePill 测试 + 新建 FilePreviewModal 测试

**文件：**
- 修改：`packages/frontend/tests/FilePill.test.tsx`
- 创建：`packages/frontend/tests/FilePreviewModal.test.tsx`

测试基础设施说明：
- 使用 `tests/fs-transport.ts` 的 `makeFakeFsTransport()` + `_setFsTransport` 注入伪 REST 响应（参照现有 `FilePill.test.tsx`）。
- 每个测试文件 `beforeEach` 需重置 `useSessionStore` 的 `filePreview` 为 `null`（`useSessionStore.setState({ filePreview: null })`），避免用例间残留。
- `FilePill.test.tsx` 现有测试将 Modal 渲染断言在 FilePill 内部，改造后 Modal 由 `FilePreviewModal` 渲染，因此**所有点击胶囊后断言 `file-preview-modal` 的测试都要同时 render `<FilePreviewModal />`**。
- 不再断言 `overlay.parentElement === document.body`（那是 FilePill 内部 portal 的旧行为；新组件渲染在 App 根的常驻挂载点，本就不在 opacity 容器内）。

- [ ] **步骤 1：更新 FilePill.test.tsx**

修改 `packages/frontend/tests/FilePill.test.tsx`：

1. import 加 `FilePreviewModal`：
   ```tsx
   import { FilePill, resolveAbsolutePath } from "../src/components/blocks/FilePill";
   import { FilePreviewModal } from "../src/components/blocks/FilePreviewModal";
   ```
2. `beforeEach` 加：`useSessionStore.setState({ filePreview: null });`（需 `import { useSessionStore } from "../src/store/session";`）
3. 测试「渲染胶囊（basename + 行号），点击弹预览并 readFile 解析到项目 cwd」：render 改为：
   ```tsx
   render(
     <>
       <FilePill rawText="src/index.ts:12" sessionId="s1" />
       <FilePreviewModal />
     </>,
   );
   ```
4. 测试「预览 Modal 通过 portal 渲染到 document.body（脱离父容器 opacity 上下文）」整体替换为「预览 Modal 由常驻 FilePreviewModal 渲染」：
   ```tsx
   test("预览 Modal 由常驻 FilePreviewModal 渲染（宿主 FilePill 卸载后仍保持打开）", async () => {
     fake.setResponse("fs:stat", { exists: true });
     fake.setResponse("fs:readFile", { content: btoa("file-content-123"), mimeType: "text/plain" });
     const { unmount } = render(
       <>
         <FilePill rawText="src/index.ts:12" sessionId="s1" />
         <FilePreviewModal />
       </>,
     );
     await waitFor(() => expect(screen.getByTestId("file-pill").textContent).toContain("index.ts"));
     fireEvent.click(screen.getByTestId("file-pill"));
     await waitFor(() => expect(screen.getByTestId("file-preview-modal").textContent).toContain("file-content-123"));
     // 模拟宿主（FilePill 所在消息行/委派卡）随流式结束/折叠卸载
     unmount();
     // 预览窗由常驻 FilePreviewModal 渲染，重新挂载后应仍在（store 状态未丢失）
     render(<FilePreviewModal />);
     await waitFor(() => expect(screen.getByTestId("file-preview-modal").textContent).toContain("file-content-123"));
   });
   ```
5. 新增「用户手动关闭（✕）后预览消失」测试：
   ```tsx
   test("用户手动关闭（✕）后预览消失且 store 清空", async () => {
     fake.setResponse("fs:stat", { exists: true });
     fake.setResponse("fs:readFile", { content: btoa("file-content-123"), mimeType: "text/plain" });
     render(
       <>
         <FilePill rawText="src/index.ts:12" sessionId="s1" />
         <FilePreviewModal />
       </>,
     );
     await waitFor(() => expect(screen.getByTestId("file-pill").textContent).toContain("index.ts"));
     fireEvent.click(screen.getByTestId("file-pill"));
     await waitFor(() => expect(screen.getByTestId("file-preview-modal")).toBeTruthy());
     fireEvent.keyDown(window, { key: "Escape" });
     await waitFor(() => expect(screen.queryByTestId("file-preview-modal")).toBeNull());
     expect(useSessionStore.getState().filePreview).toBeNull();
   });
   ```

- [ ] **步骤 2：创建 FilePreviewModal.test.tsx**

创建 `packages/frontend/tests/FilePreviewModal.test.tsx`，完整内容：

```tsx
// FilePreviewModal 组件测试：全局文件预览弹窗的开关行为。
// 核心回归：预览状态在 store，宿主组件卸载不关闭；只有用户手动关闭（✕/ESC/遮罩）才消失。
import { test, expect, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { FilePreviewModal } from "../src/components/blocks/FilePreviewModal";
import { _setFsTransport } from "../src/fs-client";
import { useSessionStore } from "../src/store/session";
import { makeFakeFsTransport } from "./fs-transport";

const fake = makeFakeFsTransport();

beforeEach(() => {
  useSessionStore.setState({ filePreview: null });
  _setFsTransport(fake.transport);
  fake.calls.length = 0;
  fake.sent.length = 0;
  fake.responses.clear();
});

afterEach(() => cleanup());

test("无 filePreview 时渲染 null（不出现弹窗）", () => {
  const { container } = render(<FilePreviewModal />);
  expect(container.firstChild).toBeNull();
});

test("openFilePreview 后渲染 Modal + FileViewer 内容", async () => {
  fake.setResponse("fs:readFile", { content: btoa("preview-content-abc"), mimeType: "text/plain" });
  useSessionStore.getState().openFilePreview("/work/demo/src/index.ts", "s1");
  render(<FilePreviewModal />);
  await waitFor(() =>
    expect(screen.getByTestId("file-preview-modal").textContent).toContain("preview-content-abc"),
  );
  expect(fake.sent[0]).toMatchObject({ type: "fs:readFile", path: "/work/demo/src/index.ts" });
});

test("openFilePreview 幂等：同文件重复打开不报错且状态不变", () => {
  useSessionStore.getState().openFilePreview("/a.ts", "s1");
  const first = useSessionStore.getState().filePreview;
  useSessionStore.getState().openFilePreview("/a.ts", "s1");
  expect(useSessionStore.getState().filePreview).toEqual(first);
});

test("openFilePreview 切换路径：后打开的文件覆盖前一个", () => {
  useSessionStore.getState().openFilePreview("/a.ts", "s1");
  useSessionStore.getState().openFilePreview("/b.ts", "s1");
  expect(useSessionStore.getState().filePreview?.path).toBe("/b.ts");
});

test("ESC 键关闭预览：modal 消失且 store 清空", async () => {
  fake.setResponse("fs:readFile", { content: btoa("x"), mimeType: "text/plain" });
  useSessionStore.getState().openFilePreview("/a.ts", "s1");
  render(<FilePreviewModal />);
  await waitFor(() => expect(screen.getByTestId("file-preview-modal")).toBeTruthy());
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(screen.queryByTestId("file-preview-modal")).toBeNull());
  expect(useSessionStore.getState().filePreview).toBeNull();
});

test("遮罩点击关闭预览：modal 消失且 store 清空", async () => {
  fake.setResponse("fs:readFile", { content: btoa("x"), mimeType: "text/plain" });
  useSessionStore.getState().openFilePreview("/a.ts", "s1");
  render(<FilePreviewModal />);
  await waitFor(() => expect(screen.getByTestId("file-preview-modal")).toBeTruthy());
  fireEvent.click(screen.getByTestId("modal-overlay"));
  await waitFor(() => expect(screen.queryByTestId("file-preview-modal")).toBeNull());
  expect(useSessionStore.getState().filePreview).toBeNull();
});

test("宿主组件卸载（模拟流式结束/折叠）后预览窗保持打开——核心回归", async () => {
  fake.setResponse("fs:readFile", { content: btoa("keep-open"), mimeType: "text/plain" });
  useSessionStore.getState().openFilePreview("/keep.ts", "s1");
  const { unmount } = render(<FilePreviewModal />);
  await waitFor(() => expect(screen.getByTestId("file-preview-modal").textContent).toContain("keep-open"));
  // 卸载再重挂（等价于宿主树重建）：store 状态仍在 → 预览窗重新出现
  unmount();
  cleanup();
  render(<FilePreviewModal />);
  await waitFor(() => expect(screen.getByTestId("file-preview-modal").textContent).toContain("keep-open"));
});
```

注意：`cleanup()` 会卸载 testing-library 渲染的树；`unmount()` 已卸载，再 `cleanup()` 是为了重置 document.body 中 portal 残留，避免 `getByTestId("file-preview-modal")` 匹配到旧节点。

- [ ] **步骤 3：运行相关测试**

运行（worktree 的 `packages/frontend` 下）：

```bash
bun test tests/FilePill.test.tsx tests/FilePreviewModal.test.tsx
```

预期：全部 PASS。若有失败，检查是否 FileViewer 需要额外 mock（fs:readFile 响应格式参照 FilePill.test.tsx 的 `{ content: btoa(...), mimeType: "text/plain" }`）。

- [ ] **步骤 4：运行全量前端测试确认无回归**

```bash
bun test --isolate
```

预期：883 个基线测试 + 新增测试全部通过，0 fail。

- [ ] **步骤 5：Commit**

```bash
git add packages/frontend/tests/FilePill.test.tsx packages/frontend/tests/FilePreviewModal.test.tsx
git commit -m "test(frontend): FilePill/FilePreviewModal 预览窗持久化测试（宿主卸载不关闭、手动关闭才消失）"
```

---

### 任务 3：CHANGELOG（由控制者在合并阶段处理）

在 master 合并阶段，控制者把以下条目合并进 `CHANGELOG.md`（注意保留 master 工作区未提交的既有条目，两者都保留）：

```markdown
- **修复** 文件预览窗在 TDD/子代理流式显示结束、轮级折叠、组件卸载时被自动关闭的问题：预览状态提升到全局 store，由 App 根常驻 FilePreviewModal 渲染，预览窗只由用户手动关闭（✕/ESC/遮罩）
```

---
