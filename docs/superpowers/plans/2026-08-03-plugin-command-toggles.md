# 插件命令级启停管理 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把"自动扫描决定命令显示"改为"用户手动控制命令启停"——插件页弹窗逐命令开关、关闭命令发送时静默降级、extension_notify 消息 20s 自动消失；完全移除 `_commandsCache`（5min TTL）与 `scanCache` 缓存机制。

**架构：** kernel 侧 `getCommands()` 实时拉取（无缓存），`filterTuiCommands` 由"过滤删除"改为"附加标记全量返回"；发送端用 `_commandsFetched` 布尔标记 + `disabledCommandNames` 集合做静默降级；settings.json 新增 `waPiCommandToggles`（key=裸包名）；前端插件页新增命令弹窗（逐命令开关），/ 菜单只显示已开启命令。

**技术栈：** bun（kernel 测试 bun:test）、Vitest（前端组件测试）、React+zustand、Playwright E2E。

**规格：** `docs/superpowers/specs/2026-08-03-plugin-command-toggles-design.md`

---

## 任务 1：shared 类型扩展（CommandInfo 增加字段）

**文件：**

- 修改：`packages/shared/src/commands.ts`

- [ ] **步骤 1：编写失败的测试**

`packages/shared` 是否有测试？先查目录。若无则跳过本任务的测试步骤（类型定义由 kernel/前端测试间接覆盖）。

- [ ] **步骤 2：扩展 CommandInfo**

```ts
export interface CommandInfo {
  name: string;            // 命令名（不含 / 前缀）
  description?: string;
  source: CommandSource;
  // 新增（仅 extension 来源填充）：
  packageName?: string;    // 插件包名（裸包名，如 @narumitw/pi-goal，对应 waPiCommandToggles key）
  enabled?: boolean;       // 命令开关状态（缺省 false）
  tuiOnly?: boolean;       // TUI-only 检测标记
}
```

- [ ] **步骤 3：验证构建**

运行：`bun run --filter @wa-pi/shared build`（或 `bun tsc --noEmit packages/shared`）
预期：类型通过

- [ ] **步骤 4：Commit**

```bash
git add packages/shared/src/commands.ts
git commit -m "feat(shared): CommandInfo 增加 packageName/enabled/tuiOnly 字段"
```

## 任务 2：tui-command-filter.ts 改造（标记而非删除 + 改名 + 删 scanCache）

**文件：**

- 修改：`packages/kernel/src/tui-command-filter.ts`
- 测试：`packages/kernel/tests/tui-command-filter.test.ts`

- [ ] **步骤 1：读当前文件确认行号**

运行：`cat packages/kernel/src/tui-command-filter.ts`
预期：确认 `scanCache` 在 44/66/102 行、`tuiOnlyCommandNames` 在 120-126 行

- [ ] **步骤 2：删除 scanCache 与缓存逻辑**

删除：

```ts
// 扫描结果缓存：包根 → 是否 TUI-only。已装扩展运行期不会变化；运行时新装的
// 扩展是新路径自然 miss。同路径升级扩展需重启 kernel 后才会重新扫描。
const scanCache = new Map<string, boolean>();
```

```ts
 const cached = scanCache.get(root);
 if (cached !== undefined) return cached;
```

```ts
 scanCache.set(root, result);
```

- [ ] **步骤 3：`isTuiOnlyExtension` 不再依赖缓存**

确认函数体只保留 `walk` 扫描逻辑，`return result;` 结尾。

- [ ] **步骤 4：改名 + 语义变更**

```ts
// 被关闭的扩展命令名集合：prompt 路径据此把这类命令降级为普通文本
// （发送给 pi 前加前导空格，绕过 pi 的 / 命令分发），使其像未知命令一样进入大模型。
const disabledCommandNames = new Set<string>();

/** 判定命令名是否已关闭（依赖 getCommands 至少拉取过一次） */
export function isCommandDisabled(name: string): boolean {
 return disabledCommandNames.has(name);
}

/** 清空降级集合（toggle 命令开关后调用，下次拉取重新填充） */
export function resetDisabledCommands(): void {
 disabledCommandNames.clear();
}
```

- [ ] **步骤 5：`filterTuiCommands` 改为标记而非删除**

