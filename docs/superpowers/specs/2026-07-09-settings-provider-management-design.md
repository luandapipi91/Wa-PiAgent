# 系统设置页 + 模型供应商管理

- **日期**: 2026-07-09
- **状态**: 设计已确认，待实现
- **范围**: 新增系统设置入口与页面；新增自定义 LLM 供应商（provider）的增删改查、连通测试，并通过 Pi extension 注册让会话可用

---

## 1. 目标与范围

### 目标
在会话列表下方新增「⚙ 系统设置」入口，打开全屏设置页面，提供**模型供应商管理**功能：

1. 新增/编辑/删除自定义 LLM 供应商
2. 每个供应商配置：名称、Base URL、API Key、API 格式（OpenAI 兼容 / Anthropic）、模型列表
3. 模型 ID 通过 tag 输入（`|` 分隔 / 回车添加、`×` 移除），每个模型单独设置上下文窗口 + 最大输出
4. 连通测试：验证供应商是否可连接
5. 供应商通过 Pi extension 的 `pi.registerProvider()` 注册，会话中可用 `<slug>/<modelId>` 引用

### 不做（YAGNI）
- 不做预设供应商模板（纯自定义）
- 不做 OAuth/SSO
- 不做供应商级 cost 配置 UI（cost 全填 0，后续可扩展）
- 不做左侧多菜单（本次左侧仅显示「模型管理」一项）
- 不迁移现有 JSON 持久化到 SQLite（保持与 projects/agents 一致）

---

## 2. 整体布局

### 2.1 入口

`Sidebar.tsx` 中 `ProjectList`（含「＋ 新建项目」按钮）下方，新增 `SettingsButton`：

```
┌─ Sidebar ────────────┐
│ Logo                  │
│ [+ 新建会话]          │
│ Agents…               │
│ ── 项目分组/会话列表 ──│
│  项目 A               │
│   · 会话1             │
│ [+ 新建项目]          │  ← 现有
│                       │
│ [⚙ 系统设置]          │  ← 新增入口
└───────────────────────┘
```

### 2.2 设置页（全屏 Modal）

点击入口打开全屏 Modal（复用 `components/ui/Modal.tsx`，width ~900），遮罩覆盖整个 App：

```
┌─ 全屏遮罩 (rgba 黑) ───────────────────────────────────────┐
│                                                            │
│   ┌─ SettingsModal (w~900) ────────────────────────────┐    │
│   │ 系统设置                                     [×]   │    │
│   ├──────────────┬─────────────────────────────────────┤    │
│   │ 左侧导航     │ 右侧内容区                          │    │
│   │              │                                     │    │
│   │ ● 模型管理   │  模型管理                           │    │
│   │              │                                     │    │
│   │              │  [+ 添加供应商]                     │    │
│   │              │                                     │    │
│   │              │  ┌───────────────────────────────┐  │    │
│   │              │  │ My DeepSeek · openai-completions │  │    │
│   │              │  │   deepseek-chat · deepseek-reasoner │  │    │
│   │              │  │   [编辑] [测试连接] [删除]     │  │    │
│   │              │  └───────────────────────────────┘  │    │
│   │              │  ┌───────────────────────────────┐  │    │
│   │              │  │ 公司内网 · anthropic-messages │  │    │
│   │              │  │   claude-sonnet-4-5           │  │    │
│   │              │  │   [编辑] [测试连接] [删除]     │  │    │
│   │              │  └───────────────────────────────┘  │    │
│   └──────────────┴─────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────┘
```

**左侧导航**：本次仅渲染「模型管理」一项（不显示占位项）。导航选中状态由 Zustand `useSettingsStore` 管理，预留后续扩展（加项只需在导航数组 + 右侧内容区各加一条）。

---

## 3. 添加/编辑供应商弹窗

点击「+ 添加供应商」或卡片「编辑」，打开二级 Modal（嵌套在设置 Modal 之上）：

