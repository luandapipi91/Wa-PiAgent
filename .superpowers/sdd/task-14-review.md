# Task 14 Review：WS 客户端 + 4 个 store

- Base: `8134829` → Head: `2a0d94a`
- Reviewer 复跑：`bun run test` → 4 passed（store-projects 2 + store-agents 1 + render 1）；`bun run typecheck` → 无错误。✅ 独立验证与报告一致。
- 工作区状态：clean（HEAD 已到 2a0d94a）。

---

## 一、Spec 合规判定：✅ 全部通过

### 1. ws-instance.ts 三导出 ✅
`getWs()` / `send(e)` / `onMessage(h)` 均按 brief Step 1 实现，逐字一致：
- `getWs`：懒建连 `ws://127.0.0.1:${WS_PORT}`（9776），`onmessage` JSON.parse 后广播 `handlers`。
- `send`：OPEN 直发；非 OPEN 注册一次性 `open` 监听发送。
- `onMessage`：`handlers.add` 返回 unsubscribe。

### 2. 4 store 字段 + actions ✅（逐字段比对 brief）
| Store | 字段 | Actions | 结论 |
|-------|------|---------|------|
| projects | `projects / sessions / currentProjectId / currentSessionId` | `load / setAll / createProject / addProject / addSession / selectProject / selectSession / setCurrentSessionId`（9 个） | ✅ 完全一致；`addProject`/`addSession` 还正确联动 currentId |
| session | `messagesBySession` | `append / clear` | ✅ |
| agents | `states / configs` | `setState / loadConfig / setConfig / getGlobalState` | ✅ |
| intercom | `asksBySession` | `addAsk / resolveAsk` | ✅ resolveAsk 按 `messageId` 标记 resolved+resolvedAt |

> 小注：brief 在 projects 行注释里写了 7 个 action，但 Step 2 代码含 9 个（多了 `setAll/addProject/setCurrentSessionId`）。实现严格按 Step 2 代码，无遗漏。configs 类型用 `Partial<Record<AgentName, AgentConfig>>`，比 brief 的 `Record` 更严谨（可选），不违背 spec。

### 3. 测试实跑 ✅
独立复跑 `bun run test`：3 文件 4 用例全绿，分布与 brief Step 7 期望（store-projects 2 + store-agents 1 + render 1）完全吻合；`tsc --noEmit` 无错误。

### 4. WS 事件类型对齐 ✅
核查 `@hiagent/shared`：`projects:list` / `project:create` / `agent:config:get` 均为合法 `WSClientEvent` 成员，store 的 send 调用类型安全。`WSClientEvent / WSServerEvent / WS_PORT / aggregateAgentState` 等导入真实存在（types.ts/constants.ts/pure.ts）。

---

## 二、代码质量判定：✅ 通过（无阻断项）

### Concern 1（重点核实）：Vite alias 改 fileURLToPath 绝对路径 —— **真实 bug 修复，合理，非过度改动**

**核实结论：报告诊断正确，修复方式正确。**

1. **诊断属实**：Task 13 的相对路径字符串 `alias: { "@hiagent/shared": "../../packages/shared/src/index.ts" }` 是 Vite 已知陷阱。Vite 把 alias value 当作「替换后路径」处理：对相对路径，浏览器/esbuild 解析时会以**import 发起方文件**为基准，而非 config root。因此从 `src/store/agents.ts` 引用时被解析为相对 `src/store/` 的 `../../packages/shared/...` → 实际指向 `packages/frontend/packages/shared/...`（不存在），触发 `Failed to resolve import`。
2. **为何 Task 13 未暴露**：render.test.tsx 不引用 `@hiagent/shared`，故 Task 13 单测全绿——属真实潜伏 bug，本任务首次引用 shared 类型/函数（agents.ts import `aggregateAgentState`）才触发。
3. **修复方式正确**：`fileURLToPath(new URL("../shared/src/index.ts", import.meta.url))` 以**配置文件本身**为基准生成绝对路径，是 Vite 官方 monorepo 文档推荐写法，dev/build/test 三态统一。改动仅 2 行 × 2 文件，范围最小。
4. **非过度改动**：未改 plugin/test config 其余项，未动 tsconfig paths（tsconfig 另有 paths 机制，职责不同），收敛得当。

> 跨包引用的根治其实应在 packages 层面统一（如 pnpm workspace + 包导出），但当前 hiagent 用 `workspace:*` + alias 直引 src 的混合模式，本修复在其既有约定内是最优解。

### Concern 2：getGlobalState 跨项目聚合 ✅ 正确
- 用 `get().states` 读当前快照（而非 set 闭包的旧值），保证读到最新状态。
- 过滤 `k.endsWith(\`:${name}\`)`——`AgentStateKey` 形如 `${projectId}:${agentName}`，后缀匹配精准捕获该 agent 在所有项目的状态。
- 调 `aggregateAgentState`：`blocked > thinking > idle` 优先级（pure.ts:19-23）。测试覆盖 idle→thinking、+blocked 两步断言，符合聚合语义。

### Concern 3：Zustand v5 create 用法 ✅ 正确
- `create<T>((set, get) => ({...}))`：泛型直接传 State，第二参 `get` 按需取（仅 agents store 用到）。
- 所有 set 均返回 partial state 对象 / 函数式 updater，符合 v5 不可变更新约定。
- store 单测用 `useXxxStore.setState(...)` + `getState()` 直接驱动，无需 React 渲染，断言干净。

### Concern 3（ws send 背压）：MVP 可接受 ✅
非 OPEN 态每次调用注册一次性 `open` 监听。理论风险：连不上 kernel 时监听器无限堆积。但：
- `{ once: true }` 保证每个监听最多触发一次后自动清理；
- 正常拨号场景（kernel 先起）几乎不进此分支；
- MVP 无重连/超时逻辑，当前实现已优于「静默丢弃」。

**结论：可接受，留待 WS 重连机制（后续 task）一并处理**，报告已在 concern 3 记录，无需本任务修复。

---

## 三、需修复项：无

无阻断、无 spec 偏离。以下为**非阻断的提示性观察**（不影响通过，供后续 task 知晓）：

1. **commit 范围略宽于 brief Step 8**：brief 写 `git add packages/frontend`，实际 commit 还含仓库根的 `CHANGELOG.md` 与 `bun.lock`。CHANGELOG 是合理增量；`bun.lock` 回填的是 Task 13 devDeps（@types/react / @types/react-dom），属锁文件自动产物。无功能影响。
2. **报告 concern 2 表述小误**：报告称「bun.lock 未纳入本次提交」，但 diff 显示 bun.lock **已**在 commit `2a0d94a` 中。仅报告文字不准确，非代码问题。（另：报告提及的 `ws-proj.json*` 残留当前工作区已 clean，应已清理。）

---

## 四、结论

| 维度 | 结论 |
|------|------|
| **Spec 合规** | ✅ ws 三导出齐 + 4 store 字段/actions 逐项对齐 brief + 4 测试实跑通过 + 类型/事件对齐 shared |
| **代码质量** | ✅ Zustand v5 用法正确、getGlobalState 聚合正确、ws 背压 MVP 可接受 |
| **alias 改动合理性** | ✅ 真实 bug 修复（Task 13 相对路径在跨目录引用 shared 时解析失败），fileURLToPath 绝对路径为 Vite monorepo 标准写法，范围最小，非过度改动 |
| **是否需修复** | ❌ 无需修复，准予合入 |
