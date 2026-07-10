# Composer 重构设计文档

## 1. 背景与目标

当前聊天底部输入区由 `Composer` 组件实现，仅支持纯文本输入和占位式的"🎨 模型"按钮。本设计参考 pi.dev 的底部输入区，重构 `Composer` 与 `NewSessionPane`，使其支持：

- **模型切换**：每个会话可独立选择模型，新会话继承上一次偏好。
- **思考强度**：四档选择器 `disabled` / `medium` / `high` / `max`，UI 显示为“思考 off / 思考 mid / 思考 high / 思考 max”。
- **附件**：支持小图片、文件路径引用、文本片段三类附件。

重构范围限定在**底部聊天区域**（`Composer` 与 `NewSessionPane` 的输入区），不改动 `MessageList` 与会话顶部状态栏。

## 2. 设计决策

| 决策点 | 选择 | 说明 |
|--------|------|------|
| 布局风格 | 极简胶囊（方案 C） | 工具栏与输入框同行，符合 pi.dev 风格 |
| 状态持久化 | IndexedDB + localStorage | IndexedDB 存 per-session 偏好；localStorage 存全局默认 model/thinking |
| 后端依赖 | 新增 `fs:readFile` 接口 | 其余状态不走后端 |
| 附件内容 | 路径引用为主 | 小图片且模型支持 vision 时才读 base64 发送 |
| 多模态判断 | `ProviderModel.supportsVision` | 在供应商设置页配置 |

## 3. 架构与数据流

```
┌─────────────────────────────────────────────────────────────────┐
│                          Frontend                                │
│  Composer / NewSessionPane                                       │
│       │                                                          │
│       ▼                                                          │
│  useComposerPrefsStore (Zustand)                                 │
│       │                                                          │
│       ├─► IndexedDB (per-session model/thinking/attachments)     │
│       └─► localStorage (global defaults fallback)                │
│       │                                                          │
│       ▼                                                          │
│  PromptEvent { model, thinking, text, attachments }              │
│       │                                                          │
│       └──────────────────────────────────────► Kernel WS         │
│                                                   │              │
│                           ┌──────────────────────┘              │
│                           ▼                                      │
│                  fs:readFile (image attachments)                 │
│                           │                                      │
│                           ▼                                      │
│                拼成 UserMessage.content                          │
│                           │                                      │
│                           ▼                                      │
│                    LLM call (model/thinking overrides)           │
└─────────────────────────────────────────────────────────────────┘
```

## 4. UI 设计

### 4.1 Composer 布局

采用**极简胶囊**布局：外层是一个大的圆角卡片/胶囊容器，工具栏内嵌在容器底部，与输入区上下排列。

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│   输入消息...                                                       │
│                                                                     │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │ 📎 │ deepseek-chat ▼ │ 思考 off/mid/high/max │        [↑]      │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│   [图片.jpg] [readme.md] [代码片段...]  ← 附件 chips               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

- **输入区**：圆角容器上半部分为 textarea，自动增高。
- **内联工具栏**：容器底部一行，从左到右依次是：
  - **附件按钮**：📎，点击打开系统文件选择器。
  - **模型选择器**：显示当前模型名，点击下拉展示所有 `providers` 中配置的模型。没有配置任何 provider 时显示"未配置模型"并禁用发送（或提示去设置页添加）。
  - **思考选择器**：四档下拉选择，`disabled`（思考 off）、`medium`（思考 mid）、`high`（思考 high）、`max`（思考 max）。
  - **发送按钮**：右侧圆形箭头，有内容时高亮。
- **附件预览**：当存在附件时，在胶囊容器下方展开一行 chips：
  - 图片/文件：显示文件名 + 类型图标。
  - 文本片段：显示前 20 字。
  - 每个 chip 右上角有删除按钮。
  - 不显示图片缩略图，避免在前端 IndexedDB 中存储 base64 内容。

### 4.2 NewSessionPane 输入区

新建会话页的输入区同样采用胶囊布局，与 `Composer` **共用同一套控件组件**，具备完全一致的能力：

- 模型选择器（从 providers 读取可用模型）。
- 思考强度开关 `disabled` / `medium` / `high` / `max`。
- 附件按钮与附件预览 chips。
- 发送按钮。

区别仅在于：
- `Composer` 发送时已知 `sessionId`，直接走 `agent:prompt`。
- `NewSessionPane` 需要先创建 session（沿用现有 `randomSessionId()` 复用机制），再发送第一条消息。

