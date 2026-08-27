// MessageRow 组件测试：验证"文件修改清单是否显示由 isLastMessage 决定"。
// 回归场景：修复前 isLastMessage 用 i === displayRows.length - 1（整个列表最后一行）；
// 当末尾插入 extension_notify（插件通知）这类 custom 系统消息后，原最后一条 assistant
// 内容消息的 isLastMessage 变 false → 文件修改清单被顶掉。
// 修复后 isLastMessage 指向"最后一条内容消息"（lastContentRowIndex），文件修改清单恢复显示。
// 这里直接渲染 MessageRow，验证同一条内容消息在 isLastMessage=true 时显示文件修改清单、
// isLastMessage=false 时不显示——证明文件修改清单确实以 isLastMessage 为闸门。
import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

const fileChanges = [{ path: "/a.ts", before: "x", after: "y" }];

const baseSessionState = {
	messagesBySession: { s1: [] },
	fileChangesBySession: { s1: fileChanges },
} as any;

const useSessionStore = (selector: (s: unknown) => unknown) =>
	selector(baseSessionState);
(useSessionStore as any).getState = () => baseSessionState;
mock.module("../../store/session", () => ({ useSessionStore }));

const useSkillsStore = (selector: (s: unknown) => unknown) =>
	selector({ skills: [] });
mock.module("../../store/skills", () => ({ useSkillsStore }));

const { MessageRow } = await import("../MessageList");

function row(message: any) {
	return { main: { agentName: "agent", message }, toolResults: new Map() };
}

const assistantMsg = {
	role: "assistant",
	content: [{ type: "text", text: "这是最终回复" }],
	timestamp: 10,
};

afterEach(() => cleanup());

test("isLastMessage=true 时，最后一条内容消息下显示文件修改清单", () => {
	render(<MessageRow row={row(assistantMsg)} sessionId="s1" isLastMessage />);
	// 展开清单折叠行
	const summary = screen.getByTestId("file-change-summary");
	expect(summary).toBeTruthy();
});

test("isLastMessage=false 时（末尾被插件通知等系统行抢占），不显示文件修改清单", () => {
	render(
		<MessageRow row={row(assistantMsg)} sessionId="s1" isLastMessage={false} />,
	);
	expect(screen.queryByTestId("file-change-summary")).toBeNull();
});
