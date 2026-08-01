# FileViewer Markdown 预览渲染实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 `FileViewer` 打开 `.md` 文件时用 `ReactMarkdown` 渲染为文档（完整复用聊天区 `createMarkdownComponents` 能力），替代当前 Prism 原始源码高亮。

**架构：** `FileViewer` 增加可选 `sessionId` prop；当 `extOf(path) === "md"` 时，把已解码内容交给 `<ReactMarkdown remarkPlugins={[remarkGfm]} components={createMarkdownComponents(sessionId ?? "")}>`，容器复用聊天区 `prose prose-sm max-w-none` + `data-testid="text-block"`。两个调用点（`SessionView` / `FilePill`）透传 `sessionId`。kernel 数据流不动。

**技术栈：** React 19、react-markdown@10、remark-gfm@4、prism-react-renderer（仅非 md 分支）、bun:test + @testing-library/react（组件测试）、Playwright（E2E）。

**规格：** `docs/superpowers/specs/2026-08-01-fileviewer-markdown-preview-design.md`

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `packages/frontend/src/components/blocks/FileViewer.tsx` | 文件预览器：加 `sessionId?` prop、md 渲染分支、copy 拦截守卫 | 修改 |
| `packages/frontend/src/components/blocks/FilePill.tsx` | 文件胶囊：透传 `sessionId` 给 FileViewer | 修改 |
| `packages/frontend/src/components/SessionView.tsx` | 会话主视图：透传 `sessionId` 给 FileViewer | 修改 |
| `packages/frontend/tests/FileViewer.test.tsx` | FileViewer 组件测试：新增 md 渲染用例 | 修改 |
| `packages/kernel/tests/static-serve.test.ts` | getMimeType 单测：补 `.md → text/markdown` 断言（L3） | 修改 |
| `packages/frontend/e2e/global-setup.ts` | E2E 预置：在 e2e-project 写 `PREVIEW.md` | 修改 |
| `packages/frontend/e2e/explorer.spec.ts` | E2E：双击 PREVIEW.md 断言 markdown 渲染 | 修改 |
| `CHANGELOG.md` | 变更记录 | 修改 |

---

### 任务 1：FileViewer md 渲染分支（TDD 红 → 绿）

**文件：**
- 修改：`packages/frontend/src/components/blocks/FileViewer.tsx`
- 测试：`packages/frontend/tests/FileViewer.test.tsx`

- [ ] **步骤 1：编写失败的测试**

在 `packages/frontend/tests/FileViewer.test.tsx` 末尾追加两个测试：

```tsx
// ===== md 预览渲染 =====

const MD_SAMPLE = `# Preview Title

| ColA | ColB |
|------|------|
| 1    | 2    |

\`\`\`ts
const x = 1;
\`\`\`
`;

test("md 文件：渲染为 markdown（h1/table/pre），不出现 Prism 行号容器", async () => {
  fake.setResponse("fs:readFile", { content: btoa(MD_SAMPLE), mimeType: "text/markdown" });
  render(<FileViewer path="/work/demo/README.md" onClose={() => {}} />);

  await waitFor(() => expect(screen.getByTestId("text-block")).toBeTruthy());
  const textBlock = screen.getByTestId("text-block");
  expect(textBlock.querySelector("h1")?.textContent).toBe("Preview Title");
  expect(textBlock.querySelector("table")).toBeTruthy();
  expect(textBlock.querySelector("pre")).toBeTruthy();
  // md 渲染不走 FileViewer 的 Prism 分支：不出现行号容器
  expect(screen.getByTestId("file-viewer").querySelector("[data-line]")).toBeNull();
});

