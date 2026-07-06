# Task 21 Review：App 三态路由（empty/new-session/session）

## 结论
✅ **PASS**（无阻断问题）

双判定一致：brief、report、diff 三文件相互印证，实现严格遵循 brief，未引入偏差。重点核实的 stale-closure 规避、三态派生、占位合理性全部达标。

---

## 重点核实

### 1. Stale Closure 规避 — ✅ 正确
核心约束：**action 不解构进闭包，回调内用 `useProjectsStore.getState()` 取最新**。逐点核对 App.tsx diff：

| 调用点 | 写法 | 判定 |
|---|---|---|
| 订阅渲染状态 | `useProjectsStore(s => s.projects)` / `s => s.currentSessionId` | ✅ 仅最小渲染状态 |
| `load()` | `useProjectsStore.getState().load()`（diff L43） | ✅ getState 取最新 |
| `onMessage` 回调 | `const ps = useProjectsStore.getState(); ... ps.setAll/addProject/addSession`（diff L44-51） | ✅ 每次事件 getState，**未解构任何 action 进闭包** |
| `useEffect` 依赖 | `}, []);`（diff L53） | ✅ 空依赖，onMessage 凭 getState 无需重订阅 |
| Sidebar `onSelectSession` | `useProjectsStore.getState().selectSession(id)` | ✅ |
| Sidebar `onNewSessionInProject` | `useProjectsStore.getState().selectProject(pid)` | ✅ |
| Sidebar `onNewProject` | `useProjectsStore.getState().createProject(...)` | ✅ |
| EmptyState `onNewProject` | `useProjectsStore.getState().createProject(...)` | ✅ |

**结论**：没有任何 action（load/setAll/addProject/addSession/selectSession/selectProject/createProject）被解构进 render 闭包，所有回调均走 `.getState()`。空依赖 `useEffect` 安全，无 stale closure 风险。

### 2. useEffect 空依赖 — ✅ 正确
WS 订阅 effect 为 `[]` 空依赖。`onMessage` 与 `load` 内部均用 `getState()`，不依赖任何 render-scope 变量，故无需重订阅。`return off` 清理返回的 unsubscribe 函数，与 `onMessage` 契约一致。派生 view 的 effect 依赖 `[projects.length, currentSessionId]`，正确响应状态变化触发三态切换。

### 3. 三态派生 — ✅ 正确
```
if (projects.length === 0)        → "empty"
else if (currentSessionId)        → "session"
else                              → "new-session"
```
- empty：无项目 ✅
- session：有项目 且 有 currentSessionId ✅
- new-session：有项目 且 无 currentSessionId ✅
逻辑与 brief 完全一致，依赖数组正确。

### 4. 测试 2 passed — ✅ 符合预期
App-routing.test.tsx 两用例：
1. 无项目 → `empty-state`（render 前置 store 空）✅
2. 有项目无会话 → `new-session-pane`（setState 注入 p1 + 空 sessions）✅

report 记录 23 passed（前序 21 + 本次 2），与 brief 期望（21+2）吻合。render.test.tsx 由「HiAgent 占位」文案断言改写为 empty 态断言（App 改造后旧文案已不存在），**用例数不增减仍为 1**，总数维持 23。此为合理的冒烟用例适配，非测试削弱。

### 5. SessionView / AgentConfig 占位 — ✅ 合理
| 组件 | Props 与 App 调用对齐 | data-testid | PLACEHOLDER 标注 | 功能性 |
|---|---|---|---|---|
| SessionView | `{ sessionId, onSwitchToCanvas }` = App `<SessionView sessionId={currentSessionId} onSwitchToCanvas={()=>{}} />` ✅ | `session-view` ✅ | 文件头注释 ✅ | 最小渲染占位 ✅ |
| AgentConfig | `{ agentName, onClose }` = App `<AgentConfig agentName={configAgent} onClose={()=>setConfigAgent(null)} />` ✅ | `agent-config` + `agent-config-close` ✅ | 文件头注释 ✅ | 最小渲染 + 关闭按钮 ✅ |

- 占位满足「最小功能性 + data-testid + props 对齐」三要素。
- App 的 session 分支 `currentSessionId && <SessionView .../>` 编译链路完整（当前路由测试未触发 session 态，但结构完备）。
- 接口签名与 App 调用一致，**Task 25/26 整体替换时无需改动 App**。

---

## 非阻断观察（记录，无需修）
1. **`onSwitchToCanvas` 未解构使用**：SessionView Props 声明了该 prop 但函数体只解构 `{ sessionId }`。对占位无害，Task 25 真实实现时使用。
2. **`onProjectSettings={() => {}}` 空实现**：brief 原样，待后续 Task 接项目设置面板。
3. **session 态无路由测试覆盖**：当前 2 用例覆盖 empty / new-session；session 态因依赖 SessionView 真实实现（Task 25），暂未单测。编译与派生逻辑正确，风险低。
4. **ws mock 完备**：`getWs` 返回伪 WS（readyState=1），`onMessage` 返回 unsubscribe 函数，与真实契约一致，不污染其它用例（每个测试文件独立 mock）。

---

## 交付物核对（6 文件，+150/-4）
- 改 `App.tsx`：占位 `<div>` → 三态路由组合 ✅
- 新建 `EmptyState.tsx`：brief Step 1 原样 ✅
- 新建 `SessionView.tsx`（占位）✅
- 新建 `AgentConfig.tsx`（占位）✅
- 新建 `App-routing.test.tsx`：2 用例 ✅
- 改 `render.test.tsx`：mock + empty 断言 ✅
