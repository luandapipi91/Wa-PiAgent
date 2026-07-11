# pi-lens 插件菜单 + 启用/禁用 设计

- 日期：2026-07-11
- 状态：设计稿（待评审）
- 关联：[2026-07-09-skills-management-design.md](./2026-07-09-skills-management-design.md)（技能管理，本设计镜像其结构）、[2026-07-08-pi-sdk-refactor-design.md](./2026-07-08-pi-sdk-refactor-design.md)（SDK ResourceLoader / additionalExtensionPaths）

## 1. 目标

1. 把第三方 Pi 扩展 **pi-lens**（实时代码反馈：LSP / lint / 类型检查 / 结构分析）纳入 hiagent。
2. 在「系统设置」里新增 **「插件」菜单**，列出可选插件，当前仅有 pi-lens。
3. 用户可在面板上 **启用 / 禁用 pi-lens**，切换可热生效（不打断正在运行的回合）。
4. 顺带把现有 **技能** 的 reload 时机统一成同一套 deferred 机制（与插件一致）。

核心扩展 pi-intercom（多 agent 通信）、pi-web-access（web 工具，被 `DEFAULT_AGENT_TOOLS` 引用）、provider-extension 维持现状：始终通过 `additionalExtensionPaths` 常驻加载，**不在插件面板出现、不可切换**。

## 2. 关键技术结论（已从 SDK 0.80.3 源码核实）

- `DefaultResourceLoader.reload()` 内会先 `settingsManager.reload()`（重读 `settings.json`），随后 `packageManager.resolve()` 重新解析 `globalSettings.extensions`（package-manager.js:1864）与 `globalSettings.packages`。**即「settings.json 驱动的扩展源」每次 reload 都会被重新求值。**
- `SettingsManager` 暴露 `getExtensions()` / `setExtensions(paths)`，对应 `settings.json` 的 **`extensions`** 字段（已解析入口文件路径数组，**无需 `pi install`**）。
- `reload()` 读取的 `this.additionalExtensionPaths` 是构造期固定字段（resource-loader.js:233），**reload 不会重新评估 additionalExtensionPaths 列表本身**。所以通过 `additionalExtensionPaths` 注入的扩展无法靠 reload 增删；而通过 `settings.extensions` 注入的扩展可以。
- hiagent 历史：旧版本曾把扩展本地路径写进 `settings.json.packages`，后改为 `additionalExtensionPaths` 纯内存注入，并以 `migrateSettingsPackages()` 清空 `packages` 以避免双重加载（见 `extensions.ts`）。**双重加载只会发生在「同一扩展同时出现在 packages/extensions 与 additionalExtensionPaths」时。** 本设计让 pi-lens 仅由 `settings.extensions` 加载、绝不进 `additionalExtensionPaths`，故无双重加载风险。`migrateSettingsPackages` 只清 `packages`、不动 `extensions`，无冲突。

## 3. 机制总览

| 扩展 | 加载方式 | 可切换 | 生效时机 |
|---|---|---|---|
| pi-intercom / pi-web-access / provider-extension（核心） | `additionalExtensionPaths`（内存，现状不变） | 否（锁定常开） | — |
| **pi-lens（可选）** | **`settings.json.extensions`（SDK 原生）** | **是** | **deferred：该会话下次被使用时 reload** |

**reload 时机统一对照：**

| 子系统 | 现状 | 目标 |
|---|---|---|
| 技能 | toggle → **立即** `reloadAllSessions()`（ws-server.ts:494/502/513） | toggle → `markAllDirty()`（deferred） |
| provider | 改 → 不 reload，靠新建会话自然生效（ws-server.ts:458-470） | 维持现状不动 |
| pi-lens（新） | — | toggle → 写 `settings.extensions` + `markAllDirty()`（deferred） |

「deferred」= 纯惰性 + 切换会话时检查：新建会话天然读到最新设置；已存在的缓存会话在下次 `ensureStarted`（切换过去 / 下次使用）时若被标脏则 `session.reload()` 一次并清脏。

## 4. Kernel 改动

### 4.1 `extensions.ts`

- 导出现有 `resolveExtensionEntryFile`（供新 `ExtensionManager` 复用；当前为模块私有）。
- `PKG_EXTENSIONS` **保持不变**（仅 pi-intercom、pi-web-access），**不加入 pi-lens**。
- 新增可选插件静态注册表：

```ts
export interface OptionalExtensionDef {
  id: string;            // 稳定标识，前端用
  package: string;       // npm 包名
  displayName: string;
  description: string;
  defaultEnabled: boolean;
}

export const OPTIONAL_EXTENSIONS: readonly OptionalExtensionDef[] = [
  {
    id: "pi-lens",
    package: "pi-lens",
    displayName: "Pi Lens",
    description: "实时代码反馈：LSP 诊断、lint、类型检查、结构分析",
    defaultEnabled: true,
  },
];
```

### 4.2 新增 `extension-manager.ts`（镜像 `skill-manager.ts`）

