# pi RPC 扩展 UI 子协议全量对接实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对接 pi RPC 扩展 UI 全部子协议（dialog: select/confirm/input/editor + fire-and-forget set_editor_text），删除 tuiOnly 误标扫描，修复本地扩展 Windows 路径加载。

**Architecture:** 对话子协议复用 ask_user_question 的既有骨架：kernel 注册 pending → sdk:event 广播 → 前端弹窗 → REST 应答 → resolve 回写 `extension_ui_response`。`set_editor_text` 桥接为事件注入 Composer。tuiOnly 静态扫描整体删除（官方无此概念，前端已不消费）。本地扩展加载绕过 createRequire 直接读文件系统。

**Tech Stack:** bun + TypeScript（kernel）、React + zustand（frontend）、bun:test、Playwright（E2E，PI_E2E=1 门控）。

## Global Constraints

- 所有回复/注释用中文；遵循 AGENTS.md 四层验收（单元 → 组件 → API → E2E）。
- pi 官方事实（已核实 pi 0.83 源码与 pi.dev/docs/latest/rpc）：
  - `RegisteredCommand` 无 TUI 标记字段；内置 TUI 命令不进 `get_commands`。
  - RPC 模式 `custom()` 返回 `undefined`（不挂起）；`select/confirm/input/editor` 走 `extension_ui_request`/`extension_ui_response` 子协议；`set_editor_text` 为 fire-and-forget。
  - dialog 请求带 `timeout` 时 pi 侧自动 resolve，宿主无需实现超时。
- 每完成一个 Task 更新根目录 `CHANGELOG.md`（顶部追加）。
- 测试产生的截图/临时文件全部清理。

---

### Task 1: 修本地扩展 Windows 路径加载

**Files:**
- Modify: `packages/kernel/src/extensions.ts`（`buildAdditionalExtensionPaths`）
- Test: `packages/kernel/tests/extensions.test.ts`

**Interfaces:**
- Produces: `resolveLocalExtensionEntry(dir: string): string`（内部函数，不导出也可）；`buildAdditionalExtensionPaths` 接受绝对路径条目（local 插件在 settings 里存的就是绝对路径，`ExtensionManager.listEnabledPackageNames()` 会原样传出）。

背景：`readPiExtensionsDeclaration`/`resolveExtensionEntryFile` 用 `createRequire` 解析包名；Windows 绝对路径 `H:\a\b` 会被损毁成 `H:ab`（反斜杠被吃）→ resolve 失败 → 本地扩展从未进入 `-e` 列表 → pi 进程没注册其命令（/uidemo 扫不到的根因）。

- [ ] **Step 1: 写失败测试**

在 `packages/kernel/tests/extensions.test.ts` 追加：

```ts
test("buildAdditionalExtensionPaths 解析本地绝对路径扩展（pi.extensions 声明）", () => {
  const root = join(WA_PI_DIR, "tmp", `local-ext-${Date.now()}`);
  tmpPaths.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "local-demo", pi: { extensions: ["./src"] },
  }));
  writeFileSync(join(root, "src", "index.ts"), "export default function() {}\n");

  const paths = buildAdditionalExtensionPaths([root]);
  expect(paths).toContain(join(root, "src", "index.ts"));
});

test("buildAdditionalExtensionPaths 本地路径无 pi.extensions 时回退约定入口", () => {
  const root = join(WA_PI_DIR, "tmp", `local-ext-${Date.now()}-2`);
  tmpPaths.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "local-demo-2" }));
  writeFileSync(join(root, "index.ts"), "export default function() {}\n");

  const paths = buildAdditionalExtensionPaths([root]);
  expect(paths).toContain(join(root, "index.ts"));
});
```