```ts
/** 给命令附加 TUI-only 标记；关闭的命令名登记进降级集合；全量返回 */
export function filterTuiCommands(commands: RawCommandInfo[]): CommandInfo[] {
 return commands.map((cmd) => {
  if (cmd.source !== "extension") return cmd;
  const info = cmd.sourceInfo;
  if (!info?.path) return cmd;
  const tuiOnly = isTuiOnlyExtension(info.path, info.baseDir);
  return { ...cmd, tuiOnly };
 });
}
```

- [ ] **步骤 6：更新测试**

修改 `packages/kernel/tests/tui-command-filter.test.ts`：

- `filterTuiCommands: 过滤 TUI-only 扩展的命令，保留其余` → 改为 `filterTuiCommands: TUI-only 命令不再删除，附加 tuiOnly: true 标记`
- 断言从"结果不含 mcp-auth"改为"结果含 mcp-auth 且 tuiOnly === true"
- 新增 `resetDisabledCommands` 测试

- [ ] **步骤 7：运行测试**

运行：`cd packages/kernel && bun test tests/tui-command-filter.test.ts`
预期：全部通过

- [ ] **步骤 8：Commit**

```bash
git add packages/kernel/src/tui-command-filter.ts packages/kernel/tests/tui-command-filter.test.ts
git commit -m "feat(kernel): tui-command-filter 改为标记而非删除，tuiOnlyCommandNames 改名 disabledCommandNames，删除 scanCache"
```

## 任务 3：agent-manager 删除 _commandsCache + 实时化 +_commandsFetched

**文件：**

- 修改：`packages/kernel/src/agent-manager.ts`

- [ ] **步骤 1：删除缓存字段与查询**

删除（约 1363-1364）：

```ts
 /** 命令缓存（全局，插件命令对所有 agent 一致，5min TTL） */
 private _commandsCache: { commands: CommandInfo[]; ts: number } | null = null;
```

删除 `getCommands()` 第 1 步缓存查询（约 1303-1305）：

```ts
  // 1. 查全局缓存（5min TTL，插件命令对所有 agent 一致）
  const cached = this._commandsCache;
  if (cached && Date.now() - cached.ts < 5 * 60_000) {
   return cached.commands;
  }
```

- [ ] **步骤 2：`_fetchAndCacheCommands` 改名 `_fetchCommands` + 去写缓存**

```ts
 /** 从 pi 进程拉取命令清单：附加 TUI 标记、登记关闭命令后返回（不缓存） */
 private async _fetchCommands(client: RpcClient): Promise<CommandInfo[]> {
  const { commands } = await client.getCommands();
  const cmds = filterTuiCommands((commands ?? []) as RawCommandInfo[]);
  return cmds;
 }
```

同步更新所有 `this._fetchAndCacheCommands(` 调用为 `this._fetchCommands(`（约 4 处：1312/1322/1330/1356）。

- [ ] **步骤 3：markAllDirty/markSkillsDirty 删置空行**

删除 `markAllDirty()` 内的 `this._commandsCache = null;`（约 277）与 `markSkillsDirty()` 内的 `this._commandsCache = null;`（约 286）。

- [ ] **步骤 4：新增 _commandsFetched 标记**

类字段区新增：

```ts
 /** 是否已拉取过命令清单（发送端降级集合填充标记；toggle 后重置） */
 private _commandsFetched = false;
```

- [ ] **步骤 5：发送端降级改用 _commandsFetched + isCommandDisabled**

替换（约 1064-1073）：

```ts
  // 命令清单未拉取过时先拉一次，填充 disabledCommandNames（无缓存，仅首次/变更后拉取）。
  if (text.startsWith("/")) {
   if (!this._commandsFetched) {
    await this._fetchCommands(handle.client).catch(() => []);
    this._commandsFetched = true;
   }
   const sp = text.indexOf(" ");
   const cmdName = sp === -1 ? text.slice(1) : text.slice(1, sp);
   if (isCommandDisabled(cmdName)) text = ` ${text}`;
  }
```

- [ ] **步骤 6：更新 import**

`tui-command-filter.ts` 导入改名：`isTuiOnlyCommand` → `isCommandDisabled`。

- [ ] **步骤 7：新增命令开关 API 方法**

新增方法（供 routes 调用）：

