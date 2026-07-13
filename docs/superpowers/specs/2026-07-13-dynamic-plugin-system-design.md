# 动态插件系统设计规格

**日期**: 2026-07-13  
**类型**: 新增功能  
**状态**: 设计确认（已吸收审查反馈）

---

## 1. 目标

在 HiAgent 设置 → 插件面板中，支持用户动态安装、启用/禁用、升级、卸载第三方 npm 插件（Pi packages），无需修改代码或重新构建。

参考：
- Pi SDK 原生 Extensions 机制：`settings.json.packages` + `DefaultResourceLoader`
- Pi Packages 规范：`npm:包名` 格式，含 extensions + skills + prompts

## 2. 整体架构

### 2.1 扩展加载：双轨制

移除旧的可选内置插件硬编码机制（`OPTIONAL_EXTENSIONS`），改为：

```json
{
  "npmCommand": ["bun"],
  "packages": [
    "npm:superpowers-zh@1.6.0",
    "git:github.com/user/repo@v1",
    "/absolute/path/to/local-pkg"
  ]
}
```

`npmCommand` 告诉 Pi SDK 和 HiAgent 使用哪个包管理器（bun），而非硬编码。

| 轨道 | 加载方式 | 内容 | 管理方 |
|------|---------|------|--------|
| 核心扩展 | `additionalExtensionPaths` | pi-intercom, pi-web-access | 硬编码（不变） |
| 动态插件 | `packages` 字段 | npm / git / 本地路径 | ExtensionManager 管理 |

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





解析后的名称必须通过严格校验后才允许安装。校验规则：

- **允许格式**：裸名（`pi-intercom`）、scope 包（`@scope/name`）、带版本（`name@1.0.0`、`@scope/name@^2.0`）
- **拒绝**：
  - 路径字符：`/` `\\` `..` `./` `~/`
  - URL 前缀：`http:` `https:` `git:` `ssh:` `git+`
  - Shell 元字符：`;` `|` `&` `$` `` ` `` `!` `<` `>` `'` `"`
  - npm 前缀残留：`npm:`（解析后不应再有）
  - 空字符串、纯空白

```typescript
// 示例校验函数
function validatePackageName(raw: string): string | null {
  // 提取 version 后缀（允许 name@version）
  const atIdx = raw.lastIndexOf("@");
  let name = atIdx > 0 ? raw.slice(0, atIdx) : raw;
  const version = atIdx > 0 ? raw.slice(atIdx + 1) : undefined;

  // npm package name spec: 1-214 chars, lowercase, no URL-like
  if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) return null;
  if (name.length > 214) return null;

  // 拒绝路径字符、URL 前缀、shell 元字符（name 和 version 都检查）
  const dangerous = /[\\/;&|$`!<>'\"]/;
  if (dangerous.test(name)) return null;
  if (version && dangerous.test(version)) return null;
  if (/^(https?:|git:|ssh:|git\+)/.test(name)) return null;

  return version ? `${name}@${version}` : name;
}
```





```
1. 解析输入 → 包名 + 可选版本
2. 调用 validatePackageName() 校验 → 失败则拒绝，返回错误
3. 检查 packages 数组是否已有同名包 → 是则拒绝："已安装 vX.X.X，请使用升级"
4. 执行安装（见 5.1.1）
5. 从 node_modules/<pkg>/package.json 读取实际安装版本和描述
6. settings.json.packages 写入 "npm:<包名>@<实际版本>"（锁定版本）
7. 返回成功，广播 extension:changed
```



使用数组参数调用 `bun add`，避免 shell 注入：

```typescript
// runtimeDir = ~/.hiagent/runtime
const args = version ? ["add", `${name}@${version}`] : ["add", name];
const proc = Bun.spawn(["bun", ...args], { cwd: runtimeDir, stdio: ["pipe", "pipe", "pipe"] });
const exitCode = await proc.exited;
if (exitCode !== 0) throw new Error(`安装失败: exit code ${exitCode}`);
```



```
1. 检查 packages 数组是否有该包 → 否则拒绝
2. Bun.spawn(["bun", "remove", name], { cwd: runtimeDir })
3. 从 settings.json.packages 移除对应条目
4. 返回成功，广播 extension:changed
```



```
1. 检查 packages 数组是否有该包 → 否则拒绝
2. Bun.spawn(["bun", "update", name], { cwd: runtimeDir })
3. 从 node_modules/<pkg>/package.json 读取新版本号
4. settings.json.packages 更新为 "npm:<包名>@<新版本>"
5. 返回成功，广播 extension:changed
```



```
1. 从 packages 中找到该包条目并提取锁定的版本
2. 检查 node_modules/<pkg>/package.json 是否存在
   → 存在：校验版本是否与锁定版本一致
     → 一致：直接加入 packages 数组
     → 不一致：重新 Bun.spawn(["bun", "add", `${name}@${lockedVersion}`], ...)
   → 不存在：Bun.spawn(["bun", "add", `${name}@${lockedVersion}`], ...)