职责：读写 `HIAGENT_DIR/settings.json` 的 `extensions` 字段；解析可选插件入口路径；提供 list / toggle。

```ts
export class ExtensionManager {
  constructor(private dataDir: string) {}

  private async readSettings(): Promise<{ extensions?: string[]; [k: string]: unknown }> { /* 同 SkillManager */ }
  private async writeSettings(s): Promise<void> { /* 保留其他字段，不可变更新 */ }

  /** 解析插件入口绝对路径（复用 extensions.ts 的 resolveExtensionEntryFile）。 */
  private resolvePath(pkg: string): string { ... }

  /** 读取插件 version（取自其 package.json），失败返回 undefined。 */
  private readVersion(pkg: string): string | undefined { ... }

  /**
   * 列出全部可选插件及其启用态。
   * 首启播种：若某 defaultEnabled 插件的入口路径不在 settings.extensions 中，补写并持久化。
   */
  async list(): Promise<{ plugins: ExtensionPluginInfo[] }> { ... }

  /**
   * 启用/禁用插件：把对应入口路径不可变地加入/移出 settings.extensions。
   */
  async toggle(id: string, enabled: boolean): Promise<void> { ... }
}
```

约束：
- 所有写操作走 spread 不可变更新（遵循项目 immutability 规约）。
- 入口解析复用 `resolveExtensionEntryFile`（pi-lens 的 `package.json` 声明 `pi.extensions: ["./dist/index.js"]`，命中优先级 1）。
- `toggle` 对未知 `id` 抛错；对路径不存在（包未安装）抛清晰错误。

### 4.3 `agent-manager.ts` — 共用 deferred reload

新增脏标记集合与标记方法；在 `ensureStarted` 拿到/确认 session 后做 reload 检查。

```ts
private dirty = new Set<string>();

/** 标记当前所有活跃会话为待 reload（技能/扩展配置变更后调用）。 */
markAllDirty(): void {
  for (const id of this.sessions.keys()) this.dirty.add(id);
}

// ensureStarted 内，确认/创建 session 之后、返回前：
if (this.dirty.has(sessionId)) {
  try {
    await (session as any).reload();   // 重读 settings.extensions / disabledSkills
  } catch (err) {
    console.error(`[kernel] session ${sessionId} deferred reload 失败:`, err);
  }
  this.dirty.delete(sessionId);
}
```

要点：
- 新建会话（首次 ensureStarted）天然读到最新设置，不在 `dirty` 集合中，无需 reload。
- `disposeSession` 时同步从 `dirty` 删除该 id，防泄漏。
- 不打断正在 streaming 的会话：reload 发生在该会话下次被 `ensureStarted`（即用户主动再发消息）时。
- **移除现 `reloadAllSessions()`**：重构后 ws-server 不再调用它（见 4.4），确认无其他引用后删除。

### 4.4 `ws-server.ts` — 新增扩展 handler + 改造技能 handler

新增（镜像 skill 三个 handler）：

```ts
case "extension:list": {
  const { plugins } = await this.opts.extensionManager.list();
  reply({ type: "extension:list", plugins });
  break;
}
case "extension:toggle": {
  await this.opts.extensionManager.toggle(event.id, event.enabled);
  this.opts.agentManager.markAllDirty();          // deferred，不立即 reload
  const { plugins } = await this.opts.extensionManager.list();
  this.broadcast({ type: "extension:changed", plugins });
  break;
}
```

改造现有技能 handler（`skill:toggle` / `skillDir:add` / `skillDir:remove`）：把 `await this.opts.agentManager.reloadAllSessions();` 全部替换为 `this.opts.agentManager.markAllDirty();`。

### 4.5 `index.ts` 启动流程

- 构造 `extensionManager` 并注入 `WsServer` opts（与 `skillManager` 并列）。
- 启动时调用一次 `await extensionManager.list()`，触发首启播种（默认启用 pi-lens）。

### 4.6 `packages/kernel/package.json`

- `dependencies` 增加 `pi-lens`（约 15.5 MB，含 tree-sitter WASM；已知情同意）。

## 5. Shared 类型（新文件 `packages/shared/src/extensions.ts`，镜像 `skills.ts`）

```ts
export interface ExtensionPluginInfo {
  id: string;
  displayName: string;
  description: string;
  enabled: boolean;
  version?: string;
}

// 前端 → kernel
export interface ExtensionListEvent { type: "extension:list"; }
export interface ExtensionToggleEvent { type: "extension:toggle"; id: string; enabled: boolean; }

// kernel → 前端
export interface ExtensionListResult { type: "extension:list"; plugins: ExtensionPluginInfo[]; }
export interface ExtensionChangedEvent { type: "extension:changed"; plugins: ExtensionPluginInfo[]; }
```

在 `packages/shared/src/types.ts`：
- import 上述类型。
- `WSClientEvent` 联合加 `ExtensionListEvent | ExtensionToggleEvent`。
- `WSServerEvent` 联合加 `ExtensionListResult | ExtensionChangedEvent`。