（`tmpPaths`/`WA_PI_DIR` 的导入参照该文件已有测试的写法；若该文件没有 tmpPaths 收集器则仿照 `agent-manager.test.ts` 的模式补一个 afterEach 清理。）

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test packages/kernel/tests/extensions.test.ts`
Expected: FAIL（两个用例的路径不在返回列表）

- [ ] **Step 3: 实现**

`extensions.ts` 顶部 import 加 `isAbsolute`（`node:path`）与 `readFileSync`（`node:fs`），新增：

```ts
/**
 * 本地路径扩展（local 来源，settings 存绝对路径）解析入口：直接读文件系统，
 * 绕过 createRequire——它会把 Windows 反斜杠路径损毁（H:\a\b → H:ab）。
 * 优先级与 resolveExtensionEntryFile 对齐：pi.extensions 声明 → 约定入口。
 */
function resolveLocalExtensionEntry(dir: string): string {
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { pi?: { extensions?: string[] } };
      const piExts = pkg?.pi?.extensions;
      if (Array.isArray(piExts) && piExts.length > 0) {
        const entry = resolveDeclaredEntry(resolve(dir, piExts[0]));
        if (entry) return entry;
      }
    } catch {}
  }
  for (const candidate of ["extensions/index.ts", "extensions/index.js", "index.ts", "index.js"]) {
    const p = join(dir, candidate);
    if (existsSync(p)) return p;
  }
  throw new Error(`本地扩展无有效入口: ${dir}`);
}
```

`buildAdditionalExtensionPaths` 的 dynamicPkgNames 循环最前面加：

```ts
for (const name of dynamicPkgNames) {
  // local 来源（绝对路径）：走文件系统解析，绕过 createRequire
  if (isAbsolute(name)) {
    try {
      paths.push(resolveLocalExtensionEntry(name));
    } catch (err) {
      console.error(`[kernel] 解析本地扩展入口失败 ${name}:`, err);
    }
    continue;
  }
  if (!readPiExtensionsDeclaration(name)) continue;
  // ...（原有逻辑不变）
```

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `bun test packages/kernel/tests/extensions.test.ts packages/kernel/tests/extension-manager.test.ts packages/kernel/tests/agent-manager.test.ts`
Expected: 全 PASS

- [ ] **Step 5: 真实验证（隔离 kernel）**

用调试 kernel（WA_PI_DIR 隔离、WA_PI_WS_PORT=19876）：
1. `POST /api/extensions/install` 装 `H:\workspace\hiagent\examples\ext-ui-bridge-demo`（已装则跳过）
2. `POST /api/agents/:pid/:sid/prompt` 建会话（agentName 用 displayName「研发」）
3. `GET /api/extensions/commands` 应含 `uidemo` 且 `packageName === "ext-ui-bridge-demo"`

- [ ] **Step 6: Commit**

```bash
git add packages/kernel/src/extensions.ts packages/kernel/tests/extensions.test.ts
git commit -m "fix: 本地扩展 Windows 绝对路径加载绕过 createRequire"
```

---

### Task 2: 删除 tuiOnly 静态扫描（保留 packageName 附加）

**Files:**
- Modify: `packages/kernel/src/tui-command-filter.ts`（瘦身为 packageName 附加）
- Modify: `packages/kernel/src/agent-manager.ts`（`_fetchCommands` 调用点与 import）
- Modify: `packages/shared/src/commands.ts`（删 `tuiOnly` 字段）
- Test: `packages/kernel/tests/tui-command-filter.test.ts`、`packages/kernel/tests/agent-manager.test.ts:1783`、`packages/frontend/src/components/settings/CommandListModal.test.tsx`

**Interfaces:**
- Produces: `attachPackageName(commands: RawCommandInfo[]): CommandInfo[]`（原 `filterTuiCommands` 改名；只做 sourceInfo.path → packageName 附加，不再扫描文件、不再产出 tuiOnly）。

背景：官方无 TUI-only 概念（`custom()` 返回 undefined 由扩展自守卫）；前端自 commit e9eeae10 后不再消费 tuiOnly；扫描每次拉命令清单都走文件系统（上限 300 文件）纯属开销，且把 RPC 受支持的 dialog 方法误标为 TUI-only。

- [ ] **Step 1: 改测试为失败态**

`tui-command-filter.test.ts`：删除所有 `isTuiOnlyExtension` 用例，保留/改为：

```ts
test("attachPackageName 给 extension 命令附加包名，非 extension 原样返回", () => {
  // 造临时包（含 package.json name=goal-ext + index.ts），构造：
  // commands = [{ name: "goal", source: "extension", sourceInfo: { path: join(extDir, "index.ts") } },
  //             { name: "review", source: "prompt" }]
  // 断言：goal 带 packageName "goal-ext"，review 无 packageName
});
```

`agent-manager.test.ts:1783` 的「getCommands 给 TUI-only 扩展的命令附加 tuiOnly 标记」用例改为「getCommands 附加 packageName 且不产生 tuiOnly 字段」。`CommandListModal.test.tsx` 删除 `tuiOnly: true` 数据与「tuiOnly 命令不显示 ⚠ 徽标」用例。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test packages/kernel/tests/tui-command-filter.test.ts`
Expected: FAIL（`attachPackageName` 未定义）

- [ ] **Step 3: 实现**

`tui-command-filter.ts` 重写为（文件头注释同步更新：说明官方无 TUI-only 标记、扫描已删除的原因）：

```ts
// tui-command-filter.ts — extension 命令的包名（packageName）附加
//
// 历史：本文件曾静态扫描扩展源码识别 TUI-only 命令（ui.custom/input/select/...），
// 已删除。理由：pi 官方无 TUI-only 概念——get_commands 不返回内置 TUI 命令；
// RPC 模式 custom() 返回 undefined（扩展应用 ctx.mode === "tui" 自守卫）；
// select/confirm/input/editor 有官方 dialog 子协议（本宿主已对接，见 ext-ui-registry）。
// 且前端自 e9eeae10 起不再消费 tuiOnly 标记，扫描纯属开销 + 误标。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { statSync } from "node:fs";
import type { CommandInfo } from "@wa-pi/shared";

/** pi get_commands 返回的原始命令条目（比前端 CommandInfo 多 sourceInfo） */
export interface RawCommandInfo extends CommandInfo {
  sourceInfo?: { path: string; source?: string; scope?: string; origin?: string; baseDir?: string };
}

// findPackageRoot / resolvePackageName 保持现有实现不变（从入口路径向上找 package.json 读 name）

/** 给 extension 来源命令附加 packageName（waPiCommandToggles 的 key）；其余原样返回 */
export function attachPackageName(commands: RawCommandInfo[]): CommandInfo[] {
  return commands.map((cmd) => {
    if (cmd.source !== "extension") return cmd;
    const info = cmd.sourceInfo;
    if (!info?.path) return cmd;
    const packageName = resolvePackageName(info.path);
    if (packageName === undefined) return cmd;
    return { ...cmd, packageName };
  });
}
```

`agent-manager.ts`：`import { filterTuiCommands }` 改 `import { attachPackageName }`，`_fetchCommands` 内调用点同步改名。`shared/src/commands.ts` 删 `tuiOnly?: boolean;` 行。

- [ ] **Step 4: 跑测试 + typecheck**

Run: `bun test packages/kernel/tests/ && cd packages/frontend && bun test --isolate tests/ && cd ../.. && bun run typecheck`
Expected: 全 PASS；typecheck 全绿（tuiOnly 残留引用会编译报错，逐一清除）

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/tui-command-filter.ts packages/kernel/src/agent-manager.ts packages/shared/src/commands.ts packages/kernel/tests/tui-command-filter.test.ts packages/kernel/tests/agent-manager.test.ts packages/frontend/src/components/settings/CommandListModal.test.tsx
git commit -m "refactor: 删除 tuiOnly 静态扫描（官方无此概念，前端已不消费）"
```

---

### Task 3: kernel 对话子协议接线 + set_editor_text 转发

**Files:**
- Create: `packages/kernel/src/ext-ui-registry.ts`
- Modify: `packages/kernel/src/agent-manager.ts`（createClient 注入 onUiRequest；abort/_teardownSession/onExit 兜底 cancel）
- Modify: `packages/kernel/src/ws-server.ts`（新增 `extension:dialog:respond` case）
- Modify: `packages/kernel/src/routes/extensions.ts`（新增 POST /api/extensions/dialog/respond）
- Modify: `packages/kernel/src/rpc-client.ts`（set_editor_text 转发为事件）
- Test: `packages/kernel/tests/ext-ui-registry.test.ts`（新）、`packages/kernel/tests/routes-extensions-commands.test.ts`（追加 respond 路由用例）、`packages/kernel/tests/rpc-client.test.ts`（追加 set_editor_text 转发用例）

**Interfaces:**
- Produces:
  - `extUiRegistry.register(sessionId: string, req: RpcUiRequest): Promise<UiResponseFields>`
  - `extUiRegistry.respond(requestId: string, fields: UiResponseFields): boolean`（未知/已解决 id 返回 false）
  - `extUiRegistry.cancelAllForSession(sessionId: string): void`
  - 广播事件（sdk:event 信封内）：`{ type: "extension_dialog", requestId, method, title?, message?, options?, placeholder?, prefill?, timeout? }`
  - 广播事件：`{ type: "extension_editor_text", text }`
  - REST：`POST /api/extensions/dialog/respond` body `{ requestId, value?, confirmed?, cancelled? }`；未知 id → 400 `{ error: "对话不存在或已应答" }`

- [ ] **Step 1: 写 ext-ui-registry 失败测试**

`packages/kernel/tests/ext-ui-registry.test.ts`：

```ts
import { test, expect, beforeEach } from "bun:test";
import { ExtUiRegistry } from "../src/ext-ui-registry";

let reg: ExtUiRegistry;
beforeEach(() => { reg = new ExtUiRegistry(); });

const req = (id: string) => ({ type: "extension_ui_request" as const, id, method: "confirm", title: "t" });

test("register 阻塞直到 respond，返回业务字段", async () => {
  const p = reg.register("s1", req("r1"));
  expect(reg.respond("r1", { confirmed: true })).toBe(true);
  await expect(p).resolves.toEqual({ confirmed: true });
});

test("respond 未知/重复 id 返回 false", async () => {
  expect(reg.respond("nope", { cancelled: true })).toBe(false);
  const p = reg.register("s1", req("r2"));
  expect(reg.respond("r2", { cancelled: true })).toBe(true);
  expect(reg.respond("r2", { cancelled: true })).toBe(false);
  await p;
});

test("cancelAllForSession 以 cancelled 解决该会话全部 pending，不影响其他会话", async () => {
  const p1 = reg.register("s1", req("a"));
  const p2 = reg.register("s2", req("b"));
  reg.cancelAllForSession("s1");
  await expect(p1).resolves.toEqual({ cancelled: true });
  expect(reg.respond("b", { value: "x" })).toBe(true);
  await expect(p2).resolves.toEqual({ value: "x" });
});
```

- [ ] **Step 2: 跑确认失败** → `bun test packages/kernel/tests/ext-ui-registry.test.ts` → FAIL（模块不存在）

- [ ] **Step 3: 实现 ext-ui-registry.ts**

```ts
// ext-ui-registry.ts — pi 扩展 dialog 子协议（select/confirm/input/editor）的
// pending 注册表（进程级单例）。语义对齐 ask-registry：
// pi handler 在等 extension_ui_response → 本表阻塞；前端应答路由调 respond()；
// abort / teardown / 进程退出调 cancelAllForSession() 兜底（防扩展永久阻塞）。
// 不设超时：pi 侧请求带 timeout 时会自动 resolve（官方行为）。
import type { RpcUiRequest, UiResponseFields } from "./rpc-client";

interface Entry {
  sessionId: string;
  resolve: (f: UiResponseFields) => void;
  done: boolean;
}

export class ExtUiRegistry {
  private byId = new Map<string, Entry>();

  register(sessionId: string, req: RpcUiRequest): Promise<UiResponseFields> {
    const entry: Entry = { sessionId, resolve: () => {}, done: false };
    const promise = new Promise<UiResponseFields>((resolve) => {
      entry.resolve = (f) => {
        if (entry.done) return;
        entry.done = true;
        this.byId.delete(req.id);
        resolve(f);
      };
    });
    this.byId.set(req.id, entry);
    return promise;
  }

  respond(requestId: string, fields: UiResponseFields): boolean {
    const entry = this.byId.get(requestId);
    if (!entry) return false;
    entry.resolve(fields);
    return true;
  }

  cancelAllForSession(sessionId: string): void {
    for (const e of [...this.byId.values()]) {
      if (e.sessionId === sessionId) e.resolve({ cancelled: true });
    }
  }

  /** 测试用：清空全部状态 */
  reset(): void { this.byId.clear(); }
}

export const extUiRegistry = new ExtUiRegistry();
```

- [ ] **Step 4: 接线 agent-manager + ws-server + 路由 + rpc-client**

1. `agent-manager.ts` `_createSession` 的 `createClient({...})` 加（闭包内 sessionId/projectId/agentName 均可用）：

```ts
onUiRequest: (req) => this._onExtUiRequest(sessionId, projectId, agentName, req),
```

新增方法：

```ts
/** pi 扩展 dialog 请求（select/confirm/input/editor）：注册 pending + 广播给前端，阻塞等应答 */
private _onExtUiRequest(
  sessionId: string, projectId: string, agentName: string, req: RpcUiRequest,
): Promise<UiResponseFields> {
  const promise = extUiRegistry.register(sessionId, req);
  this.opts.onEvent(sessionId, projectId, agentName, {
    type: "extension_dialog",
    requestId: req.id,
    method: req.method,
    title: typeof req.title === "string" ? stripAnsi(req.title) : undefined,
    message: typeof req.message === "string" ? stripAnsi(req.message) : undefined,
    options: Array.isArray(req.options) ? req.options.map((o) => stripAnsi(String(o))) : undefined,
    placeholder: req.placeholder,
    prefill: req.prefill,
    timeout: req.timeout,
  });
  return promise;
}
```

（`stripAnsi` 从 `./rpc-client` import；`extUiRegistry` 从 `./ext-ui-registry` import。）

2. 兜底 cancel：`abort()` 内 `askRegistry.cancelAll(sessionId)` 旁加 `extUiRegistry.cancelAllForSession(sessionId)`；`_teardownSession()` 内同加一行（进程死亡/重建时挂起的对话必须以 cancelled 解决，否则 rpc-client 的 handleUiRequest 永远不返回——虽然进程已死无实际阻塞，但 registry 会泄漏）。

3. `ws-server.ts` 新增 case（放在 `extension:commands:toggle` 之后）：

```ts
case "extension:dialog:respond": {
  // pi 扩展 dialog 应答：直达 ExtUiRegistry.respond（幂等；未知/已应答 id 报 400）
  const ok = extUiRegistry.respond(event.requestId, {
    value: event.value,
    confirmed: event.confirmed,
    cancelled: event.cancelled,
  });
  if (!ok) {
    reply({ type: "error", message: "对话不存在或已应答", sessionId: event.sessionId });
    break;
  }
  reply({ type: "extension:dialog:respond", ok: true });
  break;
}
```

4. `routes/extensions.ts` 加：

```ts
r.add("POST", "/api/extensions/dialog/respond", async (req) => {
  const b = await readJsonBody(req);
  if (!b?.requestId) {
    return new Response(JSON.stringify({ error: "参数缺失" }), { status: 400 });
  }
  return callApi({ type: "extension:dialog:respond", ...b });
});
```

（`WSClientEvent` 联合类型在 shared 需加 `extension:dialog:respond` 事件定义：`{ type; requestId: string; sessionId?: string; value?: unknown; confirmed?: boolean; cancelled?: boolean }`。）

5. `rpc-client.ts` `handleUiRequest` 内 setTitle 块之后加：

```ts
// set_editor_text：官方 fire-and-forget「设置输入框文本」，桥接为事件由前端 Composer 消费
// （此前刻意不转发；现全量对接子协议，转发语义为「替换输入框内容」）
if (req.method === "set_editor_text" && typeof req.text === "string") {
  this.opts.onEvent({
    type: "extension_editor_text",
    text: req.text,
  } as RpcEvent);
}
```

- [ ] **Step 5: 补路由与 rpc-client 测试并全绿**

- `routes-extensions-commands.test.ts` 追加：POST /api/extensions/dialog/respond 缺 requestId → 400；正常 body → 调 registry（spy）。
- `rpc-client.test.ts` 追加：注入假进程输出一行 `extension_ui_request`（method=set_editor_text）→ onEvent 收到 `extension_editor_text`。
- Run: `bun test packages/kernel/tests/ && bun run typecheck`
Expected: 全 PASS

- [ ] **Step 6: Commit**

```bash
git add packages/kernel/src/ext-ui-registry.ts packages/kernel/src/agent-manager.ts packages/kernel/src/ws-server.ts packages/kernel/src/routes/extensions.ts packages/kernel/src/rpc-client.ts packages/shared/src packages/kernel/tests/
git commit -m "feat: 对接 pi 扩展 dialog 子协议（kernel 侧）+ set_editor_text 事件转发"
```

---

### Task 4: 前端对话 UI + set_editor_text 注入 Composer

**Files:**
- Create: `packages/frontend/src/store/ext-dialog.ts`
- Create: `packages/frontend/src/components/ExtensionDialog.tsx`
- Modify: `packages/frontend/src/store/session.ts`（handleSDKEvent 加 `extension_dialog` / `extension_editor_text` 两个 case）
- Modify: `packages/frontend/src/components/Composer.tsx`（消费注入文本）
- Modify: `packages/frontend/src/App.tsx`（根部渲染 `<ExtensionDialog />`）
- Test: `packages/frontend/tests/ExtensionDialog.test.tsx`（新）、`packages/frontend/tests/store-session.test.ts`（追加事件分发用例）

**Interfaces:**
- Consumes: Task 3 的 `extension_dialog` / `extension_editor_text` 事件、`POST /api/extensions/dialog/respond`。
- Produces:
  - `useExtDialogStore`: `{ queue: ExtDialogRequest[]; enqueue(r): void; resolveCurrent(): ExtDialogRequest | undefined }`；`ExtDialogRequest = { requestId, sessionId?, method, title?, message?, options?, placeholder?, prefill? }`
  - session store 新字段 `editorTextInjection: Record<string, { text: string; ts: number }>`

- [ ] **Step 1: 写失败测试（组件 + store）**

`ExtensionDialog.test.tsx`（mock api-client，仿 Composer.test.tsx 模式）：

```tsx
// confirm：渲染 title/message，点「确认」POST { requestId, confirmed: true }，点「取消」POST { cancelled: true }
// select：渲染 options 按钮，点某项 POST { requestId, value: option }
// input：输入文本提交 POST { value }；取消 POST { cancelled: true }
// editor：textarea 带 prefill，提交 POST { value: 编辑后文本 }
```

`store-session.test.ts` 追加：`extension_dialog` 事件 → `useExtDialogStore` queue +1；`extension_editor_text` → `editorTextInjection[sessionId].text` 正确。

- [ ] **Step 2: 跑确认失败** → `cd packages/frontend && bun test --isolate tests/ExtensionDialog.test.tsx` → FAIL

- [ ] **Step 3: 实现**

1. `store/ext-dialog.ts`：

```ts
import { create } from "zustand";

export interface ExtDialogRequest {
  requestId: string;
  sessionId?: string;
  method: string;            // select | confirm | input | editor
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
}

// pi 扩展 dialog 请求队列：kernel 经 sdk:event(extension_dialog) 推入，
// ExtensionDialog 逐个展示；应答后 resolveCurrent 弹出下一个。
interface ExtDialogState {
  queue: ExtDialogRequest[];
  enqueue: (r: ExtDialogRequest) => void;
  resolveCurrent: () => void;
}

export const useExtDialogStore = create<ExtDialogState>((set) => ({
  queue: [],
  enqueue: (r) => set((s) => ({ queue: [...s.queue, r] })),
  resolveCurrent: () => set((s) => ({ queue: s.queue.slice(1) })),
}));
```

2. `session.ts` handleSDKEvent 加两个 case（放在 `extension_notify` case 附近）：

```ts
// pi 扩展 dialog 请求（select/confirm/input/editor）：入队，ExtensionDialog 弹窗应答
case "extension_dialog": {
  useExtDialogStore.getState().enqueue({
    requestId: (event as any).requestId,
    sessionId,
    method: (event as any).method,
    title: (event as any).title,
    message: (event as any).message,
    options: (event as any).options,
    placeholder: (event as any).placeholder,
    prefill: (event as any).prefill,
  });
  break;
}
// pi 扩展 setEditorText：替换 Composer 输入框内容（官方 fire-and-forget 语义）
case "extension_editor_text": {
  const text = (event as any).text;
  if (typeof text === "string") {
    set((s) => ({
      editorTextInjection: {
        ...s.editorTextInjection,
        [sessionId]: { text, ts: Date.now() },
      },
    }));
  }
  break;
}
```

（`editorTextInjection` 字段需在 SessionState 接口与初始值同步声明；`useExtDialogStore` import。）

3. `ExtensionDialog.tsx`：用现有 `Modal` 壳，按 method 渲染四种形态；应答统一：

```ts
const respond = async (fields: { value?: unknown; confirmed?: boolean; cancelled?: boolean }) => {
  const cur = useExtDialogStore.getState().queue[0];
  useExtDialogStore.getState().resolveCurrent();
  if (!cur) return;
  await api.post("/api/extensions/dialog/respond", { requestId: cur.requestId, ...fields }).catch(() => {});
};
```

- confirm：`title` + `message` + 「确认」`{confirmed:true}` /「取消」`{cancelled:true}`
- select：`title` + options 按钮列表 → `{value: option}`；Modal 关闭 → `{cancelled:true}`
- input：`title` + 单行输入（placeholder）→ `{value}`
- editor：`title` + textarea（defaultValue=prefill）→ `{value: 编辑后文本}`

4. `Composer.tsx` 消费注入（组件顶部加）：

```tsx
// pi 扩展 setEditorText：替换输入框内容并写入草稿（ts 去重，同一次注入只应用一次）
const injection = useSessionStore((s) => s.editorTextInjection[sessionId]);
const appliedInjectionTsRef = useRef(0);
useEffect(() => {
  if (injection && injection.ts !== appliedInjectionTsRef.current) {
    appliedInjectionTsRef.current = injection.ts;
    setText(injection.text);
    setSessionPrefs(sessionId, { text: injection.text });
  }
}, [injection, sessionId, setSessionPrefs]);
```

5. `App.tsx` 根组件渲染 `<ExtensionDialog />`（放 `<FilePreviewModal />` 旁）。

- [ ] **Step 4: 跑测试 + typecheck**

Run: `cd packages/frontend && bun test --isolate tests/ && cd ../.. && bun run typecheck`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/store/ext-dialog.ts packages/frontend/src/components/ExtensionDialog.tsx packages/frontend/src/store/session.ts packages/frontend/src/components/Composer.tsx packages/frontend/src/App.tsx packages/frontend/tests/
git commit -m "feat: 扩展 dialog 弹窗 UI + set_editor_text 注入 Composer（前端侧）"
```

---

### Task 5: demo 扩展补对话命令 + E2E 全链路验证

**Files:**
- Modify: `examples/ext-ui-bridge-demo/index.ts`（加 dialog / seteditor 子命令）
- Modify: `examples/ext-ui-bridge-demo/README.md`
- Modify: `packages/frontend/e2e/ext-ui-bridge-demo.spec.ts`（修 agentName + 回显断言反转 + 新增 dialog E2E）

**Interfaces:**
- Consumes: Task 1-4 全部产物。

- [ ] **Step 1: demo 扩展加命令**

`index.ts` 的 switch 加：

```ts
case "select":
  {
    const v = await ctx.ui.select("demo select：选一个", ["甲", "乙", "丙"]);
    ctx.ui.notify(`select 结果: ${String(v)}`, "info");
  }
  break;
case "confirm":
  {
    const ok = await ctx.ui.confirm("demo confirm", "确认继续吗？");
    ctx.ui.notify(`confirm 结果: ${ok}`, "info");
  }
  break;
case "input":
  {
    const v = await ctx.ui.input("demo input", "随便输入点什么");
    ctx.ui.notify(`input 结果: ${String(v)}`, "info");
  }
  break;
case "editor":
  {
    const v = await ctx.ui.editor("demo editor", "预填内容\n第二行");
    ctx.ui.notify(`editor 结果: ${String(v)}`, "info");
  }
  break;
case "seteditor":
  ctx.ui.setEditorText("来自 set_editor_text 的文本");
  break;
```

`getArgumentCompletions` 列表补 `"select","confirm","input","editor","seteditor"`。README 表格补对话子协议与 set_editor_text 两行。

- [ ] **Step 2: 修 E2E spec**

`ext-ui-bridge-demo.spec.ts`：
- 全部 `agentName: "dev"` 改 `agentName: "研发"`（getAgent 按 `<displayName>.md` 读；kernel 启动会把 name: dev 的 dev.md 迁移改名，第二次 prompt 触发 agent_missing——本次排查实测）。
- 「发送 /uidemo」用例断言**反转**为正常文本行为：用户气泡**出现**（`page.getByText("/uidemo notify")` 可见）且 notify 系统提示出现（命令确实执行）。
- 「/mcp」用例同理断言气泡出现。
- 新增 dialog 用例：

```ts
test("扩展 dialog 子协议：/uidemo select 弹窗应答后 notify 回显结果", async ({ page }) => {
  const sessionId = await spawnSession();
  // …进入会话视图、选模型（同前用例）…
  const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');
  await textbox.fill("/uidemo select");
  await page.keyboard.press("Escape");
  await page.getByTestId("composer-send").click();
  // 弹窗出现并应答
  await expect(page.getByText("demo select：选一个")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "乙", exact: true }).click();
  // handler 收到应答并 notify 结果
  await expect(
    page.locator('[data-testid^="custom-"]:has-text("select 结果: 乙")').first(),
  ).toBeVisible({ timeout: 20_000 });
});
```

- [ ] **Step 3: 跑 E2E**

Run（隔离端口，避免撞本机真实 kernel/前端）:

```bash
cd packages/frontend && PI_E2E=1 WA_PI_E2E_WS_PORT=19776 WA_PI_E2E_WEB_PORT=15180 WA_PI_WS_PORT=19776 WA_PI_WEB_PORT=15180 bun run e2e ext-ui-bridge-demo --reporter=line
```

Expected: 全 PASS；`test-results/` 无残留截图（error 时产生的 context 文件随成功清理/gitignore）。

- [ ] **Step 4: 全量回归 + CHANGELOG + Commit**

```bash
bun test                      # 四包全量
bun run typecheck
```

CHANGELOG.md 顶部追加一条「新增功能」：扩展 UI 子协议全量对接（dialog 四方法 + set_editor_text）+ 删除 tuiOnly 扫描 + 修本地扩展 Windows 加载，列影响范围。

```bash
git add -A && git commit -m "feat: demo 扩展补 dialog/seteditor 命令 + E2E 全链路验证"
```

---

## Self-Review 记录

- **Spec 覆盖**：dialog 四方法（Task 3/4）、set_editor_text（Task 3/4）、tuiOnly 删除（Task 2）、本地扩展加载（Task 1）、E2E（Task 5）。无遗漏。
- **类型一致性**：`ExtUiRegistry.register/respond/cancelAllForSession` 在 Task 3 三处调用一致；`extension_dialog` 事件字段（requestId/method/title/message/options/placeholder/prefill）Task 3 产出、Task 4 消费一致；`ExtDialogRequest` 无 timeout 字段（pi 侧自管，前端不消费）。
- **风险点**：Task 2 删 `tuiOnly` 字段后 typecheck 会暴露所有残留引用，以编译为准逐处清除。
