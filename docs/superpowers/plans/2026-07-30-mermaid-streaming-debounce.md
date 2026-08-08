# Mermaid 流式渲染防闪烁优化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 流式输出过程中已渲染的 Mermaid 图保持稳定不闪，code 停止变化 1s 后更新到最新版本。

**Architecture:** 在 `MermaidBlock.tsx` 的 `useEffect([code])` 内套一层 1000ms debounce —— code 变化后延迟 1s 才执行 `mermaid.render()`，流式中 timer 不断重置从而不重画；render 成功后再用 ref 缓存上次 SVG 字符串做 diff，内容相同则不替换 DOM。不动流式数据链路（session.ts / MessageList.tsx / markdown-components.tsx）。

**Tech Stack:** React 19、`mermaid ^11.16.0`、`bun:test` + `@testing-library/react` + `happy-dom`（真实 timer，项目不用 fake timers）。

## Global Constraints

- 测试框架：`bun:test`，通过 `mock.module("mermaid", ...)` mock mermaid 库；用 `mock()` 包裹 spy 函数统计调用次数。**不引入 fake timers**（项目无此先例），节流测试用真实 `setTimeout` + 短等待。
- bun 可执行文件路径：`~/.bun/bin/bun`（不在默认 PATH，命令中用 `~/.bun/bin/bun` 或先 `export PATH="$HOME/.bun/bin:$PATH"`）。
- 成功渲染节流阈值：`RENDER_DEBOUNCE_MS = 1000`（常量，硬编码）。
- 现有错误显示 debounce：`ERROR_DEBOUNCE_MS = 400`（保持不变）。
- 改动范围：仅 `packages/frontend/src/components/blocks/MermaidBlock.tsx` + 对应测试 + `CHANGELOG.md`。
- 所有回复、代码注释、commit message 使用中文。

---

### Task 1: 新增常量与 ref，保留现有行为

**Files:**
- Modify: `packages/frontend/src/components/blocks/MermaidBlock.tsx:10-12`（新增常量）
- Modify: `packages/frontend/src/components/blocks/MermaidBlock.tsx:136-142`（新增 ref）
- Test: `packages/frontend/tests/blocks/MermaidBlock.test.tsx`（现有用例作为回归）

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: `RENDER_DEBOUNCE_MS` 常量、`lastSvgRef` ref（供 Task 2 使用）

本任务仅做准备工作，不改渲染逻辑，确保现有测试全绿。

- [ ] **Step 1: 新增节流常量**

在 `packages/frontend/src/components/blocks/MermaidBlock.tsx` 第 12 行（`ERROR_DEBOUNCE_MS` 之后）新增：

```ts
// 成功渲染节流：流式中 code 每个 token 都变，但稳定的图不应重画。
// code 连续该时长不再变化后才执行 mermaid.render，token 间隔通常远小于此值，
// 故 timer 不断重置、render 不触发，图保持稳定；停顿/回合结束后才渲染最新版本。
const RENDER_DEBOUNCE_MS = 1000;
```

- [ ] **Step 2: 新增 lastSvgRef**

在 `MermaidBlock` 组件内（`containerRef` 声明之后，约第 139 行后）新增 ref：

```ts
// 缓存上次成功渲染的 SVG 字符串，用于 diff：内容相同则不替换 DOM
const lastSvgRef = useRef<string | null>(null);
```

- [ ] **Step 3: 运行现有测试，确认全绿（回归基线）**

Run: `cd packages/frontend && export PATH="$HOME/.bun/bin:$PATH" && bun test tests/blocks/MermaidBlock.test.tsx`
Expected: 所有现有用例 PASS（此时渲染逻辑未变，仍立即 render）。

- [ ] **Step 4: Commit**

```bash
git add packages/frontend/src/components/blocks/MermaidBlock.tsx
git commit -m "refactor(mermaid): 新增 RENDER_DEBOUNCE_MS 常量与 lastSvgRef（暂未启用）"
```

---

### Task 2: 成功渲染节流 + SVG diff（核心改动）

**Files:**
- Modify: `packages/frontend/src/components/blocks/MermaidBlock.tsx:143-182`（`useEffect([code])` 整体重写）
- Test: `packages/frontend/tests/blocks/MermaidBlock.test.tsx`（先更新现有用例的 timeout，再新增节流/diff/卸载用例）

**Interfaces:**
- Consumes: Task 1 的 `RENDER_DEBOUNCE_MS`、`lastSvgRef`
- Produces: 改造后的 `useEffect([code])` —— code 变化后延迟 1s render，成功时 SVG diff，失败时沿用 400ms 错误 debounce