## 6. Frontend 改动

### 6.1 `store/extensions.ts`（镜像 `store/skills.ts`）

```ts
interface ExtensionsState {
  plugins: ExtensionPluginInfo[];
  load: () => void;
  setAll: (data: { plugins: ExtensionPluginInfo[] }) => void;
  togglePlugin: (id: string, enabled: boolean) => void;
}
```
- `load()` → `send({ type: "extension:list" })`。
- `togglePlugin` → `send({ type: "extension:toggle", id, enabled })`。

### 6.2 `components/settings/ExtensionSection.tsx`（镜像 `SkillSection.tsx`）

- 遍历 `plugins`，每行：checkbox（checked=enabled）+ displayName + version + 描述 + 禁用态灰显。
- checkbox onChange → `togglePlugin(id, !enabled)`。

### 6.3 `SettingsModal.tsx`

- 左侧 nav 增加 **「插件」** 按钮（`activeSection === "plugins"` 高亮）。
- 右侧内容区：`activeSection === "plugins" && <ExtensionSection />`。

### 6.4 `store/settings.ts`

- `activeSection` 类型联合增加 `"plugins"`。

### 6.5 `App.tsx`

- onMessage 增加：
  - `"extension:list"` → `useExtensionsStore.getState().setAll(e)`。
  - `"extension:changed"` → `useExtensionsStore.getState().setAll(e)`。
- 启动 `useEffect` 内增加 `useExtensionsStore.getState().load()`（与 skills/providers 并列）。

## 7. 测试

### 7.1 Kernel

- `extension-manager.test.ts`（隔离临时目录）：
  - `list()` 默认播种：空 settings → pi-lens 路径被写入 `extensions` 且 enabled=true。
  - `toggle("pi-lens", false)` → 路径从 `extensions` 移除；`list()` enabled=false。
  - `toggle("pi-lens", true)` → 路径回到 `extensions`。
  - 不可变更新：其他字段（如 `disabledSkills`）不被破坏。
  - 未知 id → 抛错。
- `extensions.test.ts` 增断言：`buildAdditionalExtensionPaths()` **不含** pi-lens 路径（仅核心扩展 + provider-extension）。
- `agent-manager` deferred reload（用可注入的 fake session）：`markAllDirty()` 后，对脏会话 `ensureStarted` 触发一次 `reload()` 并清脏；新会话不 reload；非脏会话不 reload。
- `ws-server` 测试：`extension:toggle` 调用 `extensionManager.toggle` + `agentManager.markAllDirty` + 广播 `extension:changed`；技能 handler 改调用 `markAllDirty`（而非 reloadAllSessions）。

### 7.2 Frontend

- `ExtensionSection.test.tsx`：渲染插件行；点 checkbox 发 `extension:toggle`；禁用态灰显。
- `store/extensions.test.ts`：load/setAll/togglePlugin。
- `SettingsModal` 测试：nav 切到「插件」渲染 `ExtensionSection`。

## 8. 边界与风险

- **双重加载**：pi-lens 仅由 `settings.extensions` 加载，绝不进 `additionalExtensionPaths`；核心扩展继续走 `additionalExtensionPaths`。两机制对同一扩展互斥。
- **`migrateSettingsPackages`** 只清 `packages`，不动 `extensions`，无冲突。
- **deferred reload 的可见性**：toggle 后，当前正在 streaming 的会话不打断；空闲的已启会话在下次使用时同步；再不被使用的会话保持旧态（可接受）。
- **包体积**：pi-lens 15.5 MB 作为 kernel 依赖引入；如未来要按需安装，可再评估改为运行时 `pi install`。
- **入口解析**：pi-lens `package.json` 声明 `pi.extensions`，现有 `resolveExtensionEntryFile` 命中；若未来 SDK 改 manifest 结构，解析会 fail-fast。
- **reload 失败**：单个会话 reload 失败仅记录日志、不阻断其他会话（与现有 `reloadAllSessions` 容错一致）。

## 9. 不在范围内（YAGNI）

- 不把核心扩展（pi-intercom / pi-web-access）做成可切换或显示在面板。
- 不引入「按 agent 粒度」启用/禁用插件（扩展加载是会话级全局的）。
- 不迁移所有扩展到 `settings.extensions`（保持核心扩展现状，避免大范围重构）。
- 不做插件市场 / 在线安装 UI（插件清单为代码内静态注册表）。

## 10. 实现顺序（粗）

1. shared 类型 + WS 联合。
2. kernel：`extension-manager.ts` + 测试；`extensions.ts` 导出解析函数与注册表。
3. kernel：`agent-manager` deferred reload + 移除 `reloadAllSessions`；`ws-server` 扩展 handler + 技能 handler 改造 + 测试。
4. kernel：`package.json` 加 pi-lens 依赖；`index.ts` 注入 + 播种。
5. frontend：store + section + modal nav + App 事件 + 测试。
