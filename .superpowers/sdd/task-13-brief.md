### Task 13: frontend 脚手架（Vite + React + Tailwind）

**Files:**
- Create: `packages/frontend/vite.config.ts` / `vitest.config.ts` / `tailwind.config.js` / `postcss.config.js` / `index.html`
- Modify: `packages/frontend/src/main.tsx`（最小渲染）/ Create `packages/frontend/src/App.tsx`
- Test: `packages/frontend/tests/render.test.tsx`

**Interfaces:**
- Consumes: `@hiagent/shared`
- Produces: 可 `bun run dev` 启动的 Vite dev server（`http://localhost:5173`）；`bun run test` 跑通渲染测试

- [ ] **Step 1: vite.config.ts**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  resolve: {
    alias: { "@hiagent/shared": "../../packages/shared/src/index.ts" },
  },
});
```

- [ ] **Step 2: vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    globals: true,
  },
  resolve: {
    alias: { "@hiagent/shared": "../../packages/shared/src/index.ts" },
  },
});
```

- [ ] **Step 3: tailwind.config.js + postcss.config.js**

```javascript
// tailwind.config.js
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        base: "#1e1e2e", mantle: "#181825", surface: "#313244", surface2: "#585b70",
        text: "#cdd6f4", subtext: "#a6adc8", overlay: "#6c7086",
        blue: "#89b4fa", green: "#a6e3a1", peach: "#fab387", yellow: "#f9e2af",
        mauve: "#cba6f7", red: "#f38ba8", lavender: "#b4befe", maroon: "#ebbc9e", teal: "#94e2d5",
      },
    },
  },
  plugins: [],
};
```

```javascript
// postcss.config.js
export default { plugins: { tailwindcss: {} } };
```

- [ ] **Step 4: index.html + src/styles.css**

`packages/frontend/index.html`:
```html
<!doctype html>
<html lang="zh">
  <head><meta charset="UTF-8" /><title>HiAgent</title></head>
  <body class="bg-base text-text"><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```

`packages/frontend/src/styles.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
body { margin: 0; font-family: 'Segoe UI', sans-serif; }
```

- [ ] **Step 5: main.tsx + App.tsx**

`packages/frontend/src/main.tsx`:
```typescript
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
createRoot(document.getElementById("root")!).render(<App />);
```

`packages/frontend/src/App.tsx`:
```typescript
export function App() {
  return <div className="p-4">HiAgent 占位</div>;
}
```

- [ ] **Step 6: 写渲染测试**

`packages/frontend/tests/render.test.tsx`:
```typescript
import { test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../src/App";

test("App 渲染占位", () => {
  render(<App />);
  expect(screen.getByText("HiAgent 占位")).toBeTruthy();
});
```

- [ ] **Step 7: 装依赖 + 跑测试**

```bash
cd packages/frontend
bun install
bun run test
# 期望: 1 passed
bun run dev
# 手动访问 http://localhost:5173 看到"HiAgent 占位"，Ctrl+C 退出
```

- [ ] **Step 8: 提交**

```bash
git add packages/frontend
git commit -m "chore(frontend): Vite + React 19 + Tailwind 脚手架"
```

> 验证（四层）：第二层 1 passed（组件渲染）。dev server 可启动留作手动验证。

---

