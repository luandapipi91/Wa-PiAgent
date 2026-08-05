// ExportButton 组件测试（第2层）。
// 聚焦行为契约：菜单弹出、disabled 判定、点击「复制图片」用正确的 uptoTimestamp
// 收集 turns。屏外 PNG 渲染（renderTurnsToPngBlob，依赖 react-dom/client + html-to-image）
// 与剪贴板写入均 mock，避免重依赖；本测试保障「传入 collectTurns 的数据范围正确」，
// 这正是「复制图片取错消息」bug 的回归防线。
import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { ExportButton } from "../../src/components/blocks/ExportButton";
import { useSessionStore } from "../../src/store/session";
import { useUiPrefsStore } from "../../src/store/ui-prefs";
import type { SessionMessage } from "@wa-pi/shared";

// mock 屏外渲染 + 剪贴板：捕获 collectTurns 的产物（turns），断言其范围正确。
const renderTurnsSpy = mock(async (_turns: any[]) => {
	// 回传一个最小可识别 blob，避免下游 toBlob 失败
	return new Blob(["x"], { type: "image/png" });
});
const copySpy = mock(async (_blob: Blob) => {});

// 静态引入真实 collectTurns，mock 只替换 render/clipboard 这两个重依赖。
import { collectTurns } from "../../src/util/export-chat-image";
mock.module("../../src/util/export-chat-image", () => ({
	collectTurns,
	renderTurnsToPngBlob: renderTurnsSpy,
	downloadBlob: mock(() => {}),
}));
mock.module("../../src/util/clipboard", () => ({
	copyImageToClipboard: copySpy,
	toClipboardText: mock(async () => {}),
}));

function msg(
	role: "user" | "assistant",
	timestamp: number,
	text: string,
): SessionMessage {
	return {
		agentName: "coder",
		message: {
			role,
			timestamp,
			content: [{ type: "text", text }],
		} as any,
	};
}

// 流式期间的典型数据：同一回合 assistant 拆成 thinking + text 两条（store 未 compact）
const streamingMessages: SessionMessage[] = [
	msg("user", 100, "第一轮问题"),
	msg("assistant", 1000, "thinking 1"),
	msg("assistant", 1500, "第一轮回复正文"),
	msg("user", 2000, "第二轮问题"),
	msg("assistant", 3000, "thinking 2"),
	msg("assistant", 3500, "第二轮回复正文"),
];

beforeEach(() => {
	renderTurnsSpy.mockClear();
	copySpy.mockClear();
	useSessionStore.setState({
		messagesBySession: { s1: streamingMessages },
	});
	// 默认导出 1 轮
	useUiPrefsStore.setState({ exportTurns: 1 });
});

afterEach(() => cleanup());

// 渲染需要 getBoundingClientRect（happy-dom 提供默认值 0）；菜单 portal 到 body。
test("有可导出内容时按钮可点，菜单弹出含两项", async () => {
	render(<ExportButton sessionId="s1" uptoTimestamp={3500} />);
	const btn = screen.getByTestId(`export-s1-3500`) as HTMLButtonElement;
	expect(btn.disabled).toBe(false);
	fireEvent.click(btn);
	await waitFor(() => {
		expect(screen.getByTestId("export-download")).toBeTruthy();
		expect(screen.getByTestId("export-copy")).toBeTruthy();
	});
});

test("无文本对话（只有 assistant 无 user）时两项禁用", () => {
	useSessionStore.setState({
		messagesBySession: { s1: [msg("assistant", 100, "只有回复")] },
	});
	render(<ExportButton sessionId="s1" uptoTimestamp={100} />);
	// hasTurns=false → disabled；按钮自身可点（打开菜单），菜单项灰
	const btn = screen.getByTestId(`export-s1-100`);
	fireEvent.click(btn);
	// 菜单项 disabled 属性为 true
	const dl = screen.getByTestId("export-download") as HTMLButtonElement;
	const cp = screen.getByTestId("export-copy") as HTMLButtonElement;
	expect(dl.disabled).toBe(true);
	expect(cp.disabled).toBe(true);
});

// ===== 核心 bug 回归：点击复制图片，传入 render 的 turns 必须取到最后一轮正文 =====
test("复制图片：uptoTimestamp=回合首块时间(3000)，turns 取到第二轮正文而非 thinking", async () => {
	render(<ExportButton sessionId="s1" uptoTimestamp={3000} />);
	const btn = screen.getByTestId(`export-s1-3000`);
	fireEvent.click(btn);
	const copyBtn = await screen.findByTestId("export-copy");
	fireEvent.click(copyBtn);

	await waitFor(() => {
		expect(copySpy).toHaveBeenCalledTimes(1);
	});
	// 断言 renderTurnsSpy 收到的 turns：assistant 必须含「第二轮回复正文」
	expect(renderTurnsSpy).toHaveBeenCalledTimes(1);
	const turns = renderTurnsSpy.mock.calls[0][0];
	expect(turns).toHaveLength(1);
	expect(turns[0].assistant).toContain("第二轮回复正文");
	expect(turns[0].assistant).not.toBe("thinking 2");
	expect(turns[0].user).toBe("第二轮问题");
});

test("导出轮数=2 时取到两轮", async () => {
	useUiPrefsStore.setState({ exportTurns: 2 });
	render(<ExportButton sessionId="s1" uptoTimestamp={3500} />);
	const btn = screen.getByTestId(`export-s1-3500`);
	fireEvent.click(btn);
	const copyBtn = await screen.findByTestId("export-copy");
	fireEvent.click(copyBtn);
	await waitFor(() => expect(copySpy).toHaveBeenCalledTimes(1));
	const turns = renderTurnsSpy.mock.calls[0][0];
	expect(turns).toHaveLength(2);
	expect(turns[0].assistant).toContain("第一轮回复正文");
	expect(turns[1].assistant).toContain("第二轮回复正文");
});