3. 如重新安装，更新 packages 中的版本为实际安装版本
4. 广播 extension:changed
```



```
1. 从 packages 数组中移除（不删 node_modules）
2. 广播 extension:changed
```



为避免 ExtensionManager 职责膨胀，按现有项目风格拆分为两层：

```
ExtensionManager           ← 状态管理 + WS 事件编排
  └── NpmPackageService    ← bun add/remove/update + npm registry 查询
```

### NpmPackageService

```typescript
class NpmPackageService {
  constructor(private runtimeDir: string) {}
  async install(name: string, version?: string): Promise<{ version: string }>;
  async uninstall(name: string): Promise<void>;
  async upgrade(name: string): Promise<{ version: string }>;
  async getLatestVersion(name: string): Promise<string | undefined>;
}
```

- 所有 `bun` 命令通过 `Bun.spawn` 数组参数执行
- 可注入 mock 便于单测（与现有 `resolveEntryPath` / `readVersion` 注入模式一致）
- npm registry 查询用 `npm view <pkg> version` 或 `bun pm ls` 对比

### ExtensionManager

```typescript
class ExtensionManager {
  constructor(private dataDir: string, private pkgService: NpmPackageService) {}
  async list(): Promise<{ packages: PackageInfo[] }>;
  async install(rawInput: string): Promise<PackageInfo>;
  async uninstall(name: string): Promise<void>;
  async upgrade(name: string): Promise<PackageInfo>;
  async enable(name: string): Promise<void>;
  async disable(name: string): Promise<void>;
}
```

- 只负责 settings.json 读写 + 输入解析/校验 + 编排 pkgService 调用
- 不做任何 shell 命令或 registry 查询



| 场景 | 策略 |
|------|------|
| 同名包已安装时再次安装 | 拒绝，提示"已安装 vX.X.X，请使用升级" |
| 卸载/升级不存在的包 | 拒绝，提示"未安装" |
| 工具/技能名冲突 | 由 Pi SDK 原生机制处理（后注册覆盖先注册） |
| 功能重叠 | 不做自动检测，由用户通过启用/禁用控制 |



现有打包流程无需改动：

- 运行时依赖在 `~/.hiagent/runtime/` 通过 `bun install --production` 安装
- `settings.json` 位于 `~/.hiagent/`（即 HIAGENT_DIR）
- Pi SDK 的 `agentDir` 指向 `~/.hiagent/`，`DefaultResourceLoader` 自动发现 packages
- 动态安装的插件在 `~/.hiagent/runtime/node_modules/`，打包产物不包含



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



### Kernel (`packages/kernel/src/`)

| 文件 | 改动 |
|------|------|
| `extensions.ts` | 移除 `OPTIONAL_EXTENSIONS` 和 `migrateSettingsPackages()`；`buildAdditionalExtensionPaths()` 不变 |
| `extension-manager.ts` | 重写：新增 `install()` / `uninstall()` / `upgrade()` / `toggle()` / `list()`，基于 `settings.json.packages` |
| `agent-manager.ts` | 确认 `DefaultResourceLoader` 正常读取 `packages` 字段（agentDir 指向 HIAGENT_DIR） |
| `ws-server.ts` | 注册 `extension:install` / `extension:uninstall` / `extension:upgrade` / `extension:toggle` 事件处理 |
| `index.ts` | 移除 `migrateSettingsPackages()` 调用 |

| `extension-manager.test.ts` | 新增单元测试：包名校验、版本锁定、启用版本校验 |

### Frontend (`packages/frontend/src/`)

| 文件 | 改动 |
|------|------|
| `components/settings/ExtensionSection.tsx` | 重写：输入框 + 安装按钮 + 卡片列表 + 启用/禁用开关 + 升级/卸载按钮 |
| `store/extensions.ts` | 更新：新增 `installPackage()` / `uninstallPackage()` / `upgradePackage()` actions |

### Shared (`packages/shared/src/`)

| 文件 | 改动 |
|------|------|
| `extensions.ts` | 更新 `ExtensionPluginInfo` → `PackageInfo`；新增 WS 事件类型；物理删除 `migrateSettingsPackages()` |

### 根

| 文件 | 改动 |
|------|------|
| `CHANGELOG.md` | 记录变更 |



按照项目 AGENTS.md 四层测试金字塔：


2. **组件测试**（Vitest）：ExtensionSection 渲染、安装输入、卡片列表、开关交互
3. **API 测试**：WS 协议 install/uninstall/upgrade/toggle/list 端点
4. **E2E**（Playwright）：完整安装→启用→禁用→升级→卸载流程



| 风险 | 等级 | 缓解 |
|------|------|------|

| `migrateSettingsPackages()` 被误调用清空用户数据 | 🔴 HIGH | 从 `extensions.ts` **物理删除**该函数，不留残留代码 |
| packages 不锁定版本导致不可重复 | 🟡 HIGH | 安装/升级后立即写回 `npm:name@版本`，以实际安装版本为真相来源 |
| additionalExtensionPaths 与 packages 共存语义未验证 | 🟡 HIGH | 增加专项测试：同名包同时出现在两个轨道，验证 SDK 去重行为 |
| 启用时 node_modules 版本与锁定不一致 | 🟡 MEDIUM | 启用前校验版本，不匹配自动重新安装 |
| bun install 在 packaged 环境失败 | 🟢 LOW | 沿用现有 runtime-deps 机制，已验证可行 |