```
┌─ ProviderFormModal (w~640) ────────────────────────┐
│ 添加供应商                                  [×]    │
├────────────────────────────────────────────────────┤
│ 供应商名称                                          │
│ ┌──────────────────────────────────────────────┐   │
│ │ My DeepSeek                                  │   │
│ └──────────────────────────────────────────────┘   │
│                                                    │
│ Base URL                                           │
│ ┌──────────────────────────────────────────────┐   │
│ │ https://api.deepseek.com/v1                  │   │
│ └──────────────────────────────────────────────┘   │
│                                                    │
│ API Key                                            │
│ ┌──────────────────────────────────────────────┐   │
│ │ sk-••••••••••••••••••          [👁 显示]     │   │
│ └──────────────────────────────────────────────┘   │
│                                                    │
│ API 格式                                           │
│ ( • ) OpenAI 兼容   ( ) Anthropic                  │
│                                                    │
│ 模型 ID （输入 | 添加，× 移除）                     │
│ ┌──────────────────────────────────────────────┐   │
│ │ [deepseek-chat ×] [deepseek-reasoner ×]      │   │
│ │ deepseek-|                                     │   │  ← 输入中遇 | 即添加
│ └──────────────────────────────────────────────┘   │
│                                                    │
│ 模型列表                                            │
│ ┌─────────────────┬───────────┬──────────┐         │
│ │ 模型 ID         │ 上下文窗口│ 最大输出 │         │
│ ├─────────────────┼───────────┼──────────┤         │
│ │ deepseek-chat   │ [ 64000 ] │ [ 8192 ] │         │
│ │ deepseek-reasoner│[ 64000 ] │ [ 8192 ] │         │
│ └─────────────────┴───────────┴──────────┘         │
│                                                    │
│              [测试连接]    [取消]  [保存]          │
│                                                     │
│  测试连接结果区：✓ 连接成功 / ✗ 失败：<错误>       │
└────────────────────────────────────────────────────┘
```

### 3.1 Tag 输入交互（TagInput 组件）

```ts
interface TagInputProps {
  value: string[];              // 当前 tags（= 模型 ID 列表）
  onChange: (tags: string[]) => void;
  placeholder?: string;
}
```

**行为**：
- **添加**：输入文字后遇到 `|` 字符 → 把 `|` 之前的文本切成一个 tag；回车 → 把输入框剩余文本作为 tag 提交
- **批量**：粘贴 `a|b|c` → 按 `|` 拆分成 3 个 tag（与单次输入 `|` 同一逻辑：每次遇到分隔符就 flush）
- **移除**：点 tag 上的 `×` 移除该 tag
- 空字符串 / 纯空格不生成 tag（trim 后为空则丢弃）

**拆分逻辑**抽成纯函数 `splitModelIds(input: string): string[]`，便于单元测试：
```ts
// "a|b|c" → ["a","b","c"]
// "a|" → ["a"]（末尾分隔符后的空串丢弃）
// "  " → []（纯空白丢弃）
// 单次输入只 flush 分隔符前的部分，末尾未分隔的留输入框（回车才提交）
```

> 实现说明：TagInput 内部维护「已确认 tags + 当前输入文本」两个状态。`onChange` 输入框变化时，若新值含 `|`，则把 `|` 前的部分加入 tags、清空输入框为 `|` 后的剩余文本。回车时把整个输入框文本作为一个 tag 提交并清空。

### 3.2 Tag ↔ 模型表格联动

- 每新增一个 tag，下方「模型列表」表格自动追加一行，`contextWindow` / `maxTokens` 默认 `128000` / `4096`，可点击修改
- 删 tag 则同步删对应行
- 表格不可独立增删行（行的增删只由 tag 驱动），保证 tag 列表与表格行一一对应

### 3.3 连通测试

点「测试连接」：用当前表单值（未保存也行，含 baseUrl/apiKey/api/models）向 kernel 发 `provider:test` 事件，按钮旁显示状态：`测试中…` → `✓ 连接成功` / `✗ 失败：<错误信息>`。测试失败不阻断保存。

---

## 4. 数据模型

新增到 `packages/shared/src/types.ts`：

```ts
// API 格式枚举（对齐 Pi 的 api 字段子集）
export type ProviderApi = "openai-completions" | "anthropic-messages";

// 单个模型
export interface ProviderModel {
  id: string;              // 模型 ID，如 "deepseek-chat"
  contextWindow: number;   // 上下文窗口（tokens），默认 128000
  maxTokens: number;       // 最大输出（tokens），默认 4096
}

// 供应商（纯自定义）
export interface ModelProvider {
  id: string;              // 内部 uuid，用于增删改（前端生成）
  name: string;            // 显示名，如 "My DeepSeek"
  baseUrl: string;         // 如 "https://api.deepseek.com/v1"
  apiKey: string;          // 明文存储（与现有 agent-md 一致，本地单用户应用）
  api: ProviderApi;        // "openai-completions" | "anthropic-messages"
  models: ProviderModel[]; // 模型列表
}
```

