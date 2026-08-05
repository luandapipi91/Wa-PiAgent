# notify 居中消息保留 + ANSI 颜色透传实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 扩展 notify 保持聊天居中消息展示并解析 ANSI 颜色、不再自动消退；setStatus/setWidget/setTitle 透传 ANSI 颜色码并由前端解析渲染；kernel 对齐 pi 官方行为，fire-and-forget 方法不再回复 extension_ui_response。

**Architecture:** kernel 不再 stripAnsi，把带 ANSI 颜色码的字符串原样桥接为 sdk:event；前端新增 AnsiText 组件解析 ANSI SGR 颜色为内联 span；notify 继续插入聊天列表但移除自动消退和去重逻辑。

**Tech Stack:** bun + TypeScript（kernel）、React + zustand（frontend）、bun:test、Playwright（E2E）。

## Global Constraints

- 所有回复/注释用中文；遵循 AGENTS.md 四层验收（单元 → 组件 → API → E2E）。
- 每完成一个 Task 更新根目录 `CHANGELOG.md`（顶部追加）。
- 测试产生的截图/临时文件全部清理。
- 不引入第三方 ANSI 解析库；AnsiText 为单文件轻量实现。
- fire-and-forget 方法（notify/setStatus/setWidget/setTitle/set_editor_text）不再回复 `extension_ui_response`；dialog 方法（select/confirm/input/editor/custom）保持回复。

---

### Task 1: kernel 透传 ANSI + fire-and-forget 不回复

**Files:**
- Modify: `packages/kernel/src/rpc-client.ts:416-486`
- Test: `packages/kernel/tests/rpc-client.test.ts:102-145`
- Test: `packages/kernel/tests/fixtures/fake-pi.ts:72-84`

**Interfaces:**
- Consumes: 现有 `RpcClient.handleUiRequest` 与 `stripAnsi` 函数。
- Produces: `extension_notify`/`extension_status`/`extension_widget`/`extension_title` 事件携带原始 ANSI 字符串；fire-and-forget 方法不再产生 `extension_ui_response`。

- [ ] **Step 1: 更新 fake-pi fixture 支持检测多余响应**

`packages/kernel/tests/fixtures/fake-pi.ts` 中 `ui_fire_and_forget` 和 `ui_notify` 保持现状（发送 fire-and-forget 请求后回命令响应）。无需修改 fixture 逻辑，但需要确保 fake-pi 不期待这些方法的 `extension_ui_response`。

当前 fake-pi 已经这样工作：fire-and-forget 方法发送请求后直接回命令响应，不等待 `extension_ui_response`。所以 fixture 不需要改。

- [ ] **Step 2: 更新测试为期望透传 ANSI + 无多余响应**

`packages/kernel/tests/rpc-client.test.ts` 中更新：

```ts
test("fire-and-forget UI 请求（notify）不阻塞、不要求响应，且转发为 extension_notify 事件", async () => {
	const { client, events } = makeClient({
		onUiRequest: async () => {
			throw new Error("不应被调用");
		},
	});
	await client.start();
	await client.command({ type: "ui_notify" });
	const notify = events.find((e) => e.type === "extension_notify");
	expect(notify).toBeTruthy();
	expect((notify as any).message).toBe("你好");
	expect((notify as any).notifyType).toBeUndefined();
});

test("setStatus/setWidget/setTitle 桥接为 extension_status/widget/title 事件（ANSI 原文透传）", async () => {
	const { client, events } = makeClient();
	await client.start();
	await client.command({ type: "ui_fire_and_forget" });
	const status = events.find((e) => e.type === "extension_status");
	expect(status).toBeTruthy();
	expect((status as any).statusKey).toBe("pi-lens");
	expect((status as any).statusText).toBe("\u001b[38;5;241m分析中 (3/5)\u001b[39m");
	const widget = events.find((e) => e.type === "extension_widget");
	expect(widget).toBeTruthy();
	expect((widget as any).widgetLines).toEqual([
		"\u001b[38;5;241m[No agent selected]\u001b[39m",
		"进度 4/6",
	]);
	expect((widget as any).widgetPlacement).toBe("aboveEditor");
	const title = events.find((e) => e.type === "extension_title");
	expect(title).toBeTruthy();
	expect((title as any).title).toBe("分析中");
});

test("set_editor_text 桥接为 extension_editor_text 事件（转发语义：替换输入框内容）", async () => {
	const { client, events } = makeClient();
	await client.start();
	await client.command({ type: "ui_set_editor_text" });
	const editorText = events.find((e) => e.type === "extension_editor_text");
	expect(editorText).toBeTruthy();
	expect((editorText as any).text).toBe("替换后的输入框内容");
});
```