## 5. 状态管理

### 5.1 Zustand Store

新增 `useComposerPrefsStore`：

```ts
export type ThinkingLevel = "disabled" | "medium" | "high" | "max";

interface SessionPrefs {
  model: string | null;
  thinking: ThinkingLevel;
  attachments: AttachmentDraft[];
}

interface ComposerPrefsState {
  defaults: { model: string | null; thinking: ThinkingLevel };
  bySession: Record<string, SessionPrefs>;
  setDefaults(prefs: Partial<{ model: string | null; thinking: ThinkingLevel }>): void;
  setSessionPrefs(sessionId: string, prefs: Partial<SessionPrefs>): void;
}
```

### 5.2 IndexedDB 持久化

封装 `composer-db.ts`，使用 `idb` 库存储：

```ts
interface ComposerSessionRecord {
  sessionId: string;
  model: string | null;
  thinking: ThinkingLevel;
  attachments: AttachmentDraft[];
  updatedAt: number;
}
```

- attachments 只存元数据（`path/name/content`），不存文件内容。
- 发送成功后清空当前 session 的 `attachments`。

### 5.3 初始化规则

1. **进入已有会话**：读 IndexedDB 中 `sessionId` 对应记录；没有则回退到全局默认值；再没有则回退到 agent config 默认 `model`。
2. **新建会话**：读全局默认值；没有则回退到 agent config 默认 `model`。
3. **用户切换 model/thinking**：同步更新 session 记录和全局默认值。

## 6. 附件处理

### 6.1 附件草稿类型

```ts
type AttachmentDraft =
  | { kind: "image"; name: string; path: string; size: number }
  | { kind: "file"; name: string; path: string; size: number }
  | { kind: "snippet"; name: string; content: string };
```

### 6.2 文件选择流程

支持三种方式添加文件/图片附件，最终都走统一的 `fs:upload` 自动上传到项目目录：

1. **点击 📎**：调用 `<input type="file">` 选择文件。
2. **粘贴**：在输入框按粘贴快捷键（`Ctrl/Cmd + V`），若剪贴板里是文件则直接上传。
3. **拖拽**：把文件从资源管理器/桌面拖到输入框区域松手，自动上传。

统一处理步骤：

1. 前端读取文件内容为 base64，通过 `fs:upload` 发送到 kernel。
2. kernel 将文件写入项目工作目录下的 `.hiagent/uploads/`，按文件名自动去重（同名追加序号）。
3. kernel 返回写入后的绝对路径，前端生成 `AttachmentDraft` 存入 IndexedDB。

> 注：早期方案要求用户手动补填绝对路径；现改为自动上传到项目目录，避免浏览器无法获取本地路径的问题，并保证附件与项目上下文共存。

### 6.3 发送时处理规则

前端在添加附件时仅按用户选择的文件类型标记 `kind: "image" | "file"`，不判断大小。后端 `agent:prompt` handler 收到 `attachments` 后统一处理：

- 所有 `image` / `file` 附件不再读取内容或转 base64，而是转成**项目相对路径**，以 `@` 引用格式追加到 prompt 末尾。
- `snippet` 直接生成 `TextContent` 内联到 prompt。

最终给模型的 prompt 格式如下：

```text
用户输入的文本

Attachments:
[@.hiagent/uploads/notes.txt,
@.hiagent/uploads/diagram.png]
```

前端 `MessageList` 渲染用户消息时，会剥掉末尾的 `Attachments:\n[...]` 块，因此用户气泡里只显示原文，但模型能收到路径引用并自行用 `read_file` 等工具读取。

> 注：`ProviderModel.supportsVision` 字段在供应商设置页仍保留，但附件不再根据该字段做 vision/base64 分支；统一走路径引用。

## 7. 协议变更

### 7.1 PromptEvent 扩展

```ts
export interface PromptEvent {
  type: "agent:prompt";
  projectId: string;
  sessionId: string;
  agentName: AgentName;
  text: string;
  model?: string;
  thinking?: ThinkingLevel;
  attachments?: AttachmentRef[];
}

type AttachmentRef =
  | { kind: "image"; name: string; path: string; size: number }
  | { kind: "file"; name: string; path: string; size: number }
  | { kind: "snippet"; name: string; content: string };
```

### 7.2 新增 fs:readFile / fs:upload