- [ ] **Step 1: 把顶部 mock 改造为带调用计数 + SVG 覆盖的共享 spy**

当前文件第 6-20 行的 `mock.module("mermaid")` 写死了 render 逻辑，所有现有用例依赖它。多个新用例各自再 `mock.module` 会互相覆盖。改为共享 spy：用模块级变量 `renderCalls` 记录调用次数、`fixedSvg` 允许覆盖返回值，`beforeEach` 重置。

打开 `packages/frontend/tests/blocks/MermaidBlock.test.tsx`，把第 1-24 行（import + mock.module + beforeEach）整体替换为：

```tsx
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { MermaidBlock } from "../../src/components/blocks/MermaidBlock";

// 共享 spy：记录 render 调用次数，fixedSvg 可覆盖返回值（供 SVG diff 测试）
let renderCalls = 0;
let fixedSvg: string | null = null;
mock.module("mermaid", () => ({
  default: {
    initialize: () => {},
    render: (_id: string, code: string) => {
      renderCalls++;
      if (!code || code.includes("invalid")) {
        return Promise.reject(new Error("Parse error: invalid mermaid syntax"));
      }
      return Promise.resolve({ svg: fixedSvg ?? `<svg width="100" height="100"><text>${code}</text></svg>` });
    },
  },
}));

beforeEach(() => {
  document.body.innerHTML = "";
  renderCalls = 0;
  fixedSvg = null;
});
```

现有用例逻辑无需改动（happy path 仍返回带 code 的 svg；invalid 仍 reject），全部保持绿。

- [ ] **Step 2: 更新「流式生成中」用例，适配 1000ms 节流**

现有第 46-59 行「流式生成中 code 连续变化」用例原本靠 `await new Promise(r => setTimeout(r, 50))` 等 50ms 后 rerender。节流后首次 render 需等 1000ms，但核心断言（中途失败不闪现错误、稳定后渲染成功）不变。把该用例替换为：

```tsx
test("流式生成中 code 连续变化（中途解析失败）不闪现错误，稳定后渲染成功", async () => {
  // 模拟流式：先传不完整代码，在节流窗口内补全为有效代码
  const { rerender } = render(<MermaidBlock code="graph TD" />);
  // 此时不应显示 error（render 被 1000ms 节流挡住，根本没执行），应为 loading
  expect(screen.queryByTestId("mermaid-error")).toBeNull();
  // 流式补全代码（重置节流 timer）
  rerender(<MermaidBlock code="graph TD\nA-->B" />);
  // 等节流到期后渲染
  const svg = await screen.findByTestId("mermaid-svg", {}, { timeout: 3000 });
  expect(svg).toBeTruthy();
  // 全程不应出现错误
  expect(screen.queryByTestId("mermaid-error")).toBeNull();
});
```

- [ ] **Step 3: 运行全文件，确认现有用例在共享 spy 下仍全绿**

Run: `cd packages/frontend && export PATH="$HOME/.bun/bin:$PATH" && bun test tests/blocks/MermaidBlock.test.tsx`
Expected: 全部现有用例 PASS（共享 spy 行为与原 mock 等价）。

- [ ] **Step 4: 新增「节流生效」用例（先写失败测试）**

在测试文件末尾新增（用模块级 `renderCalls`，无需重复 mock.module）：

```tsx
test("code 连续变化（间隔 <1000ms）时 mermaid.render 不被调用", async () => {
  const { rerender } = render(<MermaidBlock code="graph TD\nA" />);
  // 连续变化，每次间隔远小于 1000ms，不断重置节流 timer
  for (let i = 0; i < 5; i++) {
    rerender(<MermaidBlock code={`graph TD\n${"A".repeat(i + 1)}-->B`} />);
    await new Promise((r) => setTimeout(r, 50)); // 50ms 间隔
  }
  // 此时 timer 仍在 pending，render 从未执行
  expect(renderCalls).toBe(0);
  expect(screen.getByTestId("mermaid-loading")).toBeTruthy();
});
```

- [ ] **Step 5: 运行新用例，确认失败（当前逻辑立即 render，renderCalls >0）**

Run: `cd packages/frontend && export PATH="$HOME/.bun/bin:$PATH" && bun test tests/blocks/MermaidBlock.test.tsx -t "code 连续变化（间隔 <1000ms）"`
Expected: FAIL（renderCalls > 0）。

