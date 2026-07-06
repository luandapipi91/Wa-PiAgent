### Task 2: monorepo 骨架

**Files:**
- Create: `package.json`（root）/ `bunfig.toml` / `tsconfig.base.json` / `.gitignore`
- Create: `packages/shared/{package.json, tsconfig.json, src/index.ts}`
- Create: `packages/kernel/{package.json, tsconfig.json, src/index.ts}`
- Create: `packages/frontend/{package.json, tsconfig.json, src/main.tsx}`
- Test: `packages/shared/tests/scaffold.test.ts`

**Interfaces:**
- Produces: 三包经 `bun install` 可装、`bun test` 跑通；workspace 互引路径 `@hiagent/shared` 等

- [ ] **Step 1: root package.json**

```json
{
  "name": "hiagent",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "dev:kernel": "bun run --filter @hiagent/kernel dev",
    "dev:frontend": "bun run --filter @hiagent/frontend dev",
    "test": "bun test",
    "typecheck": "bun run --filter '*' --if-present typecheck"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "@types/bun": "^1.3.0"
  }
}
```

- [ ] **Step 2: bunfig.toml**

```toml
[test]
coverage = false
```

- [ ] **Step 3: tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": false,
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  }
}
```

- [ ] **Step 4: 三包 package.json**

`packages/shared/package.json`:
```json
{
  "name": "@hiagent/shared",
  "version": "0.0.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "bun test", "typecheck": "tsc --noEmit" }
}
```

`packages/kernel/package.json`:
```json
{
  "name": "@hiagent/kernel",
  "version": "0.0.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "dev": "bun run src/index.ts",
    "build": "bun build src/index.ts --target bun --outfile dist/kernel.js",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "@hiagent/shared": "workspace:*" }
}
```

`packages/frontend/package.json`:
```json
{
  "name": "@hiagent/frontend",
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@hiagent/shared": "workspace:*",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "zustand": "^5.0.0",
    "reactflow": "^11.11.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^6.0.0",
    "tailwindcss": "^3.4.0",
    "vitest": "^2.1.0",
    "@testing-library/react": "^16.0.0",
    "happy-dom": "^15.0.0"
  }
}
```

- [ ] **Step 5: 三包 tsconfig.json（同构，内容如下）**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist" },
  "include": ["src", "tests"]
}
```

- [ ] **Step 6: .gitignore**

```
node_modules/
dist/
.DS_Store
*.log
.vite/
.hiagent/
```

- [ ] **Step 7: 占位入口**

`packages/shared/src/index.ts`:
```typescript
// HiAgent 共享类型与纯函数包
export const HIAGENT_VERSION = "0.0.0";
```

`packages/kernel/src/index.ts`:
```typescript
// HiAgent 编排内核入口（Task 12 填充）
console.log("[kernel] 启动占位");
```

`packages/frontend/src/main.tsx`:
```typescript
// HiAgent 前端入口（Task 13 填充）
console.log("[frontend] 启动占位");
```

- [ ] **Step 8: 写冒烟测试**

`packages/shared/tests/scaffold.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { HIAGENT_VERSION } from "../src/index";

test("骨架可导入", () => {
  expect(HIAGENT_VERSION).toBe("0.0.0");
});
```

- [ ] **Step 9: 装 + 验证**

```bash
bun install
bun test
# 期望: 1 passed
bun run --filter @hiagent/shared typecheck
# 期望: 无错
```

- [ ] **Step 10: 提交**

```bash
git add -A
git commit -m "chore(scaffold): monorepo 骨架（shared/kernel/frontend 三包）"
```

> 验证（四层）：仅第一层——骨架冒烟测试 1 passed。第二/三/四层本 Task 不适用（无业务组件/API/E2E）。

---

