# 动态插件系统设计规格

**日期**: 2026-07-13  
**类型**: 新增功能  
**状态**: 设计确认

---

## 1. 目标

在 HiAgent 设置 → 插件面板中，支持用户动态安装、启用/禁用、升级、卸载第三方 npm 插件（Pi packages），无需修改代码或重新构建。

参考：
- Pi SDK 原生 Extensions 机制：`settings.json.packages` + `DefaultResourceLoader`
- Pi Packages 规范：`npm:包名` 格式，含 extensions + skills + prompts

## 2. 整体架构

### 2.1 扩展加载：双轨制

移除旧的可选内置插件硬编码机制（`OPTIONAL_EXTENSIONS`），改为：

```
settings.json
├── packages: string[]     # 动态插件 npm 来源（SDK 原生字段）
└── skills / disabledSkills / ...
```

| 轨道 | 加载方式 | 内容 | 管理方 |
|------|---------|------|--------|
| 核心扩展 | `additionalExtensionPaths` | pi-intercom, pi-web-access | 硬编码（不变） |
| 动态插件 | `packages` 字段 | 用户安装的 npm 包 | ExtensionManager 管理 |

### 2.2 生命周期

```
用户操作 → WS 事件 → kernel 执行 bun install/remove/update
                   → 读写 settings.json.packages
                   → 结果返回前端
                   → 用户看到"下次对话生效"提示

下次对话开始 → DefaultResourceLoader 读取 packages
            → SDK 自动加载扩展 + skills
```

## 3. WS 协议

### 3.1 事件

| 方向 | 事件 | Payload | 说明 |
|------|------|---------|------|
| FE→kernel | `extension:list` | — | 获取已安装包列表 |
| FE→kernel | `extension:install` | `{ name: string }` | 安装 npm 包 |
| FE→kernel | `extension:uninstall` | `{ name: string }` | 卸载包 |
| FE→kernel | `extension:upgrade` | `{ name: string }` | 升级到最新版 |
| FE→kernel | `extension:toggle` | `{ name: string, enabled: boolean }` | 启用/禁用 |
| kernel→FE | `extension:list` | `{ packages: PackageInfo[] }` | 列表结果 |
| kernel→FE | `extension:changed` | `{ packages: PackageInfo[] }` | 变更广播 |
| kernel→FE | `extension:error` | `{ name: string, error: string }` | 操作失败 |

### 3.2 PackageInfo

```typescript
interface PackageInfo {
  name: string;           // npm 包名
  version?: string;       // 已安装版本
  latestVersion?: string; // npm registry 最新版本（用于升级提示）
  description?: string;   // 从 package.json 读取
  enabled: boolean;       // 是否在 packages 数组中
}
```

## 4. 输入格式解析

用户输入自动识别多种格式，提取 npm 包名：

| 输入 | 解析结果 |
|------|---------|
| `pi install npm:pi-intercom` | `pi-intercom` |
| `install npm:pi-intercom` | `pi-intercom` |
| `npm:pi-intercom` | `pi-intercom` |
| `pi-intercom` | `pi-intercom` |

解析逻辑：去掉 `pi install ` / `install ` 前缀，再去掉 `npm:` 前缀，取剩余纯包名。

## 5. 操作流程

### 5.1 安装

```
1. 解析输入 → 包名
2. 检查 packages 数组是否已有该包 → 是则拒绝："已安装 vX.X.X，请使用升级"
3. cd ~/.hiagent/runtime && bun add <包名>
4. 从 package.json 读取版本和描述
5. settings.json.packages 追加 "npm:<包名>"
6. 返回成功，广播 extension:changed
```

### 5.2 卸载

```
1. 检查 packages 数组是否有该包 → 否则拒绝
2. cd ~/.hiagent/runtime && bun remove <包名>
3. 从 settings.json.packages 移除
4. 返回成功，广播 extension:changed
```

### 5.3 升级

```
1. 检查 packages 数组是否有该包 → 否则拒绝
2. cd ~/.hiagent/runtime && bun update <包名>
3. 重新读取版本号
4. 返回成功，广播 extension:changed
```

### 5.4 启用/禁用

```
1. 启用：确保包名在 packages 数组中（已在则 no-op）
2. 禁用：从 packages 数组中移除（不删 node_modules，避免反复安装）
3. 广播 extension:changed
```

## 6. 冲突处理

| 场景 | 策略 |
|------|------|
| 同名包已安装时再次安装 | 拒绝，提示"已安装 vX.X.X，请使用升级" |
| 卸载/升级不存在的包 | 拒绝，提示"未安装" |
| 工具/技能名冲突 | 由 Pi SDK 原生机制处理（后注册覆盖先注册） |
| 功能重叠 | 不做自动检测，由用户通过启用/禁用控制 |

## 7. Electron 兼容性

现有打包流程无需改动：

- 运行时依赖在 `~/.hiagent/runtime/` 通过 `bun install --production` 安装
- `settings.json` 位于 `~/.hiagent/`（即 HIAGENT_DIR）
- Pi SDK 的 `agentDir` 指向 `~/.hiagent/`，`DefaultResourceLoader` 自动发现 packages
- 动态安装的插件在 `~/.hiagent/runtime/node_modules/`，打包产物不包含

