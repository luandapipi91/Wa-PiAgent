# 聊天消息导出为图片 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI 回复旁加「导出」icon，把从当条消息往前最多 5 轮的文本对话导出为 PNG（下载 / 复制到剪贴板）。

**Architecture:** 纯前端功能。`util/export-chat-image.ts` 提供 collectTurns（消息切片）/ renderTurnsToPngBlob（屏外渲染 + html-to-image）/ downloadBlob；`ExportImageCard` 是独立分享排版组件；`ExportButton`（手绘 SVG icon + 小菜单）挂在 MessageList 的 CopyButton 左侧。复制走既有 `copyImageToClipboard` 双端通道，无后端改动。

**Tech Stack:** React + Zustand、html-to-image（新增依赖）、bun:test + @testing-library/react + happy-dom（单测/组件测试）、Playwright（E2E）。

**Spec:** `docs/superpowers/specs/2026-08-04-chat-export-image-design.md`（已确认）

## Global Constraints

- 导出内容：**只要文本对话**（用户提问 + AI 最终文字回复）；thinking/toolCall/toolResult/delegate/fleet 等过程块一律不进导出。
- 范围：从当条 AI 回复往前**最多 5 轮**（`maxTurns = 5`）。
- 导出形式两者都要：下载 PNG（`a[download]`，文件名 `wa-pi-chat-{YYYYMMDD-HHmm}.png`）+ 复制图片到剪贴板（既有 `copyImageToClipboard`）。
- **图标一律手绘内联 SVG**（像 CopyButton 那样手写 `<svg><path/></svg>`），禁止引入图标库（lucide/iconify 等）、icon font、图片图标。
- UI 文案中文；代码注释中文；commit message 中文。
- frontend 测试在 `packages/frontend` 下跑 `bun test --isolate`；组件测试范例 `src/components/settings/CommandListModal.test.tsx`（bun:test + RTL + happy-dom）。
- 图片像素比 `pixelRatio: 2`；ExportImageCard 固定宽 640px、白底。
- 不改动 kernel / desktop / shared；唯一依赖变更是 frontend 新增 `html-to-image`。
- 改动完成后更新根 `CHANGELOG.md`（Task 4 统一）。

---

### Task 1: 消息切片与下载——export-chat-image util 纯逻辑部分

**Files:**
- Create: `packages/frontend/src/util/export-chat-image.ts`
- Test: `packages/frontend/src/util/export-chat-image.test.ts`

**Interfaces:**
- Consumes: `SessionMessage`（`@wa-pi/shared`：`{ message: AgentMessage; agentName?; sessionId? }`，`message.role/timestamp/content`，user 的 content 可能是 string，assistant 的 content 是块数组）。
- Produces（后续 Task 依赖的确切签名）:
  - `ExportTurn = { user: string; assistant: string; agentName: string; timestamp: number }`
  - `collectTurns(messages: SessionMessage[], uptoTimestamp: number, maxTurns = 5): ExportTurn[]`——定位 timestamp ≤ uptoTimestamp 的消息（含当条 AI 回复），合并同轮连续 assistant，逆序配对「assistant → 往前最近 user」，跳过无文字回复/无配对 user 的轮，返回**时间正序**数组。
  - `downloadBlob(blob: Blob, filename: string): void`
  - （Task 2 才会往同一文件加 `renderTurnsToPngBlob`，本任务不实现）

- [ ] **Step 1: 写失败测试**

创建 `packages/frontend/src/util/export-chat-image.test.ts`：

