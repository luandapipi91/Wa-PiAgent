# 设计：聊天消息导出为图片（从当条消息往前，最多 5 轮文本对话）

**日期**: 2026-08-04
**状态**: 已确认（用户批准设计）
**范围**: `packages/frontend`（纯前端功能，不动 kernel / desktop）

---

## 1. 背景与目标

聊天窗目前只有「复制文本」能力（CopyButton，AI 回复最终文字段下方）。用户需要把一段对话以**图片**形式分享出去（微信/文档场景）。

需求（已与用户确认）：

1. AI 回复旁加「导出」icon，与复制按钮同排、同样式，**只出现在 AI 回复上**
2. 点击后把**从当条消息往前、最多 5 轮**的对话记录生成为 PNG 图片
3. 导出形式**两者都要**：下载 PNG 文件 + 复制图片到剪贴板（点击 icon 弹小菜单选择）

## 2. 已确认决策

| 决策点 | 选择 | 理由 |
| -------- | ------ | ------ |
| 导出内容 | **只要文本对话**（用户提问 + AI 最终文字回复） | 干净、适合分享；思考/工具调用/委派等过程卡片不导出 |
| 范围上限 | **最多 5 轮**（用户+AI 为一轮），从当条消息往前取 | 用户明确指定；5 轮单图远低于 canvas 高度上限（~16384px），无需缩放/切分 |
| 导出形式 | **下载 PNG + 复制到剪贴板**（小菜单二选） | 下载用于存档，复制用于直接粘贴微信/文档 |
| 实现方案 | **专用导出组件 + `html-to-image`（新增依赖 ~6KB）** | 自动内联计算样式与字体（MiSans/JetBrains Mono 为本地 woff2，同源可 fetch），markdown 渲染复用现有组件，保真高 |
| 图片样式 | **独立分享排版**（紧凑卡片），不追求与聊天窗逐像素一致 | 聊天 DOM 含折叠/流式/悬浮按钮等干扰，独立排版更干净 |
| 复制通道 | 复用既有 `copyImageToClipboard`（Electron 原生 `waPiClipboard.writeImage` / 浏览器 `ClipboardItem`） | `util/clipboard.ts` 已实现双端，零改动 |

## 3. 架构与组件拆分

```
MessageList.tsx
  └─ CopyButton 旁新增 ExportButton（icon + 小菜单：下载 PNG / 复制图片）
        │ 点击菜单项
        ▼
util/export-chat-image.ts（纯逻辑，可单测）
  ├─ collectTurns(messages, uptoTimestamp, maxTurns=5) → ExportTurn[]
  ├─ renderTurnsToPngBlob(turns) → Blob        ← 屏外 createRoot 渲染 ExportImageCard + html-to-image
  └─ downloadBlob(blob, filename)              ← a[download] 触发下载
        ▼
components/blocks/ExportImageCard.tsx（导出专用排版组件）
  └─ ReactMarkdown + createMarkdownComponents（复用现有 markdown 渲染映射）
```

### 新增/修改文件

| 文件 | 类型 | 职责 |
| ------ | ------ | ------ |
| `packages/frontend/src/util/export-chat-image.ts` | 新增 | 纯逻辑：消息切片（collectTurns）/ 屏外渲染转 PNG（renderTurnsToPngBlob）/ 下载（downloadBlob） |
| `packages/frontend/src/components/blocks/ExportImageCard.tsx` | 新增 | 导出排版组件：用户右气泡 + AI 左回复 + 底部「WA PI Agent」署名行 |
| `packages/frontend/src/components/MessageList.tsx` | 修改 | CopyButton 旁加 ExportButton（icon + 小菜单） |
| `packages/frontend/src/util/export-chat-image.test.ts` | 新增 | 单元测试：collectTurns 切片/过滤/上限/空结果 |
| `packages/frontend/src/components/blocks/ExportImageCard.test.tsx` | 新增 | 组件测试：排版渲染 + ExportButton 菜单交互 |
| `packages/frontend/e2e/chat-export.spec.ts` | 新增 | E2E：导出下载全流程 |
| `packages/frontend/package.json` | 修改 | 新增依赖 `html-to-image` |

## 4. 关键接口

```ts
// util/export-chat-image.ts
export interface ExportTurn {
  user: string;        // 用户消息纯文本（多段拼接）
  assistant: string;   // AI 最终回复纯文本（markdown 源文）
  agentName: string;   // AI 回复所属 agent（显示用）
  timestamp: number;   // AI 回复时间戳（显示用）
}

/** 从 messages 中定位 timestamp 为 uptoTimestamp 的 AI 消息，往前取最多 maxTurns 轮文本对话。
 *  一轮 = 一条 user 消息 + 其后最近一条 assistant 的最终文字回复。
 *  过滤：thinking / toolCall / toolResult / delegate / fleet 等过程块；assistant 只取 text 块。
 *  无文本对话时返回空数组。 */
export function collectTurns(
  messages: SessionMessage[],
  uptoTimestamp: number,
  maxTurns?: number,   // 缺省 5
): ExportTurn[];

/** 屏外渲染 ExportImageCard 并转 PNG Blob（pixelRatio=2；字体/样式由 html-to-image 内联）。 */
export async function renderTurnsToPngBlob(turns: ExportTurn[]): Promise<Blob>;

/** a[download] 触发浏览器下载。 */
export function downloadBlob(blob: Blob, filename: string): void;
```