---

## 5. 持久化与 Pi 注册

### 5.1 持久化（JSON）

kernel 读写 `~/.hiagent/providers.json`，结构：

```json
{
  "providers": [
    {
      "id": "uuid-...",
      "name": "My DeepSeek",
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKey": "sk-xxx",
      "api": "openai-completions",
      "models": [
        { "id": "deepseek-chat", "contextWindow": 64000, "maxTokens": 8192 }
      ]
    }
  ]
}
```

新增 `packages/kernel/src/provider-store.ts`，沿用 `ConfigStore` / `ProjectStore` 的 JSON 读写模式（`readFile`/`writeFile` + 目录不存在视为空）。

新增常量 `PROVIDERS_FILE` 到 `packages/shared/src/constants.ts`：
```ts
export const PROVIDERS_FILE = `${HIAGENT_DIR}/providers.json`;
```

### 5.2 Pi extension 注册

kernel 启动时（`index.ts`）读取 `providers.json`，**生成一个 Pi extension 文件**到 `~/.hiagent/.generated/provider-extension.ts`，内容遍历 providers 调用 `pi.registerProvider()`：

```ts
// 自动生成，勿手改
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.registerProvider("my-deepseek", {
    name: "My DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-xxx",
    api: "openai-completions",
    models: [
      { id: "deepseek-chat", name: "deepseek-chat",
        reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 64000, maxTokens: 8192 }
    ]
  });
}
```

并在 kernel 启动 Pi 时通过 extension 配置加载它。之后会话里 `AgentConfig.model` 写成 `my-deepseek/deepseek-chat` 即可被 `resolveModel` 解析到。

### 5.3 Provider 命名（slugify）

Pi provider 名（registerProvider 的第一个参数）必须是无空格/中文的 slug。生成规则：

- 把 `ModelProvider.name` 转成 slug：小写、空格转 `-`、移除非 `[a-z0-9-]` 字符（中文等移除后若为空则 fallback `provider-<id前6位>`）
- 冲突处理：若两个供应商 slug 冲突，自动加后缀（`my-deepseek` / `my-deepseek-2`）。冲突检测在生成 extension 时基于已生成 slug 集合
- **模型字符串格式**：`<slug>/<model.id>`，如 `my-deepseek/deepseek-chat`。用户在 AgentConfig.model 填这个即可

> 注意：slug 不持久化到 providers.json，每次生成 extension 时从 name 实时计算（保证 rename 后 slug 同步更新）。slug 冲突检测只在生成时刻生效。

### 5.4 连通测试（kernel 直接 fetch）

kernel 新增 `provider:test` 处理，用 `fetch` 直接探测（不走 Pi 注册链路，保证测试的是「这个配置能不能连」，而非「Pi 注册是否成功」）：

- `openai-completions` → `GET {baseUrl}/models`，header `Authorization: Bearer <apiKey>`，HTTP 2xx 视为成功
- `anthropic-messages` → `POST {baseUrl}/messages` 发一个最小请求（`model` 用第一个模型 id 或占位、`max_tokens: 1`、`messages: [{role:"user",content:"ping"}]`），header `x-api-key: <apiKey>` + `anthropic-version: 2023-06-01`，HTTP 2xx 视为成功
- 超时（10s）/ 非 2xx / 网络错误，统一返回 `{ ok: false, error: "<状态码/错误>" }`
- 返回 `{ ok: true }` 或 `{ ok: false, error?: string }`

> 选 kernel 直接 fetch 而非走 Pi：Pi 的 registerProvider 是启动时注册、无独立「探测」API；直接 fetch 最简单可控，且测试的是用户填的原始配置（baseUrl/apiKey/api），与「这个供应商能不能用」语义一致。

---

## 6. WS 协议

新增到 `packages/shared/src/types.ts`：

### 6.1 前端 → kernel（加入 `WSClientEvent`）

```ts
export interface ProviderListEvent { type: "provider:list"; }
export interface ProviderSaveEvent {
  type: "provider:save";
  provider: ModelProvider;   // 有 id 则更新，无则新增
}
export interface ProviderDeleteEvent {
  type: "provider:delete";
  id: string;
}
export interface ProviderTestEvent {
  type: "provider:test";
  baseUrl: string;
  apiKey: string;
  api: ProviderApi;
  models: ProviderModel[];   // anthropic 探测需用真实 model id 发最小请求
}
```

