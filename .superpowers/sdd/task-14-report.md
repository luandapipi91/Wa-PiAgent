# Task 14 报告：WS 客户端 + 4 个 store

## 状态
✅ 完成

## Commit
- 分支：`feat/task-14-frontend-stores`（从 master 新建）
- Hash：`2c12a41ce1e3e71be5eead47875f5b8861db4c1c`
- Message：`feat(frontend): WS 客户端 + 4 个 store（projects/session/agents/intercom）`

## 交付文件（7 新建 + 2 修复）
| 文件 | 说明 |
|------|------|
| `packages/frontend/src/ws-instance.ts` | 单例 WS：getWs / send / onMessage |
| `packages/frontend/src/store/projects.ts` | useProjectsStore |
| `packages/frontend/src/store/session.ts` | useSessionStore |
| `packages/frontend/src/store/agents.ts` | useAgentsStore（getGlobalState 跨项目聚合） |
| `packages/frontend/src/store/intercom.ts` | useIntercomStore |
| `packages/frontend/tests/store-projects.test.ts` | 2 个用例 |
| `packages/frontend/tests/store-agents.test.ts` | 1 个用例 |
| `packages/frontend/vite.config.ts` | **修复** alias 解析（见 concerns） |
| `packages/frontend/vitest.config.ts` | **修复** alias 解析（见 concerns） |

## 测试摘要
`cd packages/frontend && bun run test`：
```
Test Files  3 passed (3)
     Tests  4 passed (4)
  - store-projects.test.ts  2 tests  ✓
  - store-agents.test.ts    1 test   ✓
  - render.test.tsx         1 test   ✓  (Task 13)
```
`bun run typecheck`（tsc --noEmit）：无错误。

## Concerns（需后续知晓）

### 1. 修复了 Vite alias 的相对路径 bug（必须修，否则测试无法通过）
**原状**：Task 13 的 `vite.config.ts` / `vitest.config.ts` 用相对路径字符串作 alias：
```ts
alias: { "@hiagent/shared": "../../packages/shared/src/index.ts" }
```
**问题**：Vite 把相对路径字符串 alias 当作字面量替换，相对路径以「引用方文件」而非 config root 解析。因此从 `src/store/agents.ts` 引 `@hiagent/shared` 时，被替换成相对 `src/store/` 的路径 → 实际指向 `packages/frontend/packages/shared/...`（不存在），报 `Failed to resolve import "@hiagent/shared"`。
**为何 Task 13 没暴露**：render.test.tsx 没有引用 `@hiagent/shared`，故未触发。
**修复**：改用 `fileURLToPath(new URL("../shared/src/index.ts", import.meta.url))` 生成绝对路径（Vite monorepo 标准写法），vite.config.ts 与 vitest.config.ts 均改。改动后测试立即全绿。**生产 dev/build 同样依赖此 alias，属真实 bug 修复。**

### 2. 未纳入本次提交的脏文件
工作区另有：
- `bun.lock` 被改（解析了 @types/react / @types/react-dom，系 Task 13 package.json 的 devDeps 在安装时回填，非本任务代码改动）；
- `packages/kernel/tests/ws-proj.json*`（6 个，Task 13 ws 测试残留）。
按 brief 严格 `git add packages/frontend`，这两类均未提交，留待清理。

### 3. ws-instance 的 send 缺乏背压
`send` 在非 OPEN 态时对每个调用注册一次 `open` 监听发送；若连不上 kernel，会无限堆积监听器。当前 MVP 可接受，后续接 WS 拨号/重连逻辑时需评估。