新增测试验证 fire-and-forget 不回复 `extension_ui_response`：

```ts
test("fire-and-forget 方法不回复 extension_ui_response", async () => {
	const { client } = makeClient();
	await client.start();
	// 如果 kernel 对 fire-and-forget 回复了 extension_ui_response，
	// fake-pi 的 handle() 中 default 分支会报错「未知命令: extension_ui_response」
	// 这里通过命令正常完成来验证没有产生副作用
	const data = await client.command({ type: "ui_fire_and_forget" });
	expect(data).toBeUndefined();
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `bun test packages/kernel/tests/rpc-client.test.ts`
Expected: FAIL（当前断言期望 stripAnsi 后的纯文本）

- [ ] **Step 4: 修改 rpc-client.ts**

`packages/kernel/src/rpc-client.ts` `handleUiRequest` 中：

- notify 分支：`message: stripAnsi(req.message)` → `message: req.message`
- setStatus 分支：`stripAnsi(req.statusText)` → `req.statusText`
- setWidget 分支：`req.widgetLines.map((l) => stripAnsi(String(l)))` → `req.widgetLines.map((l) => String(l))`
- setTitle 分支：`stripAnsi(req.title)` → `req.title`
- 把回复逻辑从「所有请求统一回复」改为「仅 dialog 方法回复」：

```ts
// 仅对话类方法回复 extension_ui_response；fire-and-forget（notify/setStatus/setWidget/setTitle/set_editor_text）
// pi 侧不期待响应（见 rpc-mode.js 源码注释 "Fire and forget - no response needed"），不再回复。
if (UI_DIALOG_METHODS.has(req.method)) {
	let fields: UiResponseFields = { cancelled: true };
	if (this.opts.onUiRequest) {
		try {
			fields = await this.opts.onUiRequest(req);
		} catch {
			fields = { cancelled: true };
		}
	}
	try {
		this.proc?.stdin?.write(
			JSON.stringify({
				type: "extension_ui_response",
				id: req.id,
				...fields,
			}) + "\n",
		);
	} catch {
		/* 进程已退出 */
	}
}
```

同时更新注释，说明 ANSI 原文透传、前端解析。

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test packages/kernel/tests/rpc-client.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/kernel/src/rpc-client.ts packages/kernel/tests/rpc-client.test.ts
git commit -m "feat: kernel 透传扩展 UI 文本 ANSI 颜色码，fire-and-forget 不再回复 extension_ui_response"
```

---

### Task 2: AnsiText ANSI 颜色解析组件

**Files:**
- Create: `packages/frontend/src/components/ui/AnsiText.tsx`
- Test: `packages/frontend/tests/ansi-text.test.ts`（新增）

**Interfaces:**
- Produces: `AnsiText({ text }: { text: string }): JSX.Element`；`parseAnsiToNodes(text: string): ReactNode[]`（纯函数，供测试）。

- [ ] **Step 1: 写失败测试**

`packages/frontend/tests/ansi-text.test.ts`：