### 6.2 kernel → 前端（加入 `WSServerEvent`）

```ts
export interface ProviderListResult {
  type: "provider:list";
  providers: ModelProvider[];
}
export interface ProviderTestResult {
  type: "provider:test";
  ok: boolean;
  error?: string;
}
export interface ProviderChangedEvent {
  type: "provider:changed";
  providers: ModelProvider[];   // 变更后全量推送
}
```

### 6.3 事件流

- 前端进入设置页 → `provider:list` → kernel 回 `ProviderListResult`
- 前端保存/删除 → `provider:save`/`provider:delete` → kernel 写 `providers.json` + 重新生成 extension → 推 `ProviderChangedEvent`（全量）→ 前端更新列表
- 前端测试 → `provider:test` → kernel 回 `ProviderTestResult`（用 requestId 或直接按最近一次请求匹配；实现上用「测试请求队列 / 最近请求 token」避免并发串台，MVP 阶段单供应商测试不并发，按钮 disabled 即可）

---

## 7. 前端组件与状态层

### 7.1 新增文件

```
packages/frontend/src/
├── components/
│   ├── SettingsButton.tsx        ← 入口按钮（放 Sidebar 底部）
│   ├── SettingsModal.tsx         ← 全屏设置 Modal（左侧菜单 + 右侧内容）
│   └── settings/
│       ├── ProviderSection.tsx   ← 模型管理区块（供应商列表 + 添加按钮）
│       ├── ProviderCard.tsx      ← 单个供应商卡片（编辑/测试/删除）
│       └── ProviderFormModal.tsx ← 添加/编辑供应商二级弹窗（tag 输入 + 模型表格）
├── components/ui/
│   └── TagInput.tsx              ← 通用 tag 录入组件
└── store/
    ├── settings.ts               ← Zustand store（showSettings 开关 + activeSection）
    └── providers.ts              ← Zustand store（CRUD + 连通测试）
```

### 7.2 Zustand stores

**`store/settings.ts`**（设置页开关 + 导航）：
```ts
interface SettingsStore {
  showSettings: boolean;
  activeSection: "models";   // 预留联合类型扩展
  open: () => void;
  close: () => void;
  setSection: (s: "models") => void;
}
```

**`store/providers.ts`**：
```ts
interface ProvidersStore {
  providers: ModelProvider[];
  loading: boolean;
  load: () => void;          // 发 provider:list
  save: (p: ModelProvider) => void;   // 发 provider:save
  remove: (id: string) => void;       // 发 provider:delete
  setProviders: (ps: ModelProvider[]) => void;  // 接收 ProviderChangedEvent / ProviderListResult
  test: (input: { baseUrl: string; apiKey: string; api: ProviderApi; models: ProviderModel[] })
    => Promise<{ ok: boolean; error?: string }>;
}
```

store 内部通过 `ws-instance` 的 `send()` 发事件；kernel 的 `provider:changed` / `provider:list` 推送时调 `setProviders`。

### 7.3 App.tsx 改动（最小）

不修改 `View` 枚举。`SettingsModal` 渲染受 `useSettingsStore` 控制，渲染在根节点最上层：

```tsx
// App.tsx 结构（新增最后一行）
<div className="flex h-screen bg-canvas">
  <Sidebar />           {/* 内含新的 SettingsButton */}
  <main>...主区域...</main>
  {configAgent && <AgentConfig ... />}
  {useSettingsStore(s => s.showSettings) && <SettingsModal onClose={...} />}
</div>
```

`Sidebar.tsx` 在 `ProjectList` 下方加 `<SettingsButton onClick={() => useSettingsStore.getState().open()} />`。

### 7.4 删除确认

删除供应商时弹 `ConfirmDialog`（复用 `components/ui/ConfirmDialog.tsx`）二次确认，避免误删。

---

## 8. 错误处理

- **表单校验**：name / baseUrl / apiKey / api 必填，空则保存按钮禁用 + 字段下红字提示；models 至少 1 个，否则提示「至少添加一个模型」
- **连通测试**：超时（10s）/ 非 2xx / 网络错误，统一返回 `{ ok: false, error }`，前端在按钮旁显示，不阻断保存
- **WS 异常**：kernel 写文件失败时回推 `ErrorEvent`（复用现有 error 事件），前端 toast / alert 提示
- **slug 生成失败**：name 全是非 ASCII（如纯中文）导致 slug 为空 → fallback `provider-<id前6位>`，保证 extension 总能生成