消息数据结构：`useSessionStore(s => s.messagesBySession[sessionId])` 的 `SessionMessage`（role=user/assistant/toolResult，content 为块数组）。assistant 的文字块提取与 `MessageList.tsx` 现有 `fullText` 逻辑同口径（只取 text 块拼接）。

## 5. 交互与样式

- **图标约束**：本功能所有图标一律使用**内联 SVG**（与 CopyButton 的 svg 一致风格），禁止 emoji / icon font / 图片图标。
- **ExportButton**：与 CopyButton 同排（其左侧）、同尺寸同 hover 样式（`p-1 rounded-md text-tertiary opacity-60 hover:opacity-100 …`），icon 用下载箭头 svg，title「导出为图片」。点击弹出小菜单（两个选项：下载 PNG / 复制图片，菜单项图标也是内联 SVG），点外部关闭。
- **ExportImageCard 排版**（导出图片内容，与聊天窗无关的独立卡片）：
  - 白底/浅色底卡片，内边距 24px，宽 640px 固定
  - 每轮：用户消息靠右浅绿底气泡（纯文本，不渲染 markdown）；AI 回复靠左无气泡（markdown 渲染），上方小字 `agent名 · 时间`
  - 底部 hairline + 「WA PI Agent」署名
- **菜单/下载反馈**：成功 toast「图片已下载」/「图片已复制」；失败 toast「导出失败，请重试」；当条往前无文本对话时菜单两项禁用。

## 6. 数据流

```
点 ExportButton → 小菜单
  ├─ 下载 PNG：collectTurns → renderTurnsToPngBlob → downloadBlob(wa-pi-chat-{YYYYMMDD-HHmm}.png) → toast
  └─ 复制图片：collectTurns → renderTurnsToPngBlob → copyImageToClipboard(blob) → toast
```

数据全部来自前端 store（`messagesBySession`），无新增 API、不动 kernel。

## 7. 错误处理与边界

| 场景 | 处理 |
| ------ | ------ |
| 当条往前无文本对话（如只有工具过程） | 菜单两项禁用（title 提示「无可导出的文本对话」） |
| PNG 生成失败（canvas/字体异常） | toast「导出失败，请重试」 |
| 复制失败（浏览器 ClipboardItem 不支持/权限拒绝） | toast「复制失败」（既有 copyImageToClipboard 抛错路径） |
| 流式进行中点导出 | 允许：导出当前已落盘的文本（collectTurns 只看 messages 快照） |
| 超长 5 轮 | 不出现（maxTurns=5 硬上限）；单图高度远低于 canvas 上限 |

## 8. 测试策略（四层，对齐根 AGENTS.md §6）

1. **单元**（bun:test）：`collectTurns`——正序切片、5 轮上限、过程块过滤（thinking/toolCalls/delegate/fleet/toolResult）、无用户消息的轮跳过、空结果
2. **组件**（bun:test + RTL + happy-dom）：ExportImageCard 排版渲染（用户/AI 文本、署名行）；ExportButton 菜单展开/点选/外部关闭（PNG 生成 mock 掉 `export-chat-image` util——happy-dom 无 canvas）
3. **API 接口**：本功能无新增后端接口，**跳过**（纯前端）
4. **E2E**（Playwright）：创建会话发消息 → AI 回复上点导出 → 下载 PNG → 捕获 `page.waitForEvent("download")` 断言文件名与 PNG 魔数（`\x89PNG`）；复制路径在浏览器上下文断言 `navigator.clipboard.write` 被调（addInitScript 插桩）

## 9. 非目标（Non-Goals）

- 不导出思考过程/工具调用/委派卡片（用户已确认只要文本对话）
- 不复刻聊天窗样式（独立分享排版）
- 不做超长对话切分/缩放（5 轮上限内不会出现）
- 不做 PDF/Markdown 文本导出（pi 自带 export_html 是另一回事，不在本范围）
- 不做导出范围自定义（用户手动选轮数），V1 固定最近 5 轮

## 10. 依赖与风险

- **新增依赖 `html-to-image`**（~6KB gzip，MIT）：核心能力 = 克隆 DOM → 内联计算样式 → 内联 @font-face（同源 fetch woff2 转 base64）→ SVG foreignObject → canvas → PNG。与 MermaidBlock 既有 svgToPngBlob 套路同宗。
- 风险：html-to-image 对 `@font-face` 内联在 dev（vite）与 packaged（file:// 经 127.0.0.1 加载）两种环境下均需验证——E2E 覆盖 dev；packaged 验证列入交付清单（桌面版手动验证一次导出）。