```ts
// 前端 → kernel
export interface FSReadFileRequest {
  type: "fs:readFile";
  path: string;
}

// kernel → 前端
export interface FSReadFileResult {
  type: "fs:readFile";
  path: string;
  content: string;      // base64
  mimeType?: string;
  error?: string;
}

// 前端 → kernel
export interface FSUploadRequest {
  type: "fs:upload";
  id: string;           // 用于前端关联异步响应
  projectId: string;
  name: string;         // 原始文件名
  content: string;      // base64
}

// kernel → 前端
export interface FSUploadResult {
  type: "fs:upload";
  id: string;
  path: string;         // 写入项目目录后的绝对路径
  error?: string;
}
```

### 7.3 ProviderModel 扩展

```ts
export interface ProviderModel {
  id: string;
  contextWindow: number;
  maxTokens: number;
  supportsVision?: boolean;  // 新增
}
```

供应商设置页的模型列表中，在"最大输出"列右侧增加"支持图片"开关，按模型单独配置。

## 8. 后端改动

1. **新增 `fs:readFile` handler**：读取指定路径，返回 base64 内容与 mimeType；失败返回 `error`。
2. **新增 `fs:upload` handler**：将前端上传的文件写入项目目录 `.hiagent/uploads/`，返回绝对路径；对文件名做防路径穿越处理，同名文件自动追加序号。
3. **`agent:prompt` handler 扩展**：
   - 使用 `model` 覆盖默认模型（优先级：PromptEvent.model > 当前 session 默认 > agent config.model）。
   - 使用 `thinking` 覆盖 reasoning effort：`disabled` 映射为 SDK 的 `"off"`；`medium` / `high` 透传；`max` 映射为 `"xhigh"`（DeepSeek 的 `thinkingLevelMap` 会把 `xhigh` 映射为 API 的 `"max"`，SDK 内部 `clampThinkingLevel` 会在模型不支持 `xhigh` 时自动降级到 `high`）。
   - 处理 `attachments`：按 6.3 规则转换为 `UserMessage.content`。
4. **供应商设置保存**：解析并保存 `supportsVision` 字段。

## 9. 错误处理

- **附件路径不存在**：`fs:readFile` 返回 error，前端在对应 chip 上显示红色错误提示；用户可删除后重发。
- **模型 ID 无效**：后端 LLM 调用失败，返回 `error` WS 事件，前端在当前会话显示系统错误消息。
- **图片过大或不支持 vision**：后端自动降级为路径引用，不调用 `fs:readFile` 读图。
- **IndexedDB 不可用**：降级为内存存储，应用重启后状态丢失但当前会话可用。

## 10. 测试策略

按项目 4 层测试要求：

- **单元测试**：
  - `attachmentToContent` 转换逻辑（图片/文件/片段、vision 支持判断、大小阈值）。
  - `useComposerPrefsStore` 初始化和更新逻辑。
  - IndexedDB 读写封装。

- **组件测试**：
  - `Composer` 渲染模型下拉、思考开关、附件 chips。
  - 附件删除、发送按钮禁用/启用、Enter 发送行为。

- **API 接口测试**：
  - 启动 kernel，发送带 `attachments` 的 `agent:prompt`。
  - 验证 `fs:readFile` 响应、图片被转成 `ImageContent`、文件被转成引用文本。

- **E2E 测试**：
  - Playwright 中选择文件附件、切换模型、切换思考强度、发送消息。
  - 断言消息列表中出现对应附件引用或图片内容。

## 11. 影响范围

- `packages/frontend/src/components/Composer.tsx`
- `packages/frontend/src/components/NewSessionPane.tsx`
- `packages/frontend/src/store/`（新增 composer prefs store、IndexedDB 封装）
- `packages/frontend/src/fs-client.ts`（新增 `readFile`）
- `packages/shared/src/types.ts`（`PromptEvent`、`FSReadFileRequest/Result`）
- `packages/shared/src/providers.ts`（`ProviderModel.supportsVision`）
- `packages/kernel/`（`fs:readFile` handler、`agent:prompt` 附件处理、供应商保存）
- `packages/frontend/src/components/settings/ProviderFormModal.tsx`（增加 vision 开关）
- `packages/frontend/tests/`（Composer、attachment 相关组件测试）
- `packages/kernel/` 对应测试
- `packages/frontend/e2e/`（E2E 测试）