---

## 9. 测试策略（四层）

遵循 AGENTS.md 第 6 节，四层缺一不可。

### 第一层：单元测试（bun:test）

- `provider-store.ts`：CRUD（list/save/delete）、文件不存在时返回空、save 后 list 能读到
- `slugifyProviderName(name)`：各种输入（英文、空格、中文、特殊字符、空字符串、纯空白）→ 预期 slug；冲突后缀逻辑
- `generateProviderExtension(providers)`：给定 providers 数组 → 生成的 extension 文本包含正确的 registerProvider 调用、slug、model 字段
- `splitModelIds(input)`：`"a|b|c"` / `"a|"` / `"  "` / 单次输入流 → 预期拆分结果

### 第二层：组件测试（bun:test + @testing-library/react + happy-dom）

- `TagInput`：渲染初始 tags；模拟输入 `a|` → 出现 tag `a`；模拟回车 → tag 提交；点 × → 移除；粘贴 `a|b|c` → 3 tags
- `ProviderFormModal`：必填校验（空时保存禁用）；tag 增删联动模型表格行；表格 contextWindow/maxTokens 可编辑；测试连接按钮点击后状态变化（mock test action）
- `SettingsModal`：open/close；导航切换（本次只有一项，断言渲染 ProviderSection）
- 删除流程：点删除 → ConfirmDialog 出现 → 确认 → 调 remove action

### 第三层：API 接口测试（curl / WS 客户端）

kernel WS 事件：
- `provider:list` 成功（空列表 + 有数据两种）
- `provider:save` 成功 → 落盘 `providers.json` + extension 文件生成；错误路径（写文件失败 mock）
- `provider:delete` 成功 → providers.json 移除 + extension 重新生成
- `provider:test` 成功（mock fetch 2xx）+ 失败（mock fetch 500 / 超时）

### 第四层：E2E（Playwright）

完整业务流程：
1. 通过 API 创建测试数据（或直接 UI）→ 打开设置页
2. 点「+ 添加供应商」→ 填表单（名称/baseUrl/apiKey/api）→ tag 录入模型 id → 表格填长度
3. 点测试连接 → 断言结果显示
4. 保存 → 断言卡片出现在列表
5. 编辑该供应商 → 修改 → 保存 → 断言卡片更新
6. 删除 → ConfirmDialog → 确认 → 断言卡片消失
7. finally 清理：删除测试产生的 providers.json + extension 文件（用独立 HIAGENT_DIR 隔离）

**截图清理**：E2E 产生的截图在所有测试完成后全部删除。

---

## 10. 落地顺序（实现参考，非强制）

1. shared 类型 + 常量（ProviderApi / ProviderModel / ModelProvider / WS 事件 / PROVIDERS_FILE）
2. kernel：`provider-store.ts`（CRUD）+ `provider-extension.ts`（slugify + extension 生成）+ ws-server 事件接入
3. kernel：`provider:test` fetch 探测
4. kernel：`index.ts` 启动时加载 providers + 生成 extension
5. 前端：`store/settings.ts` + `store/providers.ts`
6. 前端：`TagInput` 组件（含 splitModelIds 纯函数）
7. 前端：`ProviderFormModal`（tag + 表格 + 测试连接）
8. 前端：`ProviderCard` + `ProviderSection` + `SettingsModal` + `SettingsButton`
9. 前端：App.tsx / Sidebar.tsx 接线
10. 四层测试逐层补齐
11. CHANGELOG.md 更新

---

## 11. 开放问题 / 后续

- **apiKey 明文**：当前明文存 providers.json。若后续需要加密，可作为独立安全加固任务（不在本次范围）
- **provider rename 后模型字符串失效**：slug 从 name 实时计算，rename 后 `<old-slug>/model` 会失效。MVP 接受（用户 rename 时自行更新 AgentConfig.model）；后续可在 store 层维护 slug 映射或持久化 slug
- **动态模型发现**：Pi 支持 async extension factory 从 `/v1/models` 拉取模型列表。本次不做（用户手填），后续可加「从 API 拉取模型」按钮
- **左侧更多菜单**：本次只有「模型管理」。后续加「通用设置/外观/快捷键/关于」只需在导航数组 + 右侧内容区各加一条，零架构改动