- [ ] **Step 6: 重写 useEffect，实现节流 + SVG diff**

把 `packages/frontend/src/components/blocks/MermaidBlock.tsx` 第 143-182 行的整个 `useEffect` 替换为：

```ts
  useEffect(() => {
    let cancelled = false;
    let renderTimer: ReturnType<typeof setTimeout> | null = null;
    let errorTimer: ReturnType<typeof setTimeout> | null = null;
    let container: HTMLDivElement | null = null;

    // code 稳定 RENDER_DEBOUNCE_MS 后才 render：流式中 code 每个 token 都变，
    // timer 不断重置 → render 不触发 → 已渲染的图保持稳定不闪。
    renderTimer = setTimeout(() => {
      if (cancelled) return;
      ensureInit();
      const id = `mermaid-${Math.random().toString(36).slice(2, 9)}`;
      container = document.createElement("div");
      container.id = id;
      container.style.display = "none";
      document.body.appendChild(container);

      mermaid
        .render(id, code)
        .then((r) => {
          if (cancelled) return;
          // SVG diff：内容相同则不替换 DOM，避免无谓重画
          if (r.svg !== lastSvgRef.current) {
            lastSvgRef.current = r.svg;
            setSvg(r.svg);
          }
          setError(null);
        })
        .catch((err: any) => {
          if (cancelled) return;
          const msg = err?.message ?? String(err);
          setSvg(null);
          lastSvgRef.current = null;
          // 错误显示 debounce：render 失败后再等 ERROR_DEBOUNCE_MS 才显示
          errorTimer = setTimeout(() => {
            if (!cancelled) setError(msg);
          }, ERROR_DEBOUNCE_MS);
        });
    }, RENDER_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      if (renderTimer) clearTimeout(renderTimer);
      if (errorTimer) clearTimeout(errorTimer);
      if (container) container.remove();
    };
  }, [code]);
```

- [ ] **Step 7: 运行新用例，确认通过**

Run: `cd packages/frontend && export PATH="$HOME/.bun/bin:$PATH" && bun test tests/blocks/MermaidBlock.test.tsx -t "code 连续变化（间隔 <1000ms）"`
Expected: PASS（renderCalls === 0）。

- [ ] **Step 8: 新增「节流到期渲染」用例并验证**

在测试文件末尾新增（用模块级 `renderCalls`，beforeEach 已重置）：

```tsx
test("code 变化后停止变化满 1000ms 才执行 render 并显示 SVG", async () => {
  render(<MermaidBlock code="graph TD\nA-->B" />);
  // 节流期内 render 未执行
  await new Promise((r) => setTimeout(r, 800));
  expect(renderCalls).toBe(0);
  // 等到节流到期（800 + 余量 > 1000）
  await screen.findByTestId("mermaid-svg", {}, { timeout: 2000 });
  expect(renderCalls).toBe(1);
});
```

Run: `cd packages/frontend && export PATH="$HOME/.bun/bin:$PATH" && bun test tests/blocks/MermaidBlock.test.tsx -t "code 变化后停止变化满 1000ms"`
Expected: PASS。

- [ ] **Step 9: 新增「SVG diff 生效」用例并验证**

在测试文件末尾新增（设置模块级 `fixedSvg` 让两次不同 code 返回相同 svg → 第二次 setSvg 不触发，DOM 内容不变）：

```tsx
test("两次 code 生成相同 SVG 时，第二次不替换 DOM", async () => {
  fixedSvg = "<svg width='50'><text>same</text></svg>";

  const { rerender } = render(<MermaidBlock code="graph TD\nA" />);
  await screen.findByTestId("mermaid-svg", {}, { timeout: 3000 });
  const firstHtml = screen.getByTestId("mermaid-svg").innerHTML;
  // 首次 render 调用了 1 次
  expect(renderCalls).toBe(1);

  // 换 code（fixedSvg 仍返回相同 svg），等节流到期
  rerender(<MermaidBlock code="graph TD\nB" />);
  await new Promise((r) => setTimeout(r, 1200));

  // 第二次 render 被调用了，但 SVG diff 命中 → DOM 内容不变
  expect(renderCalls).toBe(2);
  expect(screen.getByTestId("mermaid-svg").innerHTML).toBe(firstHtml);
});
```

Run: `cd packages/frontend && export PATH="$HOME/.bun/bin:$PATH" && bun test tests/blocks/MermaidBlock.test.tsx -t "两次 code 生成相同 SVG"`
Expected: PASS。