```ts
 /** 读取某插件命令开关状态（缺省 false） */
 async getCommandToggle(packageName: string, command: string): Promise<boolean> { ... }

 /** 切换命令开关：写 settings + 重置降级集合 */
 async toggleCommand(packageName: string, command: string, enabled: boolean): Promise<void> {
  // 1. 读 settings.waPiCommandToggles
  // 2. 写 waPiCommandToggles[packageName][command] = enabled
  // 3. resetDisabledCommands() + this._commandsFetched = false
 }
```

（具体 settings 读写参照任务 4 的 ExtensionManager 扩展。）

- [ ] **步骤 8：运行测试**

运行：`cd packages/kernel && bun test tests/agent-manager.test.ts`
预期：现有测试通过；若有用例断言 `_commandsCache` 行为则更新。

- [ ] **步骤 9：Commit**

```bash
git add packages/kernel/src/agent-manager.ts
git commit -m "feat(kernel): 删除 _commandsCache 5min TTL 缓存，getCommands 实时化，发送端用 _commandsFetched + isCommandDisabled"
```

## 任务 4：ExtensionManager 读写 waPiCommandToggles

**文件：**

- 修改：`packages/kernel/src/extension-manager.ts`
- 测试：`packages/kernel/tests/extension-manager.test.ts`

- [ ] **步骤 1：扩展 settings 接口**

```ts
interface ExtensionSettings {
  ...
  /** 命令级开关：裸包名 → { 命令名 → 是否启用 }；缺省 = 关 */
  waPiCommandToggles?: Record<string, Record<string, boolean>>;
}
```

- [ ] **步骤 2：新增读写方法**

```ts
 /** 读取命令开关状态（缺省 false） */
 async getCommandToggle(packageName: string, command: string): Promise<boolean> {
  const settings = await this.readSettings();
  return settings.waPiCommandToggles?.[packageName]?.[command] ?? false;
 }

 /** 设置命令开关状态并持久化 */
 async setCommandToggle(packageName: string, command: string, enabled: boolean): Promise<void> {
  const settings = await this.readSettings();
  const toggles = settings.waPiCommandToggles ?? {};
  const pkg = toggles[packageName] ?? {};
  pkg[command] = enabled;
  toggles[packageName] = pkg;
  await this.writeSettings({ ...settings, waPiCommandToggles: toggles });
 }

 /** 读取全部命令开关状态 */
 async getCommandToggles(): Promise<Record<string, Record<string, boolean>>> {
  const settings = await this.readSettings();
  return settings.waPiCommandToggles ?? {};
 }
```

- [ ] **步骤 3：编写测试**

`packages/kernel/tests/extension-manager.test.ts` 新增：

- 缺省返回 false
- setCommandToggle 后持久化（重读验证）
- getCommandToggles 返回全部

- [ ] **步骤 4：运行测试**

运行：`cd packages/kernel && bun test tests/extension-manager.test.ts`
预期：全部通过

- [ ] **步骤 5：Commit**

```bash
git add packages/kernel/src/extension-manager.ts packages/kernel/tests/extension-manager.test.ts
git commit -m "feat(kernel): ExtensionManager 读写 waPiCommandToggles（裸包名 key，缺省关闭）"
```

## 任务 5：新 API 路由（GET /api/extensions/commands + POST toggle）

**文件：**

- 修改：`packages/kernel/src/routes/extensions.ts`
- 测试：`packages/kernel/tests/routes-extensions-commands.test.ts`（新增）

- [ ] **步骤 1：新增路由**

```ts
r.add("GET", "/api/extensions/commands", async () =>
  callApi({ type: "extension:commands:list" })
);

r.add("POST", "/api/extensions/commands/toggle", async (req) => {
  const b = await readJsonBody(req);
  if (!b?.packageName || !b?.command || typeof b.enabled !== "boolean") {
    return new Response(JSON.stringify({ error: "参数缺失或类型错误" }), { status: 400 });
  }
  return callApi({ type: "extension:commands:toggle", ...b });
});
```

- [ ] **步骤 2：ws-server 处理器**

在 ws-server 增加 `extension:commands:list` 与 `extension:commands:toggle` handler：

- list：借活跃进程拉命令（复用 agentManager.getCommands 或新方法）+ 合并开关状态（extensionManager.getCommandToggles）→ 返回 `{ commands: CommandInfo[] }`
- toggle：调 extensionManager.setCommandToggle → 重置降级集合 → 返回成功

- [ ] **步骤 3：编写接口测试**

`packages/kernel/tests/routes-extensions-commands.test.ts`：