test("md 文件：内联路径复用聊天区渲染为文件胶囊", async () => {
  fake.setResponse("fs:readFile", { content: btoa("# T\n\n`docs/a.md`\n"), mimeType: "text/markdown" });
  fake.setResponse("fs:stat", { exists: true });
  render(<FileViewer path="/work/demo/README.md" onClose={() => {}} sessionId="s1" />);

  await waitFor(() => expect(screen.getByTestId("file-pill")).toBeTruthy());
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd packages/frontend && bun test --isolate tests/FileViewer.test.tsx`
预期：新增两个测试 FAIL（第一个：`getByTestId("text-block")` 找不到，因为 md 仍走 Prism 分支；第二个：`getByTestId("file-pill")` 找不到）；其余 5 个既有测试 PASS。

- [ ] **步骤 3：实现最少代码**

修改 `packages/frontend/src/components/blocks/FileViewer.tsx`：

3a. import 区（现有 `import { readFile } from "../../fs-client";` 之后）加：

```tsx
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createMarkdownComponents } from "./markdown-components";
```

3b. props 类型加 `sessionId`：

```tsx
type FileViewerProps = {
  path: string;
  onClose: () => void;
  sessionId?: string;
};
```

3c. 函数签名与标记：

```tsx
export function FileViewer({ path, onClose, sessionId }: FileViewerProps) {
```

在 `const image = isImagePath(path);` 之后加：

```tsx
  const isMarkdown = extOf(path) === "md";
```

3d. copy 拦截守卫（md 分支不注册 `@path:行号` 拦截）。现有 useEffect 开头 `if (content === null) return;` 改为：

```tsx
    if (content === null || isMarkdown) return;
```

依赖数组 `[path, content, resolvedPath]` 改为 `[path, content, resolvedPath, isMarkdown]`。

3e. 渲染分支：在 `if (image && imageSrc)` 分支之后、Prism `return (...)` 之前插入：

```tsx
  if (isMarkdown && content !== null) {
    return (
      <div className="flex flex-col h-full" data-testid="file-viewer">
        <div className="flex items-center gap-1 px-3 py-2 border-b border-hairline bg-surface">
          <span className="text-[12px] text-secondary flex-1 truncate font-mono">📄 {fileName}</span>
          <button className="fv-btn" onClick={onClose} title="关闭">✕</button>
        </div>
        <div ref={bodyRef} className="flex-1 overflow-auto bg-canvas">
          <div className="prose prose-sm max-w-none" data-testid="text-block">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={createMarkdownComponents(sessionId ?? "")}>
              {content}
            </ReactMarkdown>
          </div>
        </div>
        <div className="px-3 py-1 text-[10.5px] text-tertiary border-t border-hairline bg-surface truncate" title={displayPath}>{displayPath}</div>
      </div>
    );
  }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd packages/frontend && bun test --isolate tests/FileViewer.test.tsx`
预期：7 个测试全部 PASS。

- [ ] **步骤 5：typecheck + 验证循环依赖可构建**

运行：`cd packages/frontend && bun run typecheck`
预期：无类型错误。typecheck + 组件测试通过即证明 `FileViewer → markdown-components → FilePill → FileViewer` 循环依赖在运行时与类型层面均可用（组件引用在渲染期才访问）。

- [ ] **步骤 6：Commit**

```bash
git add packages/frontend/tests/FileViewer.test.tsx packages/frontend/src/components/blocks/FileViewer.tsx
git commit -m "feat(frontend): FileViewer 打开 md 文件渲染为 markdown 预览"
```

---

### 任务 2：透传 sessionId（FilePill + SessionView）

**文件：**
- 修改：`packages/frontend/src/components/blocks/FilePill.tsx`
- 修改：`packages/frontend/src/components/SessionView.tsx`

- [ ] **步骤 1：FilePill 透传**

`packages/frontend/src/components/blocks/FilePill.tsx` 中 FileViewer 调用处（`createPortal` 内）改为：

```tsx
<FileViewer path={abs} sessionId={sessionId} onClose={() => setPreview(false)} />
```

- [ ] **步骤 2：SessionView 透传**

`packages/frontend/src/components/SessionView.tsx` 中 FileViewer 调用处（`previewPath &&` 分支）改为：

```tsx
<FileViewer path={previewPath} sessionId={sessionId} onClose={() => setPreviewPath(null)} />
```

- [ ] **步骤 3：typecheck + 相关测试**

运行：`cd packages/frontend && bun run typecheck`
预期：无类型错误。

运行：`cd packages/frontend && bun test --isolate tests/FileViewer.test.tsx tests/FilePill.test.tsx tests/SessionView.test.tsx`
预期：全部 PASS（无回归）。

- [ ] **步骤 4：Commit**

```bash
git add packages/frontend/src/components/blocks/FilePill.tsx packages/frontend/src/components/SessionView.tsx
git commit -m "feat(frontend): FileViewer 调用点透传 sessionId 支持 md 内联文件胶囊"
```

---

### 任务 3：kernel L3 —— 补 `.md → text/markdown` mime 断言

**文件：**
- 修改：`packages/kernel/tests/static-serve.test.ts`

- [ ] **步骤 1：加断言**

在 `packages/kernel/tests/static-serve.test.ts` 的 `getMimeType: 常见类型` 测试内（`a.css` 断言之后）加一行：

```ts
expect(getMimeType("a.md")).toBe("text/markdown");
```

- [ ] **步骤 2：运行测试**

运行：`cd packages/kernel && bun test tests/static-serve.test.ts`
预期：PASS（该断言证明 `.md` 文件通过 `checkPreviewable` 文本校验，kernel 数据流无需改动）。

- [ ] **步骤 3：Commit**

```bash
git add packages/kernel/tests/static-serve.test.ts
git commit -m "test(kernel): 补充 .md mime 类型断言"
```

---

### 任务 4：E2E —— 双击 md 文件断言渲染

**文件：**
- 修改：`packages/frontend/e2e/global-setup.ts`
- 修改：`packages/frontend/e2e/explorer.spec.ts`

- [ ] **步骤 1：global-setup 预置 PREVIEW.md**

`packages/frontend/e2e/global-setup.ts` 中，在 `writeFileSync(join(SEED_PROJECT_CWD, "AGENTS.md"), ...)` 之后加：

```ts
  // 预置 md 预览渲染测试文件（含标题/表格/代码块/mermaid）：explorer.spec.ts 双击断言 markdown 渲染
  writeFileSync(join(SEED_PROJECT_CWD, "PREVIEW.md"),
    ["# E2E 预览测试", "", "| 列A | 列B |", "|-----|-----|", "| 1   | 2   |", "", "```ts", "const y = 2;", "```", "", "```mermaid", "graph TD", "  A --> B", "```", ""].join("\n"),
    "utf8");
```

- [ ] **步骤 2：explorer.spec.ts 新增测试**

在 `packages/frontend/e2e/explorer.spec.ts` 的 `describe.serial` 块内、现有测试之后追加：

```ts
  test("双击 md 文件渲染为 markdown（标题/表格），不显示原始源码", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/");
    await page.waitForTimeout(2000);

    const sessionId = await createSession();
    await page.getByText("E2E项目").first().click();
    await page.getByTestId(`session-${sessionId}`).click();
    await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 8000 });

    await page.getByTestId("btn-explorer").click();
    await expect(page.getByTestId("explorer-aside")).toBeVisible({ timeout: 5000 });

    const fileNode = page.locator('[data-testid="explorer-panel"]').getByText("PREVIEW.md");
    await expect(fileNode).toBeVisible({ timeout: 5000 });
    await fileNode.dblclick();

    await expect(page.getByTestId("file-viewer")).toBeVisible({ timeout: 5000 });
    const textBlock = page.getByTestId("text-block");
    await expect(textBlock).toBeVisible({ timeout: 5000 });
    await expect(textBlock.locator("h1")).toContainText("E2E 预览测试");
    await expect(textBlock.locator("table")).toBeVisible();
    // mermaid 代码块经 createMarkdownComponents 渲染为图表（异步渲染，超时放宽）
    await expect(textBlock.locator('[data-testid="mermaid-svg"]')).toBeVisible({ timeout: 15000 });
    // md 渲染不走 FileViewer 的 Prism 分支：无行号容器
    await expect(page.getByTestId("file-viewer").locator("[data-line]")).toHaveCount(0);
  });