- [ ] **Step 10: 新增「卸载无泄漏」用例并验证**

在测试文件末尾新增：

```tsx
test("组件卸载后推进节流 timer 不报错（cleanup 清理 renderTimer）", async () => {
  const { unmount } = render(<MermaidBlock code="graph TD\nA-->B" />);
  // 节流期内卸载
  unmount();
  // 推进到节流到期，cleanup 应已 cancelled=true，不执行 render、不 setState
  await new Promise((r) => setTimeout(r, 1200));
  expect(renderCalls).toBe(0);
});
```

Run: `cd packages/frontend && export PATH="$HOME/.bun/bin:$PATH" && bun test tests/blocks/MermaidBlock.test.tsx -t "组件卸载后推进节流 timer"`
Expected: PASS。

- [ ] **Step 11: 运行完整测试文件，确认全绿**

Run: `cd packages/frontend && export PATH="$HOME/.bun/bin:$PATH" && bun test tests/blocks/MermaidBlock.test.tsx`
Expected: 全部用例 PASS（含现有 modal/缩放/复制用例 + 4 个新增节流用例 + 更新后的流式用例）。

- [ ] **Step 12: 类型检查**

Run: `cd packages/frontend && export PATH="$HOME/.bun/bin:$PATH" && bun run typecheck`
Expected: 无新增类型错误。

- [ ] **Step 13: Commit**

```bash
git add packages/frontend/src/components/blocks/MermaidBlock.tsx packages/frontend/tests/blocks/MermaidBlock.test.tsx
git commit -m "fix(mermaid): 流式渲染防闪烁——1000ms 成功节流 + SVG diff 双保险"
```

---

### Task 3: 更新 CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`（顶部新增条目）

**Interfaces:** 无

- [ ] **Step 1: 在 CHANGELOG.md 顶部（`## 2026-07-30` 下、第一条 `### 修复` 之前）新增条目**

```markdown
- **流式输出时 Mermaid 图不再反复闪烁重画**：根因是 `MermaidBlock` 的 `useEffect([code])` 对成功渲染路径零节流——流式中 mermaid 源码每个 token 都增长，每次都能解析成功就立刻用新 SVG 替换 DOM 重画整张图（仅错误显示有 400ms debounce，成功路径无）。修复：code 变化后延迟 1000ms 才执行 `mermaid.render()`（流式中 token 间隔远小于 1s，timer 不断重置 → render 不触发 → 图稳定）；即便到期渲染，也用 ref 缓存上次成功 SVG，仅在内容真正变化时才替换 DOM。仅改 `MermaidBlock.tsx`，不动流式数据链路。
  - 影响范围：`packages/frontend/src/components/blocks/MermaidBlock.tsx`、`packages/frontend/tests/blocks/MermaidBlock.test.tsx`
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: 更新 CHANGELOG——Mermaid 流式渲染防闪烁"
```

---

### Task 4: E2E 手动验证 + 截图清理

**Files:** 无源码改动（验证性任务）

**Interfaces:** 无

- [ ] **Step 1: 启动前端 dev 服务**

Run: `cd /path/to/HiAgent && export PATH="$HOME/.bun/bin:$PATH" && bun run dev:frontend`
Expected: Vite dev server 起来，可访问前端页面。

- [ ] **Step 2: 发一条会生成 Mermaid 图的消息，观察流式过程**

在对话中发送类似「画一个用户登录流程的 mermaid 流程图」的提示。观察流式输出过程中：
- 已渲染的 Mermaid 图保持稳定，**不闪烁、不重画**
- mermaid 源码区域持续追加文字时，图区域不跳动
- 模型停顿或回合结束后，图更新到最终完整版本

用 Playwright 或手动截图记录流式中的图状态。

- [ ] **Step 3: 验证回合结束后图正确显示**

回合结束后确认：
- Mermaid 图正确渲染、可放大、可复制
- 无「渲染失败」错误（除非源码本身有语法错误）

- [ ] **Step 4: 清理所有测试截图**

删除本次验证产生的所有截图文件（无论存放位置）：

Run: `find /path/to/HiAgent -name "*.png" -newer /tmp/marker 2>/dev/null -delete`（或手动删除本次产生的截图，确认不残留）。

Expected: 项目中无本次测试残留截图。

- [ ] **Step 5: 最终全量测试回归**

Run: `cd packages/frontend && export PATH="$HOME/.bun/bin:$PATH" && bun test tests/blocks/MermaidBlock.test.tsx`
Expected: 全部 PASS。
