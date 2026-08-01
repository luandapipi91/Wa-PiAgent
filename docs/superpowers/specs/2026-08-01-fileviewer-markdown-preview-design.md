# 设计：FileViewer 支持 Markdown 渲染预览

**日期**：2026-08-01
**状态**：Approved
**作者**：产品经理 Alex
**相关文件**：`packages/frontend/src/components/blocks/FileViewer.tsx`

---

## 1. 问题陈述

用户打开 `.md` 文件（如 `docs/research/pi-install-verify.md`）的预览时，`FileViewer` 对所有文本文件统一走 Prism 语法高亮分支（`guessLanguage(".md") === "markdown"`），展示的是带 `#`、`**`、`-` 标记的**原始 markdown 源码**，而不是渲染后的文档。

文件内容已完整读取到前端（`readFile` → base64 → `decodeBase64`），只是展示层没有调用 `ReactMarkdown` 渲染。

**证据**：
- `FileViewer.tsx` 中 `language === "markdown"` 走 `<Highlight>` 分支，无 markdown 渲染逻辑
- 项目聊天区已有成熟 markdown 渲染能力（`markdown-components.tsx` 的 `createMarkdownComponents`，依赖 `react-markdown@^10`、`remark-gfm@^4` 齐备）

## 2. 目标与验收标准

| 目标 | 验收标准 |
|---|---|
| `.md` 文件预览渲染为 markdown 文档 | 打开含标题/表格/代码块的 md 文件，预览 Modal 内渲染出对应 DOM（`h1`、`table`、`pre`），不出现 Prism 行号容器 |
| 完整复用聊天区渲染能力 | mermaid 代码块渲染为图表、内联路径渲染为文件胶囊（复用 `createMarkdownComponents`） |
| 非 md 文件行为不变 | `.ts`/`.json` 等仍走 Prism 高亮，现有测试用例保持通过 |

## 3. Non-Goals（不做的事）

- 不保留"渲染 / 原始源码"切换（用户已确认只要渲染视图）
- 不改 kernel 数据流（`/api/fs/read-file` 对 `.md` 已返回 `text/markdown`）
- 不做大 md 文件的虚拟滚动 / 性能优化（kernel 已有 3MB 上限，一次性渲染可接受）
- 不改 `ExplorerPanel`、`Modal`、`CodeBlockCard`、`MermaidBlock`

## 4. 方案

**已选方案 A：FileViewer 内部加 md 渲染分支**（用户确认；备选 B 独立组件、C 服务端渲染 HTML 均被否）。

### 4.1 改动文件

| 文件 | 改动 |
|---|---|
| `packages/frontend/src/components/blocks/FileViewer.tsx` | 核心：加 `sessionId?: string` prop + md 渲染分支 |
| `packages/frontend/src/components/SessionView.tsx` | `<FileViewer path={previewPath} sessionId={sessionId} …/>` 透传 |
| `packages/frontend/src/components/blocks/FilePill.tsx` | `<FileViewer path={abs} sessionId={sessionId} …/>` 透传 |
| `packages/frontend/tests/FileViewer.test.tsx` | 新增 md 渲染用例（TDD 先写红） |
| `CHANGELOG.md` | 记录变更 |

### 4.2 核心逻辑

```tsx
const isMarkdown = extOf(path) === "md";

// 渲染分支（在 loading/error/unsupported/image 判断之后）：
if (isMarkdown && content !== null) {
  return (
    <div className="flex flex-col h-full" data-testid="file-viewer">
      {/* 顶部标题栏、底部路径栏保持不变 */}
      <div ref={bodyRef} className="flex-1 overflow-auto bg-canvas">
        <div className="prose prose-sm max-w-none" data-testid="text-block">
          <ReactMarkdown remarkPlugins={[remarkGfm]}
            components={createMarkdownComponents(sessionId ?? "")}>
            {content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
```

- 判断条件用 `extOf(path) === "md"`（与现有 `guessLanguage` 的 md→markdown 映射一致，更直接）
- 容器复用聊天区 `MarkdownBlock` 的 `prose prose-sm max-w-none` + `data-testid="text-block"`，styles.css 现有样式直接生效
- md 分支**不注册** `@path:行号` copy 拦截（该拦截查 `[data-line]`，md 渲染 DOM 无此元素；明确跳过避免无谓注册——在 `useEffect` 条件上加 `isMarkdown` 守卫）

### 4.3 sessionId 传递链

- `FilePill.tsx` 已有 `sessionId` prop → 直接透传
- `SessionView.tsx` 已有 `sessionId` prop（`interface Props { sessionId: string }`）→ 直接透传
- `FileViewer` 的 `sessionId` 为可选 prop（`sessionId ?? ""`），缺省时 `createMarkdownComponents("")` 仍可用（FilePill 内 `resolveSessionCwd("")` 返回 null → 内联路径回退纯文本 code，优雅降级）

## 5. 风险与对策

| 风险 | 可能性 | 影响 | 对策 |
|---|---|---|---|
| 循环依赖：`FileViewer → markdown-components → FilePill → FileViewer` | 高（必然引入） | 中 | ESM 函数声明提升 + 组件引用运行时才访问，Vite/Rollup/Bun 可处理。typecheck + 组件测试 + E2E 验证。若构建报错，兜底：FilePill 对 FileViewer 的 import 改 `React.lazy` 动态导入 |
| 现有测试锁定 Prism 行为（若有用 md 文件断言高亮的用例） | 中 | 低 | TDD 红阶段暴露，按新行为更新用例 |

## 6. 测试计划（4 层）

### L2 组件测试（核心，TDD 红→绿）
`tests/FileViewer.test.tsx` 新增：
- mock `readFile` 返回含标题 / 表格 / 代码块 / mermaid 块 / 形似路径内联 code 的 markdown 文本
- 断言渲染出 `h1`、`table`、`pre` 元素；`data-testid="text-block"` 存在；不出现 Prism 行号容器（`[data-line]`）
- 非 md 文件现有断言不变

### L3 API 测试
检查 kernel `fs.test.ts` 是否已覆盖 `.md → text/markdown`；缺则补 1 条断言。

### L4 E2E
真实浏览器 → 文件树双击 `docs/research/pi-install-verify.md` → 断言预览 Modal 内渲染出表格和标题 → 清理截图。

### L1 单元测试
无新增纯函数（`decodeBase64`/`extOf` 已有），不新增。

## 7. TDD 节奏

1. **红**：先给 `FileViewer.test.tsx` 写 md 渲染用例（断言 h1/table/pre、text-block、无 Prism `[data-line]` 行号容器）→ 运行失败
2. **绿**：实现 FileViewer md 分支 → 用例通过
3. 透传两个调用点的 `sessionId`（SessionView / FilePill）
4. **重构**：确认非 md 现有用例通过、typecheck 通过；处理循环依赖验证
