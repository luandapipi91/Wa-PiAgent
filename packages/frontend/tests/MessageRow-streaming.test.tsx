// MessageRow streaming 测试：验证 AI 回复未结束时（isStreaming=true）
// 不渲染复制/导出按钮，完成后才显示。
import { test, expect, beforeEach } from "bun:test";
import { render, screen } from "@testing-library/react";
import { MessageRow } from "../src/components/MessageList";
import { useSessionStore } from "../src/store/session";
import { useSkillsStore } from "../src/store/skills";
import { useUiPrefsStore } from "../src/store/ui-prefs";

const SID = "s1";
const TS = 200;

/** 最小 RenderedRow：assistant 消息只含一个 text block */
function makeRow(): any {
	return {
		main: {
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Hello world" }],
				timestamp: TS,
			},
			agentName: "dev",
		},
		toolResults: new Map(),
	};
}

beforeEach(() => {
	useSessionStore.setState({
		messagesBySession: {
			[SID]: [
				{ message: { role: "user", content: "q", timestamp: 100 } },
				{
					message: {
						role: "assistant",
						content: [{ type: "text", text: "a" }],
						timestamp: TS,
					},
					agentName: "dev",
				},
			],
		},
	} as any);
	useUiPrefsStore.setState({ exportTurns: 1 });
	useSkillsStore.setState({ skills: [] } as any);
});

test("streaming 期间不渲染复制/导出按钮", () => {
	render(<MessageRow row={makeRow()} sessionId={SID} isStreaming={true} />);
	expect(screen.queryByTestId(`copy-${SID}-${TS}`)).toBeNull();
	expect(screen.queryByTestId(`export-${SID}-${TS}`)).toBeNull();
});

test("非 streaming 时渲染复制/导出按钮", () => {
	render(<MessageRow row={makeRow()} sessionId={SID} isStreaming={false} />);
	expect(screen.queryByTestId(`copy-${SID}-${TS}`)).not.toBeNull();
	expect(screen.queryByTestId(`export-${SID}-${TS}`)).not.toBeNull();
});
