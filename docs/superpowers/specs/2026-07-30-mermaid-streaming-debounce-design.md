# Mermaid 流式渲染防闪烁优化

- **日期：** 2026-07-30
- **状态：** 待实现
- **作者：** brainstorming 协作产出

## 背景与问题

流式输出过程中，模型逐 token 输出 Mermaid 源码，渲染链路如下：

1. 每个 token delta 到达 → `session.ts` 的 `message_update` 直接全量 `set` 替换 streaming 对象（每 token 一次）
2. `MessageList.tsx` 把 streaming content 拼进末行 → 重建整个 `displayRows`
3. `MessageRow` 重渲染 → `ReactMarkdown` 用变长的 text 重新解析整段 markdown AST
4. 解析出 `language-mermaid` 代码块 → 抽取**变长的 `code`** → 传给 `<MermaidBlock code={code}/>`
5. `MermaidBlock.tsx` 的 `useEffect([code])` 命中 → 重跑 `mermaid.render()` → 成功后用新 SVG 替换 DOM，**整张图重画**

**核心问题：** 成功渲染路径当前**零节流**。commit fbe2057 只给"错误显示"加了 400ms debounce（流式中 code 不完整导致解析失败时，延迟 400ms 才显示错误，避免闪现"渲染失败"）。但当 mermaid 源码恰好能解析成功时，每个 token 都会 `setSvg` 立刻重画整张图，造成**已渲染好的图反复闪烁重画**。

用户反馈的现象正是「成功图反复闪烁重画」。

## 目标

1. 流式过程中，已渲染的 Mermaid 图保持稳定不闪
2. code 停止变化 1s 后，自动更新到最新版本
3. 回合结束后 guaranteed 渲染最终态
4. 只改 `MermaidBlock.tsx` 一个文件，不触碰 `session.ts` / `MessageList.tsx` / `markdown-components.tsx` 的流式合并链路（影响面大）

## 非目标（YAGNI）

- 不改流式数据更新机制（`session.ts` 每 token 全量 set 是有意为之，避免后台标签页卡顿）
- 不改 `MessageList` 的合并逻辑（`mergeStreamingIntoLast` 每次重建数组是现有行为）
- 不改 `markdown-components.tsx` 的代码块分流
- 不引入跨组件的 `isStreaming` 状态透传（会扩大改动面）
- 不动现有的错误显示 debounce（400ms）、loading 态、缩放/复制/Modal 逻辑

## 核心机制（两层防护，A+C 组合）

### 第 1 层 — 成功渲染节流（方案 A，主防护）

code 变化不立即 render。用 debounce timer 延迟 **1000ms**：每次 code 变化就重置 timer，只有 code 连续 1000ms 不再变化才真正执行 `mermaid.render()`。

- 流式过程中 token 间隔通常远小于 1s，timer 会被不断重置 → render 实际不触发 → `svg` state 保持上一次成功值 → 图稳定不闪
- 模型停顿超过 1s（段落结束）或回合结束（最后一个 token 后 1s 无新 token）→ timer 到期，渲染最新版本

### 第 2 层 — SVG 内容 diff 缓存（方案 C，双保险）

即便节流到期触发了 render，也用 ref 缓存上次成功渲染的 SVG 字符串；只有新 SVG 与缓存**不同**时才 `setSvg` 替换 DOM。防止 mermaid 对"内容等价但内部 id/顺序微变"的 code 生成视觉相同的 SVG 却触发无谓重画。

### 与现有错误 debounce 的协调

| 机制 | 阈值 | 触发条件 |
|---|---|---|
| 成功渲染节流（新增） | 1000ms | code 稳定 1000ms 后才尝试 render |
| 错误显示 debounce（现有） | 400ms | render 失败后再等 400ms 才显示错误 |

因为成功节流(1000ms) > 错误 debounce(400ms)，render 只会在 code 真正稳定后才执行。若此时失败，错误会在 render 失败后再等 400ms 显示。两者不冲突，各自独立计时。

## 架构与组件改动

仅改 `packages/frontend/src/components/blocks/MermaidBlock.tsx`。

### 新增常量

```ts
// 成功渲染节流：code 稳定该时长后才 render，避免流式过程中每个 token 都重画
const RENDER_DEBOUNCE_MS = 1000;
```

### 新增 ref

```ts
// 缓存上次成功 SVG 字符串，用于 diff：内容相同则不替换 DOM
const lastSvgRef = useRef<string | null>(null);
```

### 改造 `useEffect([code])` 内部逻辑

当前是「立即 render」。改为「debounce 后 render + SVG diff」：

```ts
useEffect(() => {
  let cancelled = false;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let errorTimer: ReturnType<typeof setTimeout> | null = null;
  let container: HTMLDivElement | null = null;

  // code 稳定 RENDER_DEBOUNCE_MS 后才真正 render
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

### 关键行为

| 场景 | 行为 |
|------|------|
| 流式中 code 持续变化（token 间隔 <1s） | renderTimer 不断被重置，render 不执行，保留上次成功 SVG；若无上次成功则显示 loading |
| 模型停顿 >1s | timer 到期，render 最新 code，SVG diff 后若不同则更新一次 |
| 回合结束（最后 token 后 1s 无新 token） | guaranteed 渲染最终态 |
| code 变了但生成的 SVG 与上次相同 | diff 命中，不替换 DOM，不闪 |
| 组件卸载（切会话） | cleanup 清掉所有 timer，不泄漏 |
| 已有 error 态时 code 变化 | 清旧 error timer，重新走 1s 节流 render |

## 验收标准（4 层测试）

遵循 AGENTS.md 四层验收标准。本次是纯前端单组件改动，第 3 层不涉及新接口。

### 第 1/2 层 · 组件测试（Vitest + RTL，`tests/blocks/MermaidBlock.test.tsx` 扩展）

`MermaidBlock` 本身是 React 组件，组件测试即覆盖渲染断言。使用 fake timers 控制 1000ms 节流：

- **保留已有用例：** 失败 → 50ms 补全为有效 → 全程不出现 error
- **新增 · 节流生效：** code 连续变化（每次间隔 <1000ms）→ `mermaid.render` 调用次数为 0
- **新增 · 节流到期渲染：** code 变化后推进 fake timer 1000ms+ → `mermaid.render` 被调用 1 次，SVG 出现在 DOM
- **新增 · SVG diff 生效：** 连续两次 code（推进 timer 后）生成相同 SVG → 第二次不触发 DOM 重画（mock mermaid.render 返回相同 svg 字符串，断言 `mermaid-svg` 内容不变 / render 调用计数不导致额外 setSvg）
- **新增 · 卸载无泄漏：** 组件卸载后推进 timer → 不抛错、不调用 setState（验证 cleanup 清理 renderTimer）

### 第 3 层 · 跳过说明

本次无新增 REST 端点，核心契约由组件测试覆盖。

### 第 4 层 · E2E（手动 / Playwright）

发一条会生成 mermaid 图的消息，流式过程中截图确认图不闪烁、回合结束后图正确显示。测试产生的截图在完成后全部删除。

## 改动文件清单

| 文件 | 操作 | 说明 |
|---|---|---|
| `packages/frontend/src/components/blocks/MermaidBlock.tsx` | 改 | 新增 `RENDER_DEBOUNCE_MS` 常量 + `lastSvgRef`；`useEffect([code])` 改为 debounce 后 render + SVG diff |
| `packages/frontend/tests/blocks/MermaidBlock.test.tsx` | 改 | 新增节流生效 / 节流到期 / SVG diff / 卸载无泄漏用例 |
| `CHANGELOG.md` | 改 | 记录本次变更 |