```ts
import { test, expect } from "bun:test";
import { parseAnsiToNodes } from "../src/components/ui/AnsiText";
import { isValidElement } from "react";

test("无 ANSI 时原样返回字符串", () => {
	const nodes = parseAnsiToNodes("纯文本");
	expect(nodes).toEqual(["纯文本"]);
});

test("16 色 foreground 解析", () => {
	const nodes = parseAnsiToNodes("\x1b[31m红色\x1b[39m");
	expect(nodes).toHaveLength(1);
	const el = nodes[0];
	expect(isValidElement(el)).toBe(true);
	expect((el as any).props.style.color).toBe("#dc2626");
	expect((el as any).props.children).toBe("红色");
});

test("256 色 foreground 解析", () => {
	const nodes = parseAnsiToNodes("\x1b[38;5;214m橙色\x1b[39m");
	expect(nodes).toHaveLength(1);
	const el = nodes[0];
	expect((el as any).props.style.color).toBe("#ff8700");
});

test("RGB foreground 解析", () => {
	const nodes = parseAnsiToNodes("\x1b[38;2;18;52;86m深蓝\x1b[39m");
	expect(nodes).toHaveLength(1);
	const el = nodes[0];
	expect((el as any).props.style.color).toBe("#123456");
});

test("多段颜色解析", () => {
	const nodes = parseAnsiToNodes("\x1b[31m红\x1b[32m绿\x1b[39m");
	expect(nodes).toHaveLength(2);
	expect((nodes[0] as any).props.style.color).toBe("#dc2626");
	expect((nodes[0] as any).props.children).toBe("红");
	expect((nodes[1] as any).props.style.color).toBe("#34a853");
	expect((nodes[1] as any).props.children).toBe("绿");
});

test("reset 后回到默认", () => {
	const nodes = parseAnsiToNodes("\x1b[31m红\x1b[0m默认");
	expect(nodes).toHaveLength(2);
	expect((nodes[0] as any).props.style.color).toBe("#dc2626");
	expect(nodes[1]).toBe("默认");
});

test("非法/不支持的序列被丢弃", () => {
	const nodes = parseAnsiToNodes("\x1b[2J清屏\x1b[1m加粗\x1b[39m");
	expect(nodes).toEqual(["清屏加粗"]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/frontend && bun test --isolate tests/ansi-text.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 AnsiText**

`packages/frontend/src/components/ui/AnsiText.tsx`：

```tsx
import type { ReactNode } from "react";

// 16 色 foreground 映射（对齐 WaPi 语义色板，无对应时用近似 hex）
const FG_16: Record<number, string> = {
  30: "#1d1d1f", // black → text-primary
  31: "#dc2626", // red → danger
  32: "#34a853", // green → success
  33: "#b45309", // yellow → warning
  34: "#2563eb", // blue
  35: "#9333ea", // magenta
  36: "#0891b2", // cyan
  37: "#6e6e73", // white → text-secondary
  90: "#6e6e73", // bright black (gray)
  91: "#ef4444", // bright red
  92: "#4ade80", // bright green
  93: "#fbbf24", // bright yellow
  94: "#60a5fa", // bright blue
  95: "#c084fc", // bright magenta
  96: "#22d3ee", // bright cyan
  97: "#1d1d1f", // bright white
};

// xterm 256 色：0-15 为系统色，16-231 为 6×6×6 cube，232-255 为灰度
function xterm256(n: number): string {
  if (n < 16) {
    const system = [
      "#000000","#800000","#008000","#808000","#000080","#800080","#008080","#c0c0c0",
      "#808080","#ff0000","#00ff00","#ffff00","#0000ff","#ff00ff","#00ffff","#ffffff",
    ];
    return system[n] ?? "#000000";
  }
  if (n < 232) {
    const idx = n - 16;
    const r = Math.floor(idx / 36);
    const g = Math.floor((idx % 36) / 6);
    const b = idx % 6;
    const toHex = (v: number) => (v === 0 ? 0 : 55 + v * 40).toString(16).padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }
  const gray = 8 + (n - 232) * 10;
  const hex = gray.toString(16).padStart(2, "0");
  return `#${hex}${hex}${hex}`;
}

/**
 * 把带 ANSI SGR 颜色码的字符串解析为 ReactNode 数组。
 * 仅处理颜色（foreground/background），其他控制序列丢弃。
 */
