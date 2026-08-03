# 插件命令级启停管理设计

**日期：** 2026-08-03
**状态：** 待审查
**关联问题：** pi-goal 被 tui-command-filter 自动过滤误伤，`/goal` 无法在 `/` 菜单使用（ff08ffe 引入）

## 1. 背景与目标

pi-goal 插件（`@narumitw/pi-goal`）被 `tui-command-filter.ts` 的扩展级静态扫描误判为 TUI-only，其全部命令被自动从 `/` 菜单过滤。经调研确认：pi-goal 实际自带 `ctx.mode !== "tui"` 运行时降级，RPC 模式下 `status / pause / resume / clear / edit / <目标>` 等路径完全可用，是静态扫描无法识别的"假阳性"。

**目标：把"自动扫描决定命令显示"改为"用户手动控制命令启停"。**

- 插件页每条命令可手动启用/关闭
- 命令默认全部关闭（用户明确选择）
- 关闭的命令发送时静默降级（复用现有 tuiOnlyCommandNames 加前导空格逻辑）
- TUI-only 检测保留，仅作弹窗标记提示，不再自动过滤显示
- 顺带增强：现有 `extension_notify` 系统消息（如 `—— MCP: 5 servers connected (234 tools) ——`）显示 20s 后自动从聊天界面隐藏

## 2. 需求决策记录

| 决策点 | 决定 | 理由 |
| --- | --- | --- |
| 命令默认状态 | **全部默认不开启** | 用户明确选择；开启由用户主动操作 |
| 关闭命令的发送行为 | **纯静默降级**（加前导空格 → 普通文本给 LLM，无提示） | 用户明确选择；复用现有 `tuiOnlyCommandNames` 逻辑 |
| 前端 Composer 发送路径 | **不动** | 用户明确要求；拦截/降级全部在 kernel 侧 |
| tui-command-filter.ts | **保留文件**，检测逻辑（`isTuiOnlyExtension` 扫描）继续用于弹窗 TUI 标记；**放弃自动过滤显示** | 自动过滤正是误伤根源；"把自动扫描的显示改成手动控制" |
| 弹窗命令范围 | **仅斜杠命令**（V1 不展示子命令/工具） | 用户确认 C 方案；RPC `get_commands` 不返回子命令，无可靠数据源 |
| TUI 命令开关 | **可开启**，弹窗仅标记"⚠ TUI 命令不被支持"提示 | 用户知情后自行决定；pi-goal 这类有 RPC 降级的开启后实际可用 |
| extension_notify 消息 | **显示 20s 后自动消失** | 用户明确要求（针对现有系统消息） |
| 命令数据 API | **独立 API** `GET /api/extensions/commands`（不依赖 session） | 插件页全局可用；复用 `session:commands` 需 session 且 5min 缓存 |

## 3. 数据模型

`settings.json` 新增字段 `waPiCommandToggles`（缺省 = 关，即未记录的命令视为关闭）：

```json
{
  "waPiPackages": ["npm:@narumitw/pi-goal@0.43.0"],
  "waPiCommandToggles": {
    "npm:@narumitw/pi-goal@0.43.0": {
      "goal": true
    }
  }
}
```

## 4. kernel 侧改动

### 4.1 tui-command-filter.ts 调整

- **保留**：`TUI_ONLY_PATTERN`、`isTuiOnlyExtension`（静态扫描扩展包源码，判定是否使用 TUI API）、`scanCache`
- **修改**：`filterTuiCommands` 不再把 TUI-only 扩展的命令从结果中删除；改为给每条命令附加 `tuiOnly: true/false` 标记后**全量返回**
- `tuiOnlyCommandNames` 集合保留（发送端降级仍用它），但填充来源改为"命令开关为关闭"的命令名，而非"被过滤的命令名"

### 4.2 命令归属与状态解析（新）

`packages/kernel/src/tui-command-filter.ts` 或新文件 `command-toggles.ts`：

- **包名解析**：`sourceInfo.path`（扩展入口绝对路径）向上找 `package.json`，取 `name` 字段 → `packageName`（对齐 `waPiPackages` 中的包名，如 `npm:@narumitw/pi-goal@0.43.0`）
- **开关状态**：读 settings `waPiCommandToggles`，按 `packageName + 命令名` 查询 `enabled`（缺省 false）
- **降级集合**：`tuiOnlyCommandNames` 填充 = 所有"命令开关为关闭"的扩展命令名