## 8. UI 设计

### 8.1 布局

设置弹窗（900px）→ 左侧导航 → 插件标签页 → 右侧内容：

```
┌─ 设置 ──────────────────────────────────────────┐
│ ┌─ 导航 ─┐ ┌─ 内容区 ──────────────────────────┐ │
│ │ 模型管理│ │                                     │ │
│ │ 技能    │ │ 安装新插件                           │ │
│ │ ▸ 插件  │ │ ┌──────────────────────┐ ┌───────┐ │ │
│ │ 记忆    │ │ │npm 包名输入框            │ │ 安装  │ │ │
│ │         │ │ └──────────────────────┘ └───────┘ │ │
│ │         │ │                                     │ │
│ │         │ │ 已安装插件 · 3                       │ │
│ │         │ │ ┌ superpowers-zh   v1.6.0 ────────┐ │ │
│ │         │ │ │ AI 编程超能力中文增强版             │ │ │
│ │         │ │ │ ⬤ 已启用    [⬆升级] [🗑卸载]     │ │ │
│ │         │ │ └──────────────────────────────────┘ │ │
│ │         │ │ ┌ pi-lens    v0.3.1 ──────────────┐ │ │
│ │         │ │ │ LSP 诊断、lint                     │ │ │
│ │         │ │ │ ○ 已禁用              [🗑卸载]    │ │ │
│ │         │ │ └──────────────────────────────────┘ │ │
│ │         │ │                                     │ │
│ │         │ │ 💡 下次对话开始时生效                 │ │
│ └─────────┘ └─────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

### 8.2 设计 Token

沿用现有 HiAgent Light 设计系统：

- 品牌色 `--accent`: #5B5BD6（安装按钮、输入框聚焦）
- 成功色 `--success`: #34A853（启用开关、状态文字）
- 警告色 `--warning`: #B45309（升级按钮）
- 危险色 `--danger`: #DC2626（卸载按钮）
- 描边 `--hairline`: #E5E5EA（卡片边框）
- 圆角 `--rounded-sm`: 8px（卡片、按钮、输入框）
- 圆角 `--rounded-lg`: 16px（弹窗）

### 8.3 交互细节

- 安装成功后卡片列表自动刷新
- 卸载需二次确认弹窗
- 升级按钮仅在有新版本时显示（橙色角标 `vX.Y.Z 可用`）
- 已禁用插件半透明显示
- 操作状态实时反馈（安装中 loading / 失败红色提示）

## 9. 文件改动清单

### Kernel (`packages/kernel/src/`)

| 文件 | 改动 |
|------|------|
| `extensions.ts` | 移除 `OPTIONAL_EXTENSIONS` 和 `migrateSettingsPackages()`；`buildAdditionalExtensionPaths()` 不变 |
| `extension-manager.ts` | 重写：新增 `install()` / `uninstall()` / `upgrade()` / `toggle()` / `list()`，基于 `settings.json.packages` |
| `agent-manager.ts` | 确认 `DefaultResourceLoader` 正常读取 `packages` 字段（agentDir 指向 HIAGENT_DIR） |
| `ws-server.ts` | 注册 `extension:install` / `extension:uninstall` / `extension:upgrade` / `extension:toggle` 事件处理 |
| `index.ts` | 移除 `migrateSettingsPackages()` 调用 |

### Frontend (`packages/frontend/src/`)

| 文件 | 改动 |
|------|------|
| `components/settings/ExtensionSection.tsx` | 重写：输入框 + 安装按钮 + 卡片列表 + 启用/禁用开关 + 升级/卸载按钮 |
| `store/extensions.ts` | 更新：新增 `installPackage()` / `uninstallPackage()` / `upgradePackage()` actions |

### Shared (`packages/shared/src/`)

| 文件 | 改动 |
|------|------|
| `extensions.ts` | 更新 `ExtensionPluginInfo` → `PackageInfo`；新增 WS 事件类型 |

### 根

| 文件 | 改动 |
|------|------|
| `CHANGELOG.md` | 记录变更 |

## 10. 测试要求

按照项目 AGENTS.md 四层测试金字塔：

1. **单元测试**（bun:test）：包名解析函数、settings.json 读写、toggle 逻辑
2. **组件测试**（Vitest）：ExtensionSection 渲染、安装输入、卡片列表、开关交互
3. **API 测试**：WS 协议 install/uninstall/upgrade/toggle/list 端点
4. **E2E**（Playwright）：完整安装→启用→禁用→升级→卸载流程

## 11. 风险评估

| 风险 | 等级 | 缓解 |
|------|------|------|
| `migrateSettingsPackages()` 清空 packages 字段 | 高 | 已在方案中移除该函数 |
| bun install 在 packaged 环境失败 | 中 | 沿用现有 runtime-deps 机制，已验证可行 |
| SDK 对 packages 字段的 `additionalExtensionPaths` 互斥 | 中 | Pi SDK 设计就是二者共存：additionalExtensionPaths 注入额外路径，packages 声明来源 |
| 升级后插件不兼容 | 低 | 用户可降级（卸载后装旧版）或禁用 |