```ts
// export-chat-image 纯逻辑单测：collectTurns 切片/配对/过滤/上限 + downloadBlob。
import { test, expect } from "bun:test";
import { collectTurns, downloadBlob } from "./export-chat-image";

// 构造 SessionMessage 形 fixture（只保留 collectTurns 关心的字段）
function userMsg(text: string, ts: number) {
	return { message: { role: "user", content: text, timestamp: ts } } as any;
}
function aiMsg(texts: string[], ts: number, agentName = "dev", extraBlocks: any[] = []) {
	return {
		message: {
			role: "assistant",
			content: [
				...extraBlocks,
				...texts.map((t) => ({ type: "text", text: t })),
			],
			timestamp: ts,
		},
		agentName,
	} as any;
}

test("基本配对：user + 后续 assistant 合成一轮，时间正序返回", () => {
	const msgs = [userMsg("问题一", 100), aiMsg(["回答一"], 200)];
	const turns = collectTurns(msgs, 200);
	expect(turns).toEqual([
		{ user: "问题一", assistant: "回答一", agentName: "dev", timestamp: 200 },
	]);
});

test("范围：只取 uptoTimestamp（含）之前的消息", () => {
	const msgs = [
		userMsg("早问题", 100), aiMsg(["早回答"], 200),
		userMsg("晚问题", 300), aiMsg(["晚回答"], 400),
	];
	const turns = collectTurns(msgs, 200);
	expect(turns).toHaveLength(1);
	expect(turns[0].user).toBe("早问题");
});

test("5 轮上限：超过时只保留最近 5 轮", () => {
	const msgs: any[] = [];
	for (let i = 0; i < 8; i++) {
		msgs.push(userMsg(`问题${i}`, i * 100));
		msgs.push(aiMsg([`回答${i}`], i * 100 + 50));
	}
	const turns = collectTurns(msgs, 9999);
	expect(turns).toHaveLength(5);
	expect(turns[0].user).toBe("问题3"); // 最早两轮被截掉
	expect(turns[4].user).toBe("问题7");
});

test("过程块过滤：thinking/toolCall 不进导出，同轮拆分 assistant 合并", () => {
	const msgs = [
		userMsg("问题", 100),
		aiMsg(["前半"], 200, "dev", [{ type: "thinking", thinking: "想…" }]),
		aiMsg(["后半"], 300, "dev", [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }]),
	];
	const turns = collectTurns(msgs, 300);
	expect(turns).toHaveLength(1);
	expect(turns[0].assistant).toBe("前半\n\n后半"); // text 块 \n\n 拼接（与 MessageList fullText 同口径）
	expect(turns[0].timestamp).toBe(300); // 轮结束时刻
});

test("纯过程轮（无文字回复）跳过；无配对 user 的 assistant 跳过", () => {
	const msgs = [
		aiMsg([], 50, "dev", [{ type: "toolCall", id: "c0", name: "bash", arguments: {} }]), // 无文字
		userMsg("问题", 100),
		aiMsg(["回答"], 200),
	];
	const turns = collectTurns(msgs, 200);
	expect(turns).toHaveLength(1);
	expect(turns[0].assistant).toBe("回答");
});

test("空结果：当条往前无文本对话返回空数组", () => {
	const msgs = [
		aiMsg([], 100, "dev", [{ type: "thinking", thinking: "只想不说" }]),
	];
	expect(collectTurns(msgs, 100)).toEqual([]);
	expect(collectTurns([], 100)).toEqual([]);
});

test("downloadBlob：创建 a[download] 并触发 click", () => {
	// happy-dom 无 URL.createObjectURL，打桩
	(URL as any).createObjectURL = () => "blob:mock";
	(URL as any).revokeObjectURL = () => {};
	const clicks: string[] = [];
	const origClick = HTMLAnchorElement.prototype.click;
	HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
		clicks.push(this.download);
	};
	try {
		downloadBlob(new Blob(["x"]), "wa-pi-chat-test.png");
		expect(clicks).toEqual(["wa-pi-chat-test.png"]);
	} finally {
		HTMLAnchorElement.prototype.click = origClick;
	}
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd packages/frontend && bun test --isolate src/util/export-chat-image.test.ts
```

预期：FAIL（`Cannot find module "./export-chat-image"`）。

- [ ] **Step 3: 实现 util/export-chat-image.ts（纯逻辑部分）**

创建 `packages/frontend/src/util/export-chat-image.ts`：

```ts
// export-chat-image.ts — 聊天消息导出为图片的逻辑层。
// collectTurns：从会话消息切片出「当条 AI 回复往前最多 5 轮」的文本对话；
// downloadBlob：a[download] 触发浏览器下载；
// renderTurnsToPngBlob（屏外渲染转 PNG）在 Task 2 加入本文件。
import type { SessionMessage } from "@wa-pi/shared";

export interface ExportTurn {
	user: string; // 用户消息纯文本
	assistant: string; // AI 回复 markdown 源文（text 块拼接）
	agentName: string; // AI 回复所属 agent（显示用）
	timestamp: number; // AI 回复（轮结束）时间戳
}

/** 提取消息文本：user content 可能是 string；assistant 只取 text 块（与 MessageList fullText 同口径，\n\n 拼接） */
function extractText(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b?.type === "text")
		.map((b) => String(b.text ?? ""))
		.join("\n\n");
}

/**
 * 从 messages 中截取 timestamp ≤ uptoTimestamp 的部分（含当条 AI 回复），
 * 往前取最多 maxTurns 轮文本对话（一轮 = 一条 user + 其后最近一条 assistant 的文字回复）。
 * 同轮连续 assistant（历史 jsonl 会按 toolCall 拆成多条）先合并；纯过程轮 / 无配对 user 的轮跳过。
 * 返回时间正序数组；无文本对话时返回 []。
 */
export function collectTurns(
	messages: SessionMessage[],
	uptoTimestamp: number,
	maxTurns = 5,
): ExportTurn[] {
	// 1. 只留当条（含）之前的 user/assistant
	const eligible = messages.filter((sm) => {
		const m = sm.message as any;
		const ts = typeof m.timestamp === "number" ? m.timestamp : 0;
		return ts <= uptoTimestamp && (m.role === "user" || m.role === "assistant");
	});
	// 2. 合并同轮连续 assistant（拷贝后合并，不改原数组）
	const merged: SessionMessage[] = [];
	for (const sm of eligible) {
		const m = sm.message as any;
		const prevRow = merged[merged.length - 1];
		const prev = prevRow?.message as any;
		if (m.role === "assistant" && prev?.role === "assistant") {
			prev.content = [
				...(Array.isArray(prev.content) ? prev.content : []),
				...(Array.isArray(m.content) ? m.content : []),
			];
			prev.timestamp = m.timestamp; // 轮结束时刻
			continue;
		}
		merged.push({
			...sm,
			message: {
				...m,
				content: Array.isArray(m.content) ? [...m.content] : m.content,
			},
		});
	}
	// 3. 逆序配对：assistant → 往前最近的 user
	const turns: ExportTurn[] = [];
	let i = merged.length - 1;
	while (i >= 0 && turns.length < maxTurns) {
		const sm = merged[i];
		const m = sm.message as any;
		if (m.role !== "assistant") {
			i--;
			continue;
		}
		const assistant = extractText(m.content).trim();
		if (!assistant) {
			i--;
			continue; // 纯过程轮（无文字回复）跳过
		}
		let user = "";
		let j = i - 1;
		for (; j >= 0; j--) {
			const um = merged[j].message as any;
			if (um.role === "user") {
				user = extractText(um.content).trim();
				break;
			}
		}
		if (user) {
			turns.push({
				user,
				assistant,
				agentName: sm.agentName ?? "agent",
				timestamp: m.timestamp,
			});
		}
		i = Math.min(j, i - 1); // 跳过已配对的 user；未找到（j=-1）时循环终止
	}
	return turns.reverse();
}

/** a[download] 触发浏览器下载。 */
export function downloadBlob(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd packages/frontend && bun test --isolate src/util/export-chat-image.test.ts
```