### 4.3 get_commands 返回扩展（kernel → 前端）

**删除 5min TTL 全局缓存**（`_commandsCache`）。现有 `getCommands()` 第 1 步的缓存查询、`_fetchAndCacheCommands` 的缓存写入、`markAllDirty`/`markSkillsDirty` 的缓存置空全部移除——不再有 `Date.now()` 过期判断。

`getCommands()` / `_fetchAndCacheCommands` 改为每次实时 RPC 拉取，`filterTuiCommands` 输出结构扩展：

```ts
interface CommandInfo {
  name: string;
  description?: string;
  source: CommandSource;   // "extension" | "prompt" | "skill" | "builtin"
  // 新增（仅 extension 来源）：
  packageName?: string;    // 插件包名（waPiPackages 格式）
  enabled?: boolean;       // 命令开关状态（缺省 false）
  tuiOnly?: boolean;       // TUI-only 检测标记
}
```

### 4.4 发送端降级（agent-manager.ts:1065-1073）

现有逻辑依赖 `_commandsCache` 作为"已拉取过"标记：

```ts
if (text.startsWith("/")) {
  if (!this._commandsCache) await this._fetchAndCacheCommands(handle.client).catch(() => []);
  const sp = text.indexOf(" ");
  const cmdName = sp === -1 ? text.slice(1) : text.slice(1, sp);
  if (isTuiOnlyCommand(cmdName)) text = ` ${text}`;   // 加前导空格 → 普通文本
}
```

改为：用布尔标记 `_commandsFetched` 替代 `_commandsCache` 的判空（作用仍是"首次拉取一次以填充 `tuiOnlyCommandNames`"，但无 TTL、无缓存数据）：

```ts
if (text.startsWith("/")) {
  if (!this._commandsFetched) {
    await this._fetchAndCacheCommands(handle.client).catch(() => []);
    this._commandsFetched = true;
  }
  const sp = text.indexOf(" ");
  const cmdName = sp === -1 ? text.slice(1) : text.slice(1, sp);
  if (isTuiOnlyCommand(cmdName)) text = ` ${text}`;
}
```

`isTuiOnlyCommand(cmdName)` 语义变为"命令不可用（关闭）"——`tuiOnlyCommandNames` 填充来源改为"命令开关为关闭的扩展命令名"。**Composer.tsx / 前端发送路径零改动**。

> 命名澄清：`isTuiOnlyCommand` 名称保留但语义变化；若实现时改名 `isCommandDisabled` 更清晰，但需同步测试。

### 4.5 新 API（routes/extensions.ts）

- `GET /api/extensions/commands` → `{ commands: CommandInfo[] }`（全部插件命令，含 packageName/enabled/tuiOnly）：复用 `getCommands()`（已实时化），不依赖特定 session
- `POST /api/extensions/commands/toggle` → body `{ name, command, enabled }`：
  - 写 settings `waPiCommandToggles[packageName][command] = enabled`
  - 重置 `_commandsFetched = false` + 清空 `tuiOnlyCommandNames`（下次发送/查询重新拉取刷新）
  - 无需 `markAllDirty()`（缓存已删除）

## 5. 前端改动

### 5.1 插件页（ExtensionSection.tsx）

每个已安装插件卡片操作区（升级/卸载旁）新增按钮：

```tsx
<button data-testid={`ext-commands-${pkg.name}`}>⌘ 附加命令</button>
```

点击打开命令弹窗。

### 5.2 命令弹窗（新组件 `CommandListModal.tsx`）

- 顶部提示条：`注意：TUI 命令不被支持`
- 列出该插件命令（`GET /api/extensions/commands` 按 `packageName` 过滤），每条：
  - 命令名 `/goal` + description
  - TUI-only 命令加 `⚠ TUI 命令不被支持` 徽标（仍可开关）
  - 右侧开关（默认关）
- 开关切换：`POST /api/extensions/commands/toggle` 即切即存，不重启
- 空状态：该插件未注册命令 → 显示"该插件未注册斜杠命令"

### 5.3 / 菜单过滤（commands store / ComposerInput.tsx）

`/` 菜单只显示 `enabled === true` 的 extension 命令；prompt/builtin 不受影响；skill 已过滤。

