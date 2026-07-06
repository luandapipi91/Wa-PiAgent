# Task 13 Report: frontend 脚手架（Vite + React 19 + Tailwind）

**状态：** ✅ 完成
**Commit：** `52f4d94` — `chore(frontend): Vite + React 19 + Tailwind 脚手架`
**分支：** master（相对 origin/master 领先 14 commits）

## 做了什么

按 brief Step 1-8 逐项执行，在 `packages/frontend` 建起 Vite + React 19 + Tailwind 脚手架：

### 新建文件（8）
- `vite.config.ts` — Vite 配置（@vitejs/plugin-react + port 5173 + @hiagent/shared alias）
- `vitest.config.ts` — Vitest 配置（happy-dom 环境 + globals）
- `tailwind.config.js` — Tailwind + Catppuccin Mocha 调色板（base/mantle/surface/text/blue/green/...）
- `postcss.config.js` — PostCSS tailwindcss 插件
- `index.html` — Vite 入口 HTML（zh lang + #root + bg-base/text-text）
- `src/styles.css` — Tailwind 三件套 + body 字体
- `src/App.tsx` — 占位组件（`<div className="p-4">HiAgent 占位</div>`）
- `tests/render.test.tsx` — 渲染测试（@testing-library/react + getByText 断言）

### 修改文件（3）
- `src/main.tsx` — 从 Task 2 的 `console.log` 占位改为真实 `createRoot().render(<App />)` + 引入 styles.css
- `package.json` — 补 devDependencies（见下「Task 2 遗留」）
- `tsconfig.json` — compilerOptions 加 `"jsx": "react-jsx"`（见下「Task 2 遗留」）

## Task 2 遗留的 2 个 Minor（已补上）

本 Task 引入 JSX（App.tsx / render.test.tsx），必须先消掉 Task 2 review 记的两个债：

1. **`@types/react` / `@types/react-dom` 缺失** → package.json devDependencies 加上：
   ```json
   "@types/react": "^19.0.0",
   "@types/react-dom": "^19.0.0",
   ```
   bun install 实际解析为 `@types/react@19.2.17` / `@types/react-dom@19.2.3`，与 react 19 对齐。
2. **tsconfig 缺 `jsx` 配置** → tsconfig.json compilerOptions 加 `"jsx": "react-jsx"`（继承自 base tsconfig，base 里没有 jsx，必须本包显式设）。不补的话 tsc 会报 `Cannot use JSX unless '--jsx' flag is provided`。

## 验证（四层验收 — 第二层）

| 层级 | 命令 | 结果 |
|------|------|------|
| 安装 | `cd packages/frontend && bun install` | ✅ 26 packages，新增 @types/react@19.2.17 / @types/react-dom@19.2.3 / reactflow@11.11.4 / zustand@5.0.14 / @testing-library/react@16.3.2 |
| **第二层：组件测试** | `bun run test` | ✅ **1 passed**（render.test.tsx，13ms，happy-dom 环境）|
| 类型检查 | `bun run typecheck`（tsc --noEmit） | ✅ 无错误（jsx 配置生效，@types 已就位）|
| dev server | `bun run dev` | ✅ Vite 6.4.3，582ms 启动，`http://localhost:5173/` 返回 HTTP 200；index.html 正常、main.tsx 的 JSX 被 Vite 正确 transform（jsxDev runtime 注入）、React Refresh 生效 |

dev server 已做自动化冒烟测试（启动 → curl 200 → 抓取 HTML + 转换后的 main.tsx 确认 JSX runtime 注入 → 关闭），不只是「能启动」。

## 测试摘要

```
✓ tests/render.test.tsx (1 test) 13ms
Test Files  1 passed (1)
     Tests  1 passed (1)
```

## Concerns / 注意事项

1. **AGENTS.md 与 brief 的测试工具不一致（已知，按 brief 走）：** AGENTS.md 第 79 行写「前端、后端统一用 `bun:test`」，第二层组件测试提的是 Vue/happy-dom（旧计划残留）。本 Task 的 brief 明确用 **Vitest + happy-dom + @testing-library/react**（React 栈），package.json 也已配 vitest。我严格遵循 brief（更权威、更新）。**建议后续 Task 同步更新 AGENTS.md 第 78-88 行**：把第一层工具改成「后端 bun:test / 前端 vitest」，第二层把「Vue 组件」改成「React 组件」，避免后续 subagent 误用 bun:test 写前端组件测试。
2. **`@hiagent/shared` alias 双重声明：** vite.config.ts 和 vitest.config.ts 各写了一份 `resolve.alias` 指向 `../../packages/shared/src/index.ts`（相对路径）。当前能跑通，但若 frontend 包被移动则两处都要改。属 brief 既定写法，未自作主张抽公共配置。
3. **dev server 第二层验证为冒烟级：** 仅断言 HTML/JSX transform 正常，未用 headless 浏览器断言「HiAgent 占位」文字真的渲染到 DOM（brief 明确把 dev server 留作「手动验证」）。后续接入 agent-browser / Playwright 时可补第四层 E2E。
4. **CRLF 警告：** git commit 时所有新文件报「LF will be replaced by CRLF」，属 Windows 正常行为，无影响。仓库无 .gitattributes 强制 LF，保持现状。

## 文件清单

```
packages/frontend/
├── index.html            (new)
├── postcss.config.js     (new)
├── tailwind.config.js    (new)
├── vite.config.ts        (new)
├── vitest.config.ts      (new)
├── package.json          (modified: +@types/react +@types/react-dom)
├── tsconfig.json         (modified: +jsx react-jsx)
├── src/
│   ├── App.tsx           (new)
│   ├── main.tsx          (modified: createRoot render)
│   └── styles.css        (new)
└── tests/
    └── render.test.tsx   (new)
```