预期：7 pass, 0 fail。

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/util/export-chat-image.ts packages/frontend/src/util/export-chat-image.test.ts
git commit -m "feat(frontend): 聊天导出 collectTurns 消息切片 + downloadBlob（纯逻辑）"
```

---

### Task 2: 导出排版组件 + 屏外渲染转 PNG

**Files:**
- Create: `packages/frontend/src/components/blocks/ExportImageCard.tsx`
- Modify: `packages/frontend/src/util/export-chat-image.ts`（追加 `renderTurnsToPngBlob`）
- Modify: `packages/frontend/src/util/export-chat-image.test.ts`（追加 renderTurnsToPngBlob 测试）
- Test: `packages/frontend/src/components/blocks/ExportImageCard.test.tsx`
- Modify: `packages/frontend/package.json`（bun add 自动完成）

**Interfaces:**
- Consumes: Task 1 的 `ExportTurn`；`createMarkdownComponents(sessionId)`（`./markdown-components.tsx:32`，返回 react-markdown 的 components 映射，含 mermaid/代码块/FilePill 渲染）；`ReactMarkdown + remarkGfm`（既有依赖）。
- Produces:
  - `ExportImageCard({ turns }: { turns: ExportTurn[] })`——导出排版组件（data-testid `export-image-card`）。
  - `renderTurnsToPngBlob(turns: ExportTurn[]): Promise<Blob>`（追加进 `util/export-chat-image.ts`）——屏外渲染 ExportImageCard 后用 html-to-image 转 PNG（`pixelRatio: 2`）。Task 3 的 ExportButton 消费它。

- [ ] **Step 1: 安装 html-to-image**

```bash
cd packages/frontend && bun add html-to-image
```

验证：`grep '"html-to-image"' packages/frontend/package.json` 有输出。

- [ ] **Step 2: 写失败测试（ExportImageCard 渲染 + renderTurnsToPngBlob）**

创建 `packages/frontend/src/components/blocks/ExportImageCard.test.tsx`：

```tsx
// ExportImageCard 排版测试：用户气泡 / AI markdown / 署名行。
import { test, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import { ExportImageCard } from "./ExportImageCard";

const TURNS = [
	{ user: "什么是 TDD？", assistant: "**TDD** 是先写测试。", agentName: "dev", timestamp: new Date(2026, 7, 4, 15, 30).getTime() },
	{ user: "第二轮问题", assistant: "第二轮回答", agentName: "dev", timestamp: new Date(2026, 7, 4, 15, 32).getTime() },
];

test("渲染用户消息与 AI 回复（markdown 渲染为 HTML）", () => {
	render(<ExportImageCard turns={TURNS} />);
	expect(screen.getByText("什么是 TDD？")).toBeTruthy();
	expect(screen.getByText("第二轮问题")).toBeTruthy();
	// markdown 加粗 → <strong>
	const strong = document.querySelector("strong");
	expect(strong?.textContent).toBe("TDD");
	// agent 名 + 时间标注
	expect(screen.getAllByText(/dev · 15:3\d/).length).toBe(2);
});

test("底部署名行 WA PI Agent", () => {
	render(<ExportImageCard turns={TURNS} />);
	expect(screen.getByText("WA PI Agent")).toBeTruthy();
});
```

在 `packages/frontend/src/util/export-chat-image.test.ts` 末尾追加（文件顶部 import 处加 `renderTurnsToPngBlob`，并加 `import { mock } from "bun:test"`）：

```ts
// renderTurnsToPngBlob：mock html-to-image（happy-dom 无 canvas），
// 验证屏外容器挂载/卸载与 toBlob 调用参数。
mock.module("html-to-image", () => ({
	toBlob: async (node: HTMLElement, opts: any) => {
		(globalThis as any).__toBlobArgs = { text: node.textContent, opts };
		return new Blob(["png-bytes"], { type: "image/png" });
	},
}));

test("renderTurnsToPngBlob：屏外渲染卡片→toBlob→清理容器", async () => {
	const before = document.body.children.length;
	const blob = await renderTurnsToPngBlob([
		{ user: "问", assistant: "答", agentName: "dev", timestamp: 100 },
	]);
	expect(blob.type).toBe("image/png");
	const args = (globalThis as any).__toBlobArgs;
	expect(args.text).toContain("问");
	expect(args.text).toContain("答");
	expect(args.opts.pixelRatio).toBe(2);
	// 容器已清理（不残留屏外 DOM）
	expect(document.body.children.length).toBe(before);
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd packages/frontend && bun test --isolate src/components/blocks/ExportImageCard.test.tsx src/util/export-chat-image.test.ts
```

预期：FAIL（`Cannot find module "./ExportImageCard"` / `renderTurnsToPngBlob is not exported`）。

- [ ] **Step 4: 实现 ExportImageCard.tsx**

创建 `packages/frontend/src/components/blocks/ExportImageCard.tsx`：

```tsx
// ExportImageCard — 聊天导出图片的专用排版组件（屏外渲染后转 PNG）。
// 独立分享排版：用户右气泡（纯文本）+ AI 左回复（markdown）+ 底部署名；
// 不含思考/工具等过程卡片，不含聊天窗装饰。Tailwind 类与主题变量可用——
// 节点渲染在真实文档中（屏外定位），html-to-image 负责内联计算样式与字体。
import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createMarkdownComponents } from "./markdown-components";
import type { ExportTurn } from "../../util/export-chat-image";

interface Props {
	turns: ExportTurn[];
}

function formatTime(ts: number): string {
	const d = new Date(ts);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ExportImageCard({ turns }: Props) {
	// "export" 是占位 sessionId：FilePill 等交互组件在图片里只是静态样式
	const mdComponents = useMemo(() => createMarkdownComponents("export"), []);
	return (
		<div
			data-testid="export-image-card"
			className="bg-canvas text-primary"
			style={{ width: 640, padding: 24, fontFamily: '"MiSans", system-ui, sans-serif' }}
		>
			{turns.map((t, i) => (
				<div key={i} className="flex flex-col gap-2 mb-5">
					{/* 用户消息：靠右气泡，纯文本不渲染 markdown */}
					<div className="flex justify-end">
						<div
							className="max-w-[80%] px-3.5 py-2.5 text-[13.5px] whitespace-pre-wrap bg-accent-soft text-primary"
							style={{ lineHeight: 1.55, borderRadius: "14px 4px 14px 14px" }}
						>
							{t.user}
						</div>
					</div>
					{/* AI 回复：靠左，markdown 渲染 */}
					<div>
						<div className="text-[11px] text-tertiary font-semibold mb-0.5">
							{t.agentName} · {formatTime(t.timestamp)}
						</div>
						<div
							className="prose prose-sm max-w-none text-[13.5px]"
							style={{ lineHeight: 1.55 }}
						>
							<ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
								{t.assistant}
							</ReactMarkdown>
						</div>
					</div>
				</div>
			))}
			<div className="border-t border-hairline pt-2 mt-1 text-center text-[11px] text-tertiary">
				WA PI Agent
			</div>
		</div>
	);
}
```

- [ ] **Step 5: 追加 renderTurnsToPngBlob 到 util/export-chat-image.ts**

在 `packages/frontend/src/util/export-chat-image.ts` 顶部 import 区追加：

```ts
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { toBlob } from "html-to-image";
import { ExportImageCard } from "../components/blocks/ExportImageCard";
```

文件末尾追加：

```ts
/**
 * 屏外渲染 ExportImageCard 并转 PNG Blob。
 * 容器 fixed 定位到视口外（display:none 会导致布局为 0，不能用）；
 * toBlob 负责内联计算样式与 @font-face（MiSans/JetBrains Mono 为同源 woff2）。
 */
export async function renderTurnsToPngBlob(turns: ExportTurn[]): Promise<Blob> {
	const host = document.createElement("div");
	host.style.position = "fixed";
	host.style.left = "-10000px";
	host.style.top = "0";
	host.style.pointerEvents = "none";
	document.body.appendChild(host);
	const root = createRoot(host);
	try {
		root.render(createElement(ExportImageCard, { turns }));
		// 等 React 提交 + 字体加载（图片里不缺字形）
		await new Promise((r) => setTimeout(r, 50));
		await (document as any).fonts?.ready;
		const card = host.firstElementChild as HTMLElement;
		if (!card) throw new Error("导出卡片渲染失败");
		const blob = await toBlob(card, { pixelRatio: 2 });
		if (!blob) throw new Error("PNG 生成失败");
		return blob;
	} finally {
		root.unmount();
		host.remove();
	}
}
```

- [ ] **Step 6: 跑测试确认通过**

```bash
cd packages/frontend && bun test --isolate src/components/blocks/ExportImageCard.test.tsx src/util/export-chat-image.test.ts
```

预期：全部 pass（ExportImageCard 2 例 + util 累计 8 例）。

- [ ] **Step 7: Commit**

```bash
git add packages/frontend/src/components/blocks/ExportImageCard.tsx packages/frontend/src/components/blocks/ExportImageCard.test.tsx packages/frontend/src/util/export-chat-image.ts packages/frontend/src/util/export-chat-image.test.ts packages/frontend/package.json
git commit -m "feat(frontend): ExportImageCard 导出排版组件 + 屏外渲染转 PNG（html-to-image）"
```

---

### Task 3: ExportButton + MessageList 接入

**Files:**
- Create: `packages/frontend/src/components/blocks/ExportButton.tsx`
- Modify: `packages/frontend/src/components/MessageList.tsx`（import + CopyButton 旁挂载，约 814-820 行处）
- Test: `packages/frontend/src/components/blocks/ExportButton.test.tsx`

**Interfaces:**
- Consumes: Task 1/2 的 `collectTurns(messages, uptoTimestamp)`、`renderTurnsToPngBlob(turns)`、`downloadBlob(blob, filename)`；既有 `copyImageToClipboard(blob)`（`util/clipboard.ts`）；`useSessionStore`（`messagesBySession`）；`useToastStore`（`add`）。
- Produces: `ExportButton({ sessionId, uptoTimestamp }: { sessionId: string; uptoTimestamp: number })`——手绘 SVG 下载 icon + 小菜单（data-testid：按钮 `export-${sessionId}-${uptoTimestamp}`，菜单项 `export-download` / `export-copy`）。MessageList 在 CopyButton 左侧挂载。

- [ ] **Step 1: 写失败测试**

创建 `packages/frontend/src/components/blocks/ExportButton.test.tsx`：

```tsx
// ExportButton 交互测试：菜单展开/点选调用链/外部关闭/无内容禁用。
// mock 整个 export-chat-image 模块：collectTurns 的正确性由 Task 1 单测保证，
// 这里只验证 ExportButton 对 collectTurns 结果的消费方式（禁用判断/传参），
// renderTurnsToPngBlob/downloadBlob/copyImageToClipboard 用 mock（happy-dom 无 canvas）。
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { useSessionStore } from "../../store/session";

const collectMock = mock(() => [] as any[]);
const renderMock = mock(async () => new Blob(["png"], { type: "image/png" }));
const downloadMock = mock(() => {});
const copyImageMock = mock(async () => {});

mock.module("../../util/export-chat-image", () => ({
	collectTurns: collectMock,
	renderTurnsToPngBlob: renderMock,
	downloadBlob: downloadMock,
}));
mock.module("../../util/clipboard", () => ({
	copyImageToClipboard: copyImageMock,
	copyToClipboard: async () => {},
}));

import { ExportButton } from "./ExportButton";

const SID = "s1";
const ONE_TURN = [{ user: "问题", assistant: "回答", agentName: "dev", timestamp: 200 }];
const MESSAGES = [
	{ message: { role: "user", content: "问题", timestamp: 100 } },
	{ message: { role: "assistant", content: [{ type: "text", text: "回答" }], timestamp: 200 }, agentName: "dev" },
] as any[];

beforeEach(() => {
	collectMock.mockReset();
	renderMock.mockClear();
	downloadMock.mockClear();
	copyImageMock.mockClear();
	collectMock.mockReturnValue(ONE_TURN);
	useSessionStore.setState({ messagesBySession: { [SID]: MESSAGES } } as any);
});

test("点 icon 展开菜单（两项），再点外部关闭", () => {
	render(<ExportButton sessionId={SID} uptoTimestamp={200} />);
	fireEvent.click(screen.getByTestId(`export-${SID}-200`));
	expect(screen.getByTestId("export-download")).toBeTruthy();
	expect(screen.getByTestId("export-copy")).toBeTruthy();
	fireEvent.mouseDown(document.body);
	expect(screen.queryByTestId("export-download")).toBeNull();
});

test("下载 PNG：collectTurns 出参传给 renderTurnsToPngBlob，downloadBlob 文件名 wa-pi-chat- 开头", async () => {
	render(<ExportButton sessionId={SID} uptoTimestamp={200} />);
	fireEvent.click(screen.getByTestId(`export-${SID}-200`));
	fireEvent.click(screen.getByTestId("export-download"));
	await new Promise((r) => setTimeout(r, 10));
	expect(renderMock).toHaveBeenCalledTimes(1);
	expect(renderMock.mock.calls[0][0]).toEqual(ONE_TURN);
	expect(downloadMock).toHaveBeenCalledTimes(1);
	const name = downloadMock.mock.calls[0][1] as string;
	expect(name.startsWith("wa-pi-chat-")).toBe(true);
	expect(name.endsWith(".png")).toBe(true);
});

test("复制图片：renderTurnsToPngBlob + copyImageToClipboard 被调", async () => {
	render(<ExportButton sessionId={SID} uptoTimestamp={200} />);
	fireEvent.click(screen.getByTestId(`export-${SID}-200`));
	fireEvent.click(screen.getByTestId("export-copy"));
	await new Promise((r) => setTimeout(r, 10));
	expect(renderMock).toHaveBeenCalledTimes(1);
	expect(copyImageMock).toHaveBeenCalledTimes(1);
});

test("无文本对话时菜单两项禁用", () => {
	collectMock.mockReturnValue([]);
	render(<ExportButton sessionId={SID} uptoTimestamp={200} />);
	fireEvent.click(screen.getByTestId(`export-${SID}-200`));
	expect((screen.getByTestId("export-download") as HTMLButtonElement).disabled).toBe(true);
	expect((screen.getByTestId("export-copy") as HTMLButtonElement).disabled).toBe(true);
});

test("生成失败 toast 报错、不抛异常", async () => {
	renderMock.mockRejectedValueOnce(new Error("canvas boom"));
	render(<ExportButton sessionId={SID} uptoTimestamp={200} />);
	fireEvent.click(screen.getByTestId(`export-${SID}-200`));
	fireEvent.click(screen.getByTestId("export-download"));
	await new Promise((r) => setTimeout(r, 10));
	expect(downloadMock).not.toHaveBeenCalled();
	// 不抛异常即通过（toast 文案属实现细节，store 已有覆盖）
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd packages/frontend && bun test --isolate src/components/blocks/ExportButton.test.tsx
```

预期：FAIL（`Cannot find module "./ExportButton"`）。

- [ ] **Step 3: 实现 ExportButton.tsx**

创建 `packages/frontend/src/components/blocks/ExportButton.tsx`（两个手绘 SVG：下载箭头、图片图标；风格对齐 MessageList CopyButton 的手写 svg）：

```tsx
// ExportButton — AI 回复旁的「导出为图片」按钮（CopyButton 同排左侧）。
// 点击弹小菜单：下载 PNG（a[download]）/ 复制图片（copyImageToClipboard 双端）。
// 图标一律手绘内联 SVG（项目约定：不引图标库）。
import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "../../store/session";
import { useToastStore } from "../../store/toast";
import { copyImageToClipboard } from "../../util/clipboard";
import {
	collectTurns,
	downloadBlob,
	renderTurnsToPngBlob,
} from "../../util/export-chat-image";

interface Props {
	sessionId: string;
	uptoTimestamp: number; // 当条 AI 回复时间戳（导出范围右端点）
}

function DownloadIcon() {
	return (
		<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
			<polyline points="7 10 12 15 17 10" />
			<line x1="12" y1="15" x2="12" y2="3" />
		</svg>
	);
}

function ImageIcon() {
	return (
		<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
			<circle cx="8.5" cy="8.5" r="1.5" />
			<polyline points="21 15 16 10 5 21" />
		</svg>
	);
}

/** 导出文件名时间戳：wa-pi-chat-YYYYMMDD-HHmm.png */
function exportFilename(ts: number): string {
	const d = new Date(ts);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `wa-pi-chat-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.png`;
}

export function ExportButton({ sessionId, uptoTimestamp }: Props) {
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const addToast = useToastStore((s) => s.add);
	const wrapRef = useRef<HTMLDivElement>(null);

	// 点外部关闭菜单
	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [open]);

	const hasTurns = () => {
		const msgs = useSessionStore.getState().messagesBySession[sessionId] ?? [];
		return collectTurns(msgs, uptoTimestamp).length > 0;
	};

	const run = async (mode: "download" | "copy") => {
		setOpen(false);
		if (busy) return;
		setBusy(true);
		try {
			const msgs = useSessionStore.getState().messagesBySession[sessionId] ?? [];
			const turns = collectTurns(msgs, uptoTimestamp);
			if (turns.length === 0) {
				addToast("无可导出的文本对话", "error");
				return;
			}
			const blob = await renderTurnsToPngBlob(turns);
			if (mode === "download") {
				downloadBlob(blob, exportFilename(uptoTimestamp));
				addToast("图片已下载", "success");
			} else {
				await copyImageToClipboard(blob);
				addToast("图片已复制", "success");
			}
		} catch {
			// spec §7：复制失败与生成失败文案区分（剪贴板权限拒绝走「复制失败」）
			addToast(mode === "copy" ? "复制失败" : "导出失败，请重试", "error");
		} finally {
			setBusy(false);
		}
	};

	const disabled = !hasTurns();
	const itemCls = (off: boolean) =>
		`flex items-center gap-1.5 px-3 py-1.5 text-xs w-full text-left border-0 ${off ? "text-tertiary cursor-not-allowed" : "text-primary hover:bg-surface-elevated cursor-pointer"}`;

	return (
		<div ref={wrapRef} className="relative">
			<button
				type="button"
				data-testid={`export-${sessionId}-${uptoTimestamp}`}
				onClick={() => setOpen((v) => !v)}
				disabled={busy}
				className="p-1 rounded-md text-tertiary opacity-60 hover:opacity-100 hover:text-primary hover:bg-surface-elevated transition-colors"
				title="导出为图片"
				aria-label="导出为图片"
			>
				<DownloadIcon />
			</button>
			{open && (
				<div className="absolute right-0 top-7 z-20 bg-surface border border-hairline rounded-md shadow-lg py-1 w-32">
					<button
						type="button"
						data-testid="export-download"
						disabled={disabled}
						onClick={() => void run("download")}
						className={itemCls(disabled)}
					>
						<DownloadIcon /> 下载 PNG
					</button>
					<button
						type="button"
						data-testid="export-copy"
						disabled={disabled}
						onClick={() => void run("copy")}
						className={itemCls(disabled)}
					>
						<ImageIcon /> 复制图片
					</button>
				</div>
			)}
		</div>
	);
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd packages/frontend && bun test --isolate src/components/blocks/ExportButton.test.tsx
```

预期：5 pass, 0 fail。

- [ ] **Step 5: MessageList 接入**

修改 `packages/frontend/src/components/MessageList.tsx`：

import 区（约 20 行 `import { copyToClipboard } ...` 附近）追加：

```tsx
import { ExportButton } from "./blocks/ExportButton";
```

找到 CopyButton 挂载点（`{seg === segments[lastTextSegIdx] && (` 块，约 813-820 行），改为：

```tsx
					{seg === segments[lastTextSegIdx] && (
						<div className="flex justify-end items-center">
							<ExportButton
								sessionId={sessionId}
								uptoTimestamp={m.timestamp}
							/>
							<CopyButton
								text={fullText}
								testId={`copy-${sessionId}-${m.timestamp}`}
							/>
						</div>
					)}
```

- [ ] **Step 6: 全量验证**

```bash
cd packages/frontend && bun test --isolate src/components/blocks/ src/util/ src/store/ && bun run typecheck
```

预期：全部 pass，typecheck 无错。（全量套件由 Task 4 跑，避免此处 8 分钟长等。）

- [ ] **Step 7: Commit**

```bash
git add packages/frontend/src/components/blocks/ExportButton.tsx packages/frontend/src/components/blocks/ExportButton.test.tsx packages/frontend/src/components/MessageList.tsx
git commit -m "feat(frontend): AI 回复旁导出按钮（下载 PNG / 复制图片小菜单）"
```

---

### Task 4: E2E + CHANGELOG 收尾

**Files:**
- Create: `packages/frontend/e2e/chat-export.spec.ts`
- Modify: `CHANGELOG.md`（根目录，顶部新段落）

**Interfaces:**
- Consumes: Task 3 的 testid 契约（`export-${sessionId}-${ts}` 前缀定位、`export-download`、`export-copy`）；既有 e2e 基建（`e2e/helpers.ts` 的 `saveProvider`；`chat-blocks.spec.ts` 的 deepseek harness 范式）。
- Produces: `cd packages/frontend && bunx playwright test e2e/chat-export.spec.ts` 通过。

- [ ] **Step 1: 实现 e2e/chat-export.spec.ts**

创建 `packages/frontend/e2e/chat-export.spec.ts`（deepseek harness 复制自 `chat-blocks.spec.ts` 既有范式，真实 LLM 一轮对话后导出）：

```ts
// 聊天导出 E2E：真实 LLM 一轮对话 → AI 回复上点导出 → 下载 PNG（断言魔数）/ 复制图片（断言剪贴板调用）。
// harness 复用 chat-blocks.spec.ts 范式：隔离 WA_PI_DIR 由 global-setup 提供，
// deepseek apiKey 运行时从本机凭证库读取（不落盘）。
// 本机 dev（5180）/真实 kernel（9776）在跑时必须带偏移端口：
//   WA_PI_E2E_WEB_PORT=5190 WA_PI_WEB_PORT=5190 WA_PI_E2E_WS_PORT=9786 bunx playwright test e2e/chat-export.spec.ts
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { saveProvider } from "./helpers";

/** 运行时读 deepseek apiKey（与 chat-blocks.spec.ts 同一约定） */
function readDeepseekKey(): string {
	const home = process.env.HOME || process.env.USERPROFILE || ".";
	try {
		const auth = JSON.parse(readFileSync(join(home, ".pi", "agent", "auth.json"), "utf8"));
		const key = auth?.deepseek?.key;
		if (key) return key;
	} catch {}
	try {
		const store = JSON.parse(readFileSync(join(home, ".wa-pi", "providers.json"), "utf8"));
		const list = Array.isArray(store) ? store : (store.providers ?? []);
		const ds = list.find((p: any) => String(p.baseUrl ?? "").includes("deepseek"));
		if (ds?.apiKey) return ds.apiKey;
	} catch {}
	throw new Error("未找到 deepseek apiKey，无法执行 LLM E2E");
}

// 真实模型偶发不按指令输出 → 允许一次重试（断言不放宽）
test.describe.configure({ retries: 1 });

test("导出为图片：下载 PNG 文件 + 复制图片到剪贴板", async ({ page }) => {
	test.setTimeout(300_000);

	// 剪贴板插桩（headless Chromium 无真实系统剪贴板，记录 write 调用）
	await page.addInitScript(() => {
		(window as any).__clipWrites = 0;
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				write: async () => { (window as any).__clipWrites++; },
				writeText: async () => {},
			},
		});
	});

	// 1. 注入 deepseek provider + 打开项目
	const apiKey = readDeepseekKey();
	await page.goto("/");
	await saveProvider({
		id: randomUUID(),
		name: "DeepSeek",
		baseUrl: "https://api.deepseek.com",
		apiKey,
		api: "openai-completions",
		models: [{ id: "deepseek-v4-flash", contextWindow: 1000000, maxTokens: 384000 }],
	});
	await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 10_000 });
	await page.getByTestId("model-selector").selectOption("deepseek/deepseek-v4-flash");

	// 2. 发一轮指令化 prompt（短回复，降低随机性）
	await page.getByRole("textbox").fill("只回复「导出测试成功」这六个字，不要说任何其他内容。");
	await page.getByTestId("composer-send").click();
	await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 10_000 });

	// 3. 等 AI 回复落位（CopyButton 出现 = 最终文字段渲染完成）
	const copyBtn = page.locator('[data-testid^="copy-"]').last();
	await expect(copyBtn).toBeVisible({ timeout: 180_000 });

	// 4. 下载 PNG：捕获 download 事件，断言文件名与 PNG 魔数
	const exportBtn = page.locator('[data-testid^="export-"]').last();
	await exportBtn.click();
	const [download] = await Promise.all([
		page.waitForEvent("download", { timeout: 60_000 }),
		page.getByTestId("export-download").click(),
	]);
	expect(download.suggestedFilename()).toMatch(/^wa-pi-chat-.*\.png$/);
	const path = await download.path();
	const buf = readFileSync(path!);
	expect([...buf.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]); // \x89PNG
	expect(buf.length).toBeGreaterThan(1000); // 非空图片

	// 5. 复制图片：断言剪贴板 write 被调（插桩计数 +1）
	await exportBtn.click();
	await page.getByTestId("export-copy").click();
	await expect
		.poll(() => page.evaluate(() => (window as any).__clipWrites), { timeout: 60_000 })
		.toBe(1);

	// 数据清理：会话/项目在 E2E_WA_PI_DIR 隔离目录内，global-teardown 整体清除；
	// 本用例不产生截图（Playwright 失败产物 test-results/ 跑完删除）。
});
```

- [ ] **Step 2: 跑 E2E 确认通过**

```bash
cd packages/frontend && WA_PI_E2E_WEB_PORT=5190 WA_PI_WEB_PORT=5190 WA_PI_E2E_WS_PORT=9786 bunx playwright test e2e/chat-export.spec.ts
```

预期：1 passed。本机无 deepseek 凭证时允许标记 BLOCKED 上报（harness 会抛「未找到 deepseek apiKey」），不得删断言来凑绿。跑完删除 `test-results/` 等失败产物（AGENTS.md 截图清理规则）。

- [ ] **Step 3: 更新 CHANGELOG.md**

在根 `CHANGELOG.md` 顶部的 `## [Unreleased] - 2026-08-04` 段落（updater 条目所在段）追加一条（若该段不存在则新建）：