### 5.4 extension_notify 20s 自动消失（session.ts）

`case "extension_notify"` 插入消息后，`setTimeout(20_000)` 从 `messagesBySession[sessionId]` 移除该条（按 timestamp 匹配）。只对 `customType === "extension_notify"` 生效，其他 custom 消息（agent_switch 分隔行等）不受影响。

## 6. 行为矩阵

| 命令状态 | / 菜单显示 | 发送行为 |
| --- | --- | --- |
| 开启（非 TUI） | ✅ 显示 | 正常执行 |
| 关闭（默认，非 TUI） | ❌ 隐藏 | 静默降级：加前导空格 → 普通文本给 LLM |
| TUI-only（开启或关闭） | 由开关决定显示 | 发送时静默降级（保留现有逻辑） |

## 7. 文件结构

**修改：**

- `packages/kernel/src/agent-manager.ts` — **删除 `_commandsCache` 5min TTL 缓存**（字段、缓存查询、缓存写入、markAllDirty 置空）；新增 `_commandsFetched` 布尔标记；getCommands 每次实时拉取；输出结构扩展；toggle 后重置标记
- `packages/kernel/src/tui-command-filter.ts` — filterTuiCommands 改为标记而非删除；tuiOnlyCommandNames 填充来源改为关闭命令；新增清除集合方法
- `packages/kernel/src/routes/extensions.ts` — 两个新路由
- `packages/kernel/src/settings.ts`（或等效持久化模块）— waPiCommandToggles 读写
- `packages/frontend/src/components/settings/ExtensionSection.tsx` — 附加命令按钮
- `packages/frontend/src/components/settings/CommandListModal.tsx` — 新增弹窗
- `packages/frontend/src/store/commands.ts` — / 菜单按 enabled 过滤
- `packages/frontend/src/store/session.ts` — extension_notify 20s 自动移除
- `packages/shared/src/commands.ts` — CommandInfo 扩展字段

**测试：**

- `packages/kernel/tests/tui-command-filter.test.ts` — 更新（过滤→标记语义）
- `packages/kernel/tests/command-toggles.test.ts` — 新增（开关读写、降级集合、包名解析）
- `packages/kernel/tests/routes-extensions-commands.test.ts` — 新增（新 API）
- 前端组件测试 + E2E

## 8. 测试计划

### 单元（kernel，bun:test）

- `_commandsCache` 缓存机制已删除：`getCommands()` 不依赖 TTL 缓存，重复调用每次都实时拉取（mock RpcClient 验证调用次数）
- `_commandsFetched` 标记：首次发送前拉取一次；toggle 后重置，下次发送重新拉取
- `isTuiOnlyExtension` 仍能正确识别 TUI-only 扩展（现有用例回归）
- `filterTuiCommands`：TUI-only 命令不再被删除，附带 `tuiOnly: true`
- 包名解析：`sourceInfo.path` → `waPiPackages` 格式包名
- 开关读写：缺省 false；toggle 后持久化
- 降级集合：关闭命令名进入 `tuiOnlyCommandNames`；开启命令不在其中

### 组件（前端，Vitest）

- 插件卡片渲染"附加命令"按钮
- CommandListModal：命令列表渲染、TUI 徽标、开关切换调 API
- / 菜单只显示 enabled 命令

### 接口（curl / 运行中服务）

- `GET /api/extensions/commands` 返回结构
- `POST /api/extensions/commands/toggle` 成功 + 非法参数 400

### E2E（Playwright）

- 设置页打开 pi-goal 命令弹窗 → 开启 `/goal` → `/` 菜单出现 `/goal` → 输入发送正常执行
- 关闭 `/goal` → `/` 菜单消失 → 手动输入 `/goal xxx` 发送 → LLM 收到普通文本（无命令执行）
- 发送 `extension_notify` 消息 → 20s 后自动从界面消失

## 9. 不做的事（Non-goals）

- 不在前端 Composer 发送路径加任何拦截/提示
- 不做子命令/工具级开关（V1 仅斜杠命令；子命令无数据源）
- 不做"关闭命令居中提示"（用户明确选择静默降级）
- 不删除 tui-command-filter.ts（保留检测能力）
- 不改 pi-coding-agent 补丁（C 方案否决了子命令 RPC 扩展）
- 不迁移既有 `waPiDisabledPackages` 逻辑