- GET 返回 `{ commands: [] }` 结构（mock agentManager/extensionManager）
- POST 成功路径（正确 body → 调 setCommandToggle）
- POST 非法参数（缺 packageName / enabled 非 boolean → 400）

- [ ] **步骤 4：运行测试**

运行：`cd packages/kernel && bun test tests/routes-extensions-commands.test.ts`
预期：全部通过

- [ ] **步骤 5：Commit**

```bash
git add packages/kernel/src/routes/extensions.ts packages/kernel/src/ws-server.ts packages/kernel/tests/routes-extensions-commands.test.ts
git commit -m "feat(kernel): 新增 GET /api/extensions/commands + POST /api/extensions/commands/toggle"
```

## 任务 6：前端命令弹窗（CommandListModal）

**文件：**

- 创建：`packages/frontend/src/components/settings/CommandListModal.tsx`
- 修改：`packages/frontend/src/components/settings/ExtensionSection.tsx`
- 测试：`packages/frontend/src/components/settings/CommandListModal.test.tsx`（新增）

- [ ] **步骤 1：编写失败的组件测试**

```tsx
// 渲染命令列表、TUI 徽标、开关切换调用 toggle API
```

- [ ] **步骤 2：实现 CommandListModal**

```tsx
// props: { packageName, onClose }
// 1. 打开时 GET /api/extensions/commands → 按 packageName 过滤命令
// 2. 顶部提示条："注意：TUI 命令不被支持"
// 3. 每条命令：/name + description + (tuiOnly && "⚠ TUI 命令不被支持") + 开关
// 4. 开关切换：POST /api/extensions/commands/toggle 即切即存
// 5. 空状态："该插件未注册斜杠命令"
// 6. 复用 ui/Modal.tsx 容器
```

- [ ] **步骤 3：ExtensionSection 加按钮**

已安装插件卡片操作区新增：

```tsx
<button
  className="px-2 py-1 text-xs rounded-sm font-medium"
  style={{ background: "var(--surface-elevated)", color: "var(--text-primary)", border: "1px solid var(--hairline)" }}
  onClick={() => setCommandModalPkg(pkg.name)}
  data-testid={`ext-commands-${pkg.name}`}
>
  ⌘ 附加命令
</button>
```

管理 `commandModalPkg` state，渲染 `<CommandListModal>`。

- [ ] **步骤 4：运行测试**

运行：`cd packages/frontend && bunx vitest run src/components/settings/CommandListModal.test.tsx`
预期：通过

- [ ] **步骤 5：Commit**

```bash
git add packages/frontend/src/components/settings/CommandListModal.tsx packages/frontend/src/components/settings/ExtensionSection.tsx packages/frontend/src/components/settings/CommandListModal.test.tsx
git commit -m "feat(frontend): 插件页新增命令弹窗（逐命令开关 + TUI 标记）"
```

## 任务 7：/ 菜单按 enabled 过滤

**文件：**

- 修改：`packages/frontend/src/store/commands.ts`
- 测试：`packages/frontend/src/store/commands.test.ts`（新增或更新）

- [ ] **步骤 1：编写失败的测试**

```ts
// / 菜单只显示 enabled === true 的 extension 命令；prompt/builtin 不受影响
```

- [ ] **步骤 2：修改 store 过滤**

```ts
set({
  commands: all.filter((c) => {
    if (c.source === "skill") return false;          // 技能走 $ 菜单
    if (c.source === "extension") return c.enabled === true;  // 插件命令只显示已开启
    return true;                                      // prompt/builtin 不受影响
  }),
  loading: false,
});
```

- [ ] **步骤 3：运行测试**

运行：`cd packages/frontend && bunx vitest run src/store/commands.test.ts`
预期：通过

- [ ] **步骤 4：Commit**

```bash
git add packages/frontend/src/store/commands.ts packages/frontend/src/store/commands.test.ts
git commit -m "feat(frontend): / 菜单只显示已开启的插件命令"
```

## 任务 8：extension_notify 20s 自动消失

**文件：**

- 修改：`packages/frontend/src/store/session.ts`
- 测试：`packages/frontend/src/store/session.test.ts`（新增或更新）

- [ ] **步骤 1：编写失败的测试**

```ts
// extension_notify 插入后，20s 后自动从 messagesBySession 移除
// （用 vi.useFakeTimers 快进 20s 验证）
```

- [ ] **步骤 2：修改 extension_notify case**