```

- [ ] **步骤 3：运行 E2E**

运行：`cd packages/frontend && bun run e2e e2e/explorer.spec.ts --reporter=line`
预期：`explorer.spec.ts` 两个测试全部 PASS（webServer 自动启动隔离 kernel + dev server；跑完后 global-teardown 清理隔离目录）。若失败先看是否环境残留（重跑一次）。

- [ ] **步骤 4：清理截图并 Commit**

确认 e2e 运行未在仓库内留下截图/产物（Playwright 默认输出在 `test-results/`，已在 .gitignore 则无需处理；若遗留则删除）。然后：

```bash
git add packages/frontend/e2e/global-setup.ts packages/frontend/e2e/explorer.spec.ts
git commit -m "test(e2e): 文件预览双击 md 渲染为 markdown"
```

---

### 任务 5：CHANGELOG 记录

**文件：**
- 修改：`CHANGELOG.md`

- [ ] **步骤 1：在 `CHANGELOG.md` 顶部（时间倒序首条）加一条记录**

```markdown
## 2026-08-01
### 新增功能
- 文件预览器（FileViewer）打开 `.md` 文件时渲染为 markdown 文档（复用聊天区渲染能力：标题/表格/代码块/mermaid/内联文件胶囊），替代原始源码高亮。涉及 `packages/frontend/src/components/blocks/FileViewer.tsx`、`FilePill.tsx`、`SessionView.tsx`。
```

（按仓库既有 CHANGELOG 格式微调，保持简洁一条。）

- [ ] **步骤 2：Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG 记录 FileViewer markdown 预览渲染"
```