```markdown
- **聊天消息导出为图片**：AI 回复旁（复制按钮左侧）新增导出 icon，点击弹菜单选
  「下载 PNG / 复制图片」，把当条消息往前最多 5 轮的文本对话（用户提问 + AI 文字回复，
  不含思考/工具等过程）生成为分享卡片图片。新增依赖 html-to-image。
  影响范围：`packages/frontend/src/util/export-chat-image.ts`、
  `packages/frontend/src/components/blocks/ExportImageCard.tsx`、
  `packages/frontend/src/components/blocks/ExportButton.tsx`、
  `packages/frontend/src/components/MessageList.tsx`。
```

- [ ] **Step 4: 全量 frontend 测试 + Commit**

```bash
cd packages/frontend && bun test --isolate && bun run typecheck
```

预期：全部 pass（既有 1 个 `tests/App.test.tsx` 失败是 master 既有问题——「编辑弹窗打开时再开宫格」用例，干净树复现，与本分支无关；报告中注明即可，不修）。然后：

```bash
git add packages/frontend/e2e/chat-export.spec.ts CHANGELOG.md
git commit -m "test(frontend): 聊天导出 E2E（下载 PNG 魔数 + 剪贴板插桩）+ CHANGELOG"
```

---

## 验收清单（四层测试对照 AGENTS.md §6）

1. 单元：`export-chat-image.test.ts` 8 例（collectTurns 6 + downloadBlob 1 + renderTurnsToPngBlob 1）——Task 1/2
2. 组件：ExportImageCard 2 例 + ExportButton 5 例——Task 2/3
3. API 接口：本功能无新增后端接口，**跳过**（spec §8 已注明）
4. E2E：`e2e/chat-export.spec.ts` 1 例（真实 LLM 一轮 → 下载 PNG 魔数断言 + 剪贴板插桩）——Task 4
5. 截图清理：E2E 失败产物 `test-results/` 删除
6. CHANGELOG：Task 4 Step 3
7. 桌面版手动验证（spec §10 风险项）：`bun run pack:mac`（或既有安装包环境）下打开会话做一次导出，确认 packaged 环境字体内联正常、图片不缺字形——此步在合并前人工执行一次即可
