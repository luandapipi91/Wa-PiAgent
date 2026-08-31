// lastContentRowIndex 纯函数单元测试：
// 验证"文件修改清单应挂在最后一条真正的消息内容下，而非最后一条系统提示行"的判定逻辑。
// 回归场景：末尾插入 extension_notify（插件通知 / 如 /lens-toggle 执行结果）这类 custom
// 系统提示行时，lastContentRowIndex 仍应指向最后一条 assistant 消息，从而文件修改清单不被顶掉。
import { describe, expect, test } from "bun:test";
import { lastContentRowIndex, type RenderedRow } from "../MessageList";

function message(over: Record<string, unknown> = {}): any {
	return { role: "assistant", content: [{ type: "text", text: "hi" }], ...over };
}

function row(over: Record<string, unknown> = {}): RenderedRow {
	return {
		main: {
			agentName: "agent",
			message: (over.message as any) ?? message(),
		},
		toolResults: new Map(),
	};
}

describe("lastContentRowIndex", () => {
	test("空数组返回 -1", () => {
		expect(lastContentRowIndex([])).toBe(-1);
	});

	test("普通 assistant 消息，返回最后一条索引", () => {
		const rows = [row({}), row({ message: message() }), row({})];
		expect(lastContentRowIndex(rows)).toBe(2);
	});

	test("末尾是 custom 系统提示（extension_notify），仍返回最后一条 assistant 索引", () => {
		const rows = [
			row({}),
			row({}),
			// 末尾插入的两条 custom 系统提示行（插件通知）
			row({
				message: {
					type: "custom",
					customType: "extension_notify",
					content: "lens-toggle 已执行",
					timestamp: 1,
				},
			}),
		];
		expect(lastContentRowIndex(rows)).toBe(1);
	});

	test("末尾是 agent_switch / compaction_status 等其它 custom，同样跳过", () => {
		const rows = [
			row({}),
			row({
				message: {
					role: "custom",
					customType: "agent_switch",
					content: "切换到 agent-b",
					timestamp: 2,
				},
			}),
		];
		expect(lastContentRowIndex(rows)).toBe(0);
	});

	test("全部是 custom 系统提示行返回 -1", () => {
		const rows = [
			row({
				message: {
					type: "custom_message",
					customType: "compaction_status",
					content: "压缩中",
					timestamp: 3,
				},
			}),
		];
		expect(lastContentRowIndex(rows)).toBe(-1);
	});

	test("custom 行夹在中间，仍返回最后一条真实内容", () => {
		const rows = [
			row({}),
			row({
				message: {
					type: "custom",
					customType: "extension_notify",
					content: "中间提示",
					timestamp: 4,
				},
			}),
			row({}),
		];
		expect(lastContentRowIndex(rows)).toBe(2);
	});
});