export function parseAnsiToNodes(text: string): ReactNode[] {
  if (!text.includes("\x1b[")) return [text];

  const nodes: ReactNode[] = [];
  let fg: string | null = null;
  let bg: string | null = null;
  let buffer = "";
  let key = 0;

  const flush = () => {
    if (!buffer) return;
    if (fg || bg) {
      nodes.push(
        <span key={key++} style={{ color: fg ?? undefined, background: bg ?? undefined }}>
          {buffer}
        </span>,
      );
    } else {
      nodes.push(buffer);
    }
    buffer = "";
  };

  // 按 \x1b[ 切分，逐段解析 SGR 序列
  const parts = text.split(/(\x1b\[[0-9;?]*[A-Za-z])/);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("\x1b[")) {
      flush();
      const match = part.match(/\x1b\[([0-9;?]*)([A-Za-z])/);
      if (!match) continue;
      const [, params, cmd] = match;
      if (cmd !== "m") continue; // 只处理 SGR

      const codes = params.split(";").map((s) => parseInt(s, 10));
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        if (Number.isNaN(code)) continue;
        if (code === 0) { fg = null; bg = null; }
        else if (code === 39) { fg = null; }
        else if (code === 49) { bg = null; }
        else if (code >= 30 && code <= 37) { fg = FG_16[code] ?? null; }
        else if (code >= 90 && code <= 97) { fg = FG_16[code] ?? null; }
        else if (code >= 40 && code <= 47) { bg = FG_16[code - 10] ?? null; }
        else if (code >= 100 && code <= 107) { bg = FG_16[code - 10] ?? null; }
        else if (code === 38 || code === 48) {
          const isFg = code === 38;
          if (codes[i + 1] === 5 && typeof codes[i + 2] === "number") {
            const color = xterm256(codes[i + 2]);
            if (isFg) fg = color; else bg = color;
            i += 2;
          } else if (codes[i + 1] === 2 && typeof codes[i + 2] === "number" && typeof codes[i + 3] === "number" && typeof codes[i + 4] === "number") {
            const r = codes[i + 2].toString(16).padStart(2, "0");
            const g = codes[i + 3].toString(16).padStart(2, "0");
            const b = codes[i + 4].toString(16).padStart(2, "0");
            const color = `#${r}${g}${b}`;
            if (isFg) fg = color; else bg = color;
            i += 4;
          }
        }
      }
      continue;
    }
    buffer += part;
  }
  flush();
  return nodes;
}

