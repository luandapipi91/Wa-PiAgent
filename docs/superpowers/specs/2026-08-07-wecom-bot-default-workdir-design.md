# 企微机器人：默认工作目录 + 切换工作目录开关 设计

日期：2026-08-07
状态：已与用户确认（方案 A）

## 背景

系统设置 → 机器人 → 企微机器人的配置中缺少「默认工作目录」：当前所有 IM 会话硬性落在 `__system__`（默认工作区，`packages/kernel/src/channel-manager.ts` 新建映射时 `currentProjectId = SYSTEM_PROJECT_ID`）。同时工作区切换（IM 侧 `/use`、`/projects` 指令）对所有机器人无条件开放，需要增加按机器人关闭的开关，默认不支持切换。

## 需求（用户确认）

1. 机器人配置新增「默认工作目录」：从系统已有工作区（项目）下拉选择，默认值为「默认工作区」（`__system__`）。
2. 机器人配置新增「允许切换工作目录」开关，默认关闭。
3. 开关关闭时：IM 侧 `/use` 和 `/projects` 指令均被禁用（回复"不支持"提示），`/help` 文案不展示这两条指令。

## 数据层（`@wa-pi/shared`）

`ChannelConfig`（`packages/shared/src/types.ts:516`）新增两个字段：

```ts
/** 默认工作目录（项目 id），默认 __system__（默认工作区） */
defaultProjectId: string;
/** 是否允许 IM 侧切换工作目录（/use、/projects 指令），默认 false */
allowProjectSwitch: boolean;
```

兼容：旧 `channels.json` 记录无这两个字段。在 `loadChannels`（`packages/kernel/src/channel-store.ts`）读取时归一化兜底：`defaultProjectId ?? SYSTEM_PROJECT_ID`、`allowProjectSwitch ?? false`。不做迁移写盘。

`validateChannelInput` 增加校验：`defaultProjectId` 缺失时回退默认工作区（不报错，保持与读取兜底一致）。

## kernel 层

### channel-manager.ts

- `handleInbound` 新建映射时：`currentProjectId = channel.defaultProjectId ?? SYSTEM_PROJECT_ID`。
- 项目删除兜底：解析默认工作区时检查项目是否仍存在（`projectStore.load()`），若已被删除，降级为 `SYSTEM_PROJECT_ID` 并 `console.warn`（与 `resolveAgent` 的删除降级模式一致）。
- 指令拦截调用 `parseCommand` 时传入 `allowSwitch: channel.allowProjectSwitch ?? false`。
- `ensureSession` 中 `__system__` 的 mkdir 逻辑不变（仅系统工作区需要按会话建子目录，其他项目 cwd 已存在）。

### commands.ts

`CommandContext` 增加 `allowSwitch: boolean`：

- `allowSwitch === false`：
  - `/use`、`/projects` → `handled: true`，回复「该机器人不支持切换工作目录。」
  - `/help` 文案不含 `/projects`、`/use` 两条。
- `allowSwitch === true`：行为与现状完全一致。

## 前端（`BotsSection.tsx`）

表单新增两项：

1. 「默认工作目录」下拉：选项来自 `useProjectsStore` 的项目列表（含默认工作区，它由 `ensure-system-project.ts` 保证存在于 projects.json），值为项目 id；新建草稿默认 `__system__`。
2. 「允许切换工作目录」checkbox：默认不勾选；附说明文案「开启后 IM 侧可通过 /use、/projects 指令查看并切换工作区」。

`emptyDraft` 与 `openEdit` 同步补这两个字段。`ChannelInput` 类型同步扩展。

## 测试（四层验收）

1. **单元测试（bun:test）**
   - `commands.test.ts`：`allowSwitch=false` 时 `/use`、`/projects` 被拒、`/help` 不含两条指令；`allowSwitch=true` 时行为不变。
   - `channel-store.test.ts`：旧数据（无新字段）读取兜底；校验逻辑。
   - `channel-manager` 相关：新建映射使用 `defaultProjectId`；项目被删除时兜底 `__system__`。
2. **组件测试（Vitest + testing-library）**：`BotsSection.test.tsx` 渲染两个新字段、默认值正确、编辑回填、保存提交包含新字段。
3. **API 集成测试（curl）**：创建/更新机器人携带新字段 → GET 返回一致；缺省字段 → 返回兜底值。
4. **E2E（Playwright）**：设置页配置默认工作目录与开关 → mock 渠道进站验证 `/use` 被拒 / 允许；验证 IM 会话落在配置的默认工作区。

## 影响范围

- `packages/shared/src/types.ts`（ChannelConfig 扩展）
- `packages/kernel/src/channel-store.ts`（读取兜底 + 校验）
- `packages/kernel/src/channel-manager.ts`（默认工作区解析、allowSwitch 透传）
- `packages/kernel/src/channels/commands.ts`（指令开关）
- `packages/frontend/src/components/settings/BotsSection.tsx`（表单）
- `packages/frontend/src/store/channels.ts`（ChannelInput 类型）
- 对应测试文件 + CHANGELOG.md