插入消息后记录 timestamp 并 `setTimeout(20_000)` 移除：

```ts
case "extension_notify": {
  const msg = (event as any).message;
  if (typeof msg === "string") {
    const timestamp = Date.now();
    set((s) => { ...插入带 timestamp 的消息... });
    setTimeout(() => {
      set((s) => {
        const list = s.messagesBySession[sessionId] ?? [];
        const next = list.filter((m) => !(m.message as any).timestamp === timestamp
          && (m.message as any).customType === "extension_notify");
        if (next.length === list.length) return s;
        return { messagesBySession: { ...s.messagesBySession, [sessionId]: next } };
      });
    }, 20_000);
  }
  break;
}
```

（注意去重逻辑与新 timestamp 兼容——去重比较仍按最后一条 content。）

- [ ] **步骤 3：运行测试**

运行：`cd packages/frontend && bunx vitest run src/store/session.test.ts`
预期：通过

- [ ] **步骤 4：Commit**

```bash
git add packages/frontend/src/store/session.ts packages/frontend/src/store/session.test.ts
git commit -m "feat(frontend): extension_notify 系统消息 20s 后自动消失"
```

## 任务 9：旧名残留回归检查

**文件：**

- 全局

- [ ] **步骤 1：grep 旧名**

运行：

```bash
cd /path/to/HiAgent
grep -rn "_commandsCache\|tuiOnlyCommandNames\|isTuiOnlyCommand\|scanCache" packages/ --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v dist
```

预期：无输出（除规格文档中"改名说明"语境）

- [ ] **步骤 2：全量测试回归**

运行：`cd packages/kernel && bun test`（预期 kernel 测试全绿）
运行：`cd packages/frontend && bunx vitest run`（预期相关测试通过；已知预存在 717 个失败与业务无关，对比新增用例均绿）

- [ ] **步骤 3：更新 CHANGELOG.md**

在根目录 `CHANGELOG.md` 顶部新增条目（时间倒序）：插件命令级启停管理功能 + 缓存移除。

- [ ] **步骤 4：Commit**

```bash
git add CHANGELOG.md
git commit -m "chore: CHANGELOG 记录插件命令级启停管理与缓存移除"
```

## 任务 10：E2E 验证

**文件：**

- 创建：`packages/desktop/tests/e2e/plugin-command-toggles.spec.ts`（或现有 E2E 目录）

- [ ] **步骤 1：编写 E2E**

覆盖：

1. 设置页打开 pi-goal 命令弹窗 → 开启 `/goal` → `/` 菜单出现 `/goal`
2. 关闭 `/goal` → `/` 菜单消失 → 手动输入 `/goal xxx` 发送 → LLM 收到普通文本（断言无命令执行副作用）
3. extension_notify 消息 → 20s 后自动从界面消失

- [ ] **步骤 2：运行 E2E**

运行：`bunx playwright test packages/desktop/tests/e2e/plugin-command-toggles.spec.ts`
预期：通过（失败则回到对应任务修复）

- [ ] **步骤 3：清理截图**

删除测试产生的所有截图文件（若测试配置落盘）。

- [ ] **步骤 4：Commit**

```bash
git add packages/desktop/tests/e2e/plugin-command-toggles.spec.ts
git commit -m "test(e2e): 插件命令级启停管理 E2E"
```

## 自检记录

**规格覆盖度：** 规格 §4.1→任务2；§4.2→任务2/4；§4.3→任务1/3；§4.4→任务3；§4.5→任务5；§5.1/5.2→任务6；§5.3→任务7；§5.4→任务8；§7 文件结构→对应任务；§8 测试计划→任务 2-8/10；§9 Non-goals→无对应任务（正确，明确不做）。

**占位符扫描：** 任务 3 步骤 7 中 `getCommandToggle/toggleCommand` 依赖任务 4 的 ExtensionManager 方法——任务 4 已定义同名方法，实现时 agent-manager 调用 extensionManager 或经 ws-server 桥接（以最终 ws-server handler 实现为准，见任务 5 步骤 2）。

**类型一致性：** `packageName` 全链路统一为裸包名（`@narumitw/pi-goal`）；`isCommandDisabled`/`disabledCommandNames`/`resetDisabledCommands`/`_fetchCommands`/`_commandsFetched` 命名在任务 2/3 中一致；API body `{ packageName, command, enabled }` 在任务 5/6 中一致。