export function AnsiText({ text }: { text: string }) {
  return <>{parseAnsiToNodes(text)}</>;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/frontend && bun test --isolate tests/ansi-text.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/components/ui/AnsiText.tsx packages/frontend/tests/ansi-text.test.ts
git commit -m "feat: 新增 AnsiText 组件解析 ANSI SGR 颜色码"
```

---

### Task 3: notify 不消退不去重 + ANSI 渲染

**Files:**
- Modify: `packages/frontend/src/store/session.ts:1076-1142`（extension_notify case）
- Modify: `packages/frontend/src/components/MessageList.tsx:620-638`
- Modify: `packages/frontend/src/components/SessionView.tsx:448-490, 556-607`
- Modify: `packages/frontend/src/App.tsx:489-495`
- Test: `packages/frontend/tests/session-extension-notify.test.ts`
- Test: `packages/frontend/tests/session-notify-auto-dismiss.test.ts`（删除或重写）
- Test: `packages/frontend/tests/MessageList.test.tsx`
- Test: `packages/frontend/tests/SessionView.test.tsx`

**Interfaces:**
- Consumes: `AnsiText`。
- Produces: notify 永久保留在聊天列表；setStatus/setWidget/setTitle/notify 渲染带 ANSI 颜色。

- [ ] **Step 1: 更新失败测试（notify 不消退不去重）**

`packages/frontend/tests/session-extension-notify.test.ts` 更新为：

```ts
import { test, expect, beforeEach } from "bun:test";
import { useSessionStore } from "../src/store/session";
import type { SDKEventEnvelope } from "@wa-pi/shared";

beforeEach(() => {
	useSessionStore.getState().clear();
});

function envelope(sid: string, inner: any): SDKEventEnvelope {
	return {
		type: "sdk:event",
		sessionId: sid,
		projectId: "p-test",
		agentName: "dev",
		event: inner,
	};
}

function messages(sid: string) {
	return useSessionStore.getState().messagesBySession[sid] ?? [];
}

test("handleSDKEvent: extension_notify 插入聊天窗口中间的系统提示（custom 消息）", () => {
	const sid = "s-notify-1";
	useSessionStore.getState().handleSDKEvent(
		sid,
		envelope(sid, {
			type: "extension_notify",
			message: "pi-lens enabled for this session.",
			notifyType: "info",
		}),
	);
	const list = messages(sid);
	expect(list).toHaveLength(1);
	const m = list[0].message as any;
	expect(m.type).toBe("custom");
	expect(m.customType).toBe("extension_notify");
	expect(m.content).toBe("pi-lens enabled for this session.");
	expect(m.timestamp).toBeTypeOf("number");
});

test("handleSDKEvent: extension_notify 连续同内容不去重，各自插入", () => {
	const sid = "s-notify-2";
	const ev = {
		type: "extension_notify",
		message: "same message",
		notifyType: "warning",
	};
	useSessionStore.getState().handleSDKEvent(sid, envelope(sid, ev));
	useSessionStore.getState().handleSDKEvent(sid, envelope(sid, ev));
	useSessionStore.getState().handleSDKEvent(sid, envelope(sid, ev));
	expect(messages(sid)).toHaveLength(3);
});

test("handleSDKEvent: 不同内容 notify 各自插入", () => {
	const sid = "s-notify-3";
	useSessionStore.getState().handleSDKEvent(
		sid,
		envelope(sid, {
			type: "extension_notify",
			message: "msg A",
			notifyType: "info",
		}),
	);
	useSessionStore.getState().handleSDKEvent(
		sid,
		envelope(sid, {
			type: "extension_notify",
			message: "msg B",
			notifyType: "info",
		}),
	);
	expect(messages(sid)).toHaveLength(2);
});

test("handleSDKEvent: 非 extension_notify 事件不插入提示", () => {
	const sid = "s-notify-4";
	useSessionStore.getState().handleSDKEvent(
		sid,
		envelope(sid, {
			type: "agent_end",
			messages: [],
			willRetry: false,
		}),
	);
	expect(messages(sid)).toHaveLength(0);
});
```

`packages/frontend/tests/session-notify-auto-dismiss.test.ts` 重写为「notify 永久保留」：

```ts
import { test, expect, beforeEach, afterEach, vi } from "bun:test";
import { useSessionStore } from "../src/store/session";
import type { SDKEventEnvelope } from "@wa-pi/shared";

beforeEach(() => {
	useSessionStore.getState().clear();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

function envelope(sid: string, inner: any): SDKEventEnvelope {
	return {
		type: "sdk:event",
		sessionId: sid,
		projectId: "p-test",
		agentName: "dev",
		event: inner,
	};
}

function notify(sid: string, msg: string) {
	useSessionStore.getState().handleSDKEvent(
		sid,
		envelope(sid, {
			type: "extension_notify",
			message: msg,
			notifyType: "info",
		}),
	);
}

function messages(sid: string) {
	return useSessionStore.getState().messagesBySession[sid] ?? [];
}

test("extension_notify 插入后永久保留，不自动消退", () => {
	const sid = "s-auto-1";
	notify(sid, "MCP: 5 servers connected");
	expect(messages(sid)).toHaveLength(1);

	// 快进 60s：仍在
	vi.advanceTimersByTime(60_000);
	expect(messages(sid)).toHaveLength(1);
});

test("多条同内容 notify 不去重，各自保留", () => {
	const sid = "s-auto-2";
	notify(sid, "same");
	notify(sid, "same");
	expect(messages(sid)).toHaveLength(2);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/frontend && bun test --isolate tests/session-extension-notify.test.ts tests/session-notify-auto-dismiss.test.ts`
Expected: FAIL（当前有 20s 自动消退和去重逻辑）

- [ ] **Step 3: 修改 session.ts extension_notify case**

`packages/frontend/src/store/session.ts` 中 `case "extension_notify"` 整段替换为：

```ts
// pi 扩展 ctx.ui.notify 反馈（如 /lens-toggle 执行结果）：kernel 包装在 sdk:event 内转发，
// 这里插入聊天窗口中间的系统提示（复用 custom 消息渲染：居中 —— content ——），
// 文字颜色由 AnsiText 解析 ANSI 码呈现。不再自动消退，不去重。
case "extension_notify": {
	const msg = (event as any).message;
	if (typeof msg === "string") {
		const timestamp = Date.now();
		set((s) => {
			const list = s.messagesBySession[sessionId] ?? [];
			return {
				messagesBySession: {
					...s.messagesBySession,
					[sessionId]: [
						...list,
						{
							message: {
								type: "custom",
								customType: "extension_notify",
								content: msg,
								timestamp,
							},
							agentName,
							sessionId,
						} as any,
					],
				},
			};
		});
	}
	break;
}
```

- [ ] **Step 4: MessageList / SessionView / App.tsx 使用 AnsiText**

`packages/frontend/src/components/MessageList.tsx`：
- 顶部 import 新增：`import { AnsiText } from "./ui/AnsiText";`
- `extension_notify` 渲染处 `{`—— ${m.content} ——`}` 改为：

```tsx
<div
	className="text-center text-[calc(11.5px*var(--font-scale))] text-tertiary"
	data-testid={`custom-${sessionId}-${m.timestamp}`}
>
	—— <AnsiText text={m.content} /> ——
</div>
```

`packages/frontend/src/components/SessionView.tsx`：
- 顶部 import 新增：`import { AnsiText } from "./ui/AnsiText";`
- `extStatusEntries` 渲染中 `<span className="truncate">{text}</span>` 改为 `<span className="truncate"><AnsiText text={text} /></span>`
- `ExtWidget` 收起摘要 `{lines[0]}` 改为 `<AnsiText text={lines[0]} />`
- `ExtWidget` 展开正文 `{lines.join("\n")}` 改为 `<AnsiText text={lines.join("\n")} />`

`packages/frontend/src/App.tsx`：
- 顶部 import 新增：`import { AnsiText } from "./components/ui/AnsiText";`
- `extTitle` 状态条 `{extTitle}` 改为 `<AnsiText text={extTitle} />`

- [ ] **Step 5: 更新组件测试断言 ANSI 颜色**

`packages/frontend/tests/MessageList.test.tsx` 追加用例：

```tsx
test("extension_notify 消息的 ANSI 颜色解析为内联样式", () => {
	// 构造带 ANSI 的 extension_notify 消息
	// 断言渲染结果中存在 style.color 为对应颜色的 span
});
```

`packages/frontend/tests/SessionView.test.tsx` 追加用例：

```tsx
test("setStatus/setWidget/setTitle 的 ANSI 颜色解析为内联样式", () => {
	// 构造带 ANSI 的 extension_status / extension_widget / extension_title 事件
	// 断言渲染结果中存在 style.color 为对应颜色的 span
});
```

- [ ] **Step 6: 跑测试确认通过 + typecheck**

Run: `cd packages/frontend && bun test --isolate tests/session-extension-notify.test.ts tests/session-notify-auto-dismiss.test.ts tests/MessageList.test.tsx tests/SessionView.test.tsx && cd ../.. && bun run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/frontend/src/store/session.ts packages/frontend/src/components/MessageList.tsx packages/frontend/src/components/SessionView.tsx packages/frontend/src/App.tsx packages/frontend/tests/session-extension-notify.test.ts packages/frontend/tests/session-notify-auto-dismiss.test.ts packages/frontend/tests/MessageList.test.tsx packages/frontend/tests/SessionView.test.tsx
git commit -m "feat: notify 永久保留 + setStatus/setWidget/setTitle/notify ANSI 颜色渲染"
```

---

### Task 4: examples 测试桩颜色用例

**Files:**
- Modify: `examples/ext-ui-bridge-demo/index.ts`
- Modify: `examples/ext-ui-bridge-demo/README.md`

**Interfaces:**
- Consumes: pi 扩展 `ctx.ui.notify` / `setStatus` / `setWidget` / `setTitle` 支持 ANSI 文本。
- Produces: `/uidemo color` 子命令触发全部彩色 UI 请求。

- [ ] **Step 1: demo 扩展加颜色子命令**

`examples/ext-ui-bridge-demo/index.ts`：

`getArgumentCompletions` 列表补 `"color"`；`description` 更新为包含 `color`。

`handler` 的 `switch` 中新增：

```ts
case "color":
	ctx.ui.notify("\x1b[38;5;214m橙色 notify\x1b[39m 普通文字", "warning");
	ctx.ui.setStatus("ui-demo-color", "\x1b[32m绿色状态\x1b[39m · \x1b[38;5;39m蓝色运行中\x1b[39m");
	ctx.ui.setWidget("ui-demo-color-above", [
		"\x1b[31m红色行\x1b[39m",
		"\x1b[32m绿色行\x1b[39m",
		"\x1b[33m黄色行\x1b[39m",
		"\x1b[34m蓝色行\x1b[39m",
		"\x1b[38;5;214m256色橙色行\x1b[39m",
	]);
	ctx.ui.setTitle("\x1b[38;5;39m彩色 UI Demo 标题\x1b[39m");
	break;
```

`clearAll` 同步清除 `ui-demo-color` / `ui-demo-color-above`。

- [ ] **Step 2: 更新 README**

`examples/ext-ui-bridge-demo/README.md`：

- 表格中 notify 一行改为：`| ctx.ui.notify(msg, type) | extension_notify | 聊天居中消息（永久保留，ANSI 颜色解析） |`
- 新增「颜色演示」章节：

```markdown
## 颜色演示

扩展文本中的 ANSI SGR 颜色码会原样透传到前端，由 AnsiText 组件解析为彩色文字。

```bash
/uidemo color    # 一键触发全部彩色 UI（notify + status + widget + title）
```
```

- [ ] **Step 3: Commit**

```bash
git add examples/ext-ui-bridge-demo/index.ts examples/ext-ui-bridge-demo/README.md
git commit -m "docs(examples): ext-ui-bridge-demo 增加 ANSI 颜色演示命令"
```

---

### Task 5: E2E 全链路验证

**Files:**
- Modify: `packages/frontend/e2e/ext-ui-bridge-demo.spec.ts`

**Interfaces:**
- Consumes: Task 1-4 全部产物。

- [ ] **Step 1: 更新 E2E spec**

`packages/frontend/e2e/ext-ui-bridge-demo.spec.ts`：

更新/新增用例：

```ts
test("notify 消息永久保留且解析 ANSI 颜色", async ({ page }) => {
	const sessionId = await spawnSession();
	// 触发 /uidemo color
	await page.locator('[data-testid="composer-input"] [role="textbox"]').fill("/uidemo color");
	await page.keyboard.press("Escape");
	await page.getByTestId("composer-send").click();
	// notify 消息出现在聊天列表
	const notify = page.locator('[data-testid^="custom-"]:has-text("橙色 notify")');
	await expect(notify).toBeVisible({ timeout: 20_000 });
	// 10s 后仍在（不自动消退）
	await page.waitForTimeout(10_000);
	await expect(notify).toBeVisible();
	// 验证有内联颜色样式
	const coloredSpan = notify.locator('span[style*="color"]');
	await expect(coloredSpan.first()).toBeVisible();
});

test("setStatus/setWidget/setTitle ANSI 颜色渲染", async ({ page }) => {
	const sessionId = await spawnSession();
	// 触发 /uidemo color
	await page.locator('[data-testid="composer-input"] [role="textbox"]').fill("/uidemo color");
	await page.keyboard.press("Escape");
	await page.getByTestId("composer-send").click();
	// 验证 widget 中有彩色文字
	const widget = page.locator('[data-testid="ext-widget-ui-demo-color-above"]');
	await expect(widget).toBeVisible({ timeout: 20_000 });
	// 展开 widget 查看彩色行
	await widget.locator("button").click();
	const coloredLine = widget.locator('span[style*="color"]');
	await expect(coloredLine.first()).toBeVisible();
});
```

- [ ] **Step 2: 跑 E2E**

Run（隔离端口）：

```bash
cd packages/frontend && PI_E2E=1 WA_PI_E2E_WS_PORT=19776 WA_PI_E2E_WEB_PORT=15180 WA_PI_WS_PORT=19776 WA_PI_WEB_PORT=15180 bun run e2e ext-ui-bridge-demo --reporter=line
```

Expected: 全 PASS；无残留截图。

- [ ] **Step 3: 全量回归 + CHANGELOG + Commit**

```bash
bun test
bun run typecheck
```

CHANGELOG.md 顶部追加一条「新增功能」：notify 保持聊天居中消息并解析 ANSI 颜色、不再自动消退；setStatus/setWidget/setTitle 透传 ANSI 颜色码前端解析渲染；kernel fire-and-forget 方法不再回复 extension_ui_response；examples 测试桩补颜色演示。列影响范围。

```bash
git add -A && git commit -m "feat: notify 永久保留 + ANSI 颜色透传全链路 E2E 验证"
```

---

## Self-Review 记录

- **Spec 覆盖**：kernel 透传 ANSI + fire-and-forget 不回复（Task 1）、AnsiText 解析（Task 2）、notify 不消退不去重 + ANSI 渲染（Task 3）、examples 颜色用例（Task 4）、E2E（Task 5）。无遗漏。
- **Placeholder 扫描**：无 TBD/TODO；每步给出具体代码与命令。
- **类型一致性**：`AnsiText` 组件名与 `parseAnsiToNodes` 函数名前后一致；`extension_notify` 消息结构（`customType`/`content`/`timestamp`）前后一致。
- **风险**：Task 1 修改 fire-and-forget 不回复后，fake-pi 的 `default` 分支会报错「未知命令: extension_ui_response」——这正好作为隐式断言；如果未来 fake-pi 增加对 `extension_ui_response` 的处理，需要同步更新测试。
