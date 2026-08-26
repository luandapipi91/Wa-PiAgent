import { describe, test, expect } from "bun:test";
import {
	sanitizeTaskId,
	parseTaskFile,
	serializeTaskFile,
	validateTaskData,
	formatLogLine,
	parseLogLine,
	cronMatches,
	nextRunTimes,
} from "../src/task-file";
import type { ExecutionRecord } from "../src/types";

const CTX = { taskId: "每日站会", projectId: "p1", createdAt: 1000, updatedAt: 2000 };

describe("sanitizeTaskId", () => {
	test("保留中英文，剔除路径分隔符与前导点，折叠中间点串", () => {
		expect(sanitizeTaskId("每日站会提醒")).toBe("每日站会提醒");
		expect(sanitizeTaskId("a/b\\c")).toBe("abc");
		expect(sanitizeTaskId("..hidden")).toBe("hidden");
		expect(sanitizeTaskId("生产..环境")).toBe("生产-环境");
		expect(sanitizeTaskId("  ")).toBe("task");
	});
});

describe("parse/serialize 往返", () => {
	test("完整字段往返一致", () => {
		const md = serializeTaskFile(
			{
				name: "每日站会",
				schedule: { type: "weekdays", time: "09:30" },
				agentId: "main",
				model: "p/m",
				enabled: true,
			},
			"提醒我写站会",
		);
		const task = parseTaskFile(md, CTX);
		expect(task).toEqual({
			id: "每日站会",
			projectId: "p1",
			name: "每日站会",
			schedule: { type: "weekdays", time: "09:30" },
			agentId: "main",
			model: "p/m",
			prompt: "提醒我写站会",
			enabled: true,
			createdAt: 1000,
			updatedAt: 2000,
		});
	});

	test("model 缺省时不出现在 frontmatter，解析为 undefined", () => {
		const md = serializeTaskFile(
			{ name: "n", schedule: { type: "daily", time: "08:00" }, agentId: "a", enabled: false },
			"do it",
		);
		expect(md).not.toContain("model:");
		const task = parseTaskFile(md, CTX);
		expect(task.model).toBeUndefined();
		expect(task.enabled).toBe(false);
	});

	test("缺 frontmatter / 非法 JSON / 校验失败均抛中文错误", () => {
		expect(() => parseTaskFile("没有 frontmatter", CTX)).toThrow("frontmatter");
		expect(() =>
			parseTaskFile('---\nname: {oops}\n---\n\nbody', CTX),
		).toThrow();
		// 空 prompt（正文为空）
		expect(() =>
			parseTaskFile(
				serializeTaskFile(
					{ name: "n", schedule: { type: "daily", time: "08:00" }, agentId: "a", enabled: true },
					"   ",
				),
				CTX,
			),
		).toThrow("prompt 不能为空");
		// 非法时间
		expect(() =>
			parseTaskFile(
				serializeTaskFile(
					{ name: "n", schedule: { type: "daily", time: "25:00" }, agentId: "a", enabled: true },
					"body",
				),
				CTX,
			),
		).toThrow("HH:MM");
	});
});

describe("validateTaskData", () => {
	test("与现有 REST 校验规则一致", () => {
		expect(validateTaskData({})).toBe("name 不能为空");
		expect(
			validateTaskData({ name: "n", agentId: "a", prompt: "p", schedule: { type: "custom", time: "09:00" } }),
		).toContain("cronExpression");
		expect(
			validateTaskData({ name: "n", agentId: "a", prompt: "p", schedule: { type: "daily", time: "09:00" } }),
		).toBeNull();
	});
});

describe("log 行", () => {
	test("format → parse 往返还原完整 ExecutionRecord", () => {
		const rec: ExecutionRecord = {
			id: "r1", taskId: "t1", taskName: "任务", status: "success",
			startedAt: 1725000000000, finishedAt: 1725000034000, durationMs: 34000,
			sessionId: "sched-t1-1", summary: "日报已生成",
			pushResults: [{ targetId: "ct1", targetName: "ct1", success: true }],
		};
		const line = formatLogLine(rec);
		expect(line).toContain("成功");
		expect(line).toContain("日报已生成");
		expect(parseLogLine(line)).toEqual(rec);
	});
	test("无 JSON 负载或 JSON 损坏 → null", () => {
		expect(parseLogLine("普通文本行")).toBeNull();
		expect(parseLogLine("[time] 成功 | {bad json")).toBeNull();
	});
	test("分隔符在行的最开头（idx=0）时不死循环、返回 null", () => {
		expect(parseLogLine(" | garbage")).toBeNull();
		expect(parseLogLine(" | ")).toBeNull();
	});
	test("summary 含分隔符 \" | \" 时仍能往返还原", () => {
		const rec: ExecutionRecord = {
			id: "r2", taskId: "t1", taskName: "任务", status: "success",
			startedAt: 1725000000000, summary: "a | b",
		};
		expect(parseLogLine(formatLogLine(rec))).toEqual(rec);
	});
});

describe("cronMatches / nextRunTimes", () => {
	test("支持 *、*/n、单值、区间、区间步进、逗号列表", () => {
		const d = new Date(2026, 7, 26, 9, 30); // 周三 09:30
		expect(cronMatches("30 9 * * *", d)).toBe(true);
		expect(cronMatches("31 9 * * *", d)).toBe(false);
		expect(cronMatches("*/15 * * * *", d)).toBe(true);
		expect(cronMatches("30 9 * * 1-5", d)).toBe(true); // 周三
		expect(cronMatches("30 9 * * 0,6", d)).toBe(false);
		expect(cronMatches("30 9-23/2 * * *", d)).toBe(true);
	});
	test("nextRunTimes 返回未来 count 个递增时间点", () => {
		const from = new Date(2026, 7, 26, 9, 30);
		const times = nextRunTimes("30 9 * * *", 3, from);
		expect(times).toHaveLength(3);
		expect(times[0].getTime()).toBeGreaterThan(from.getTime());
		expect(times[0].getHours()).toBe(9);
		expect(times[0].getMinutes()).toBe(30);
		expect(times[1].getDate()).toBe(28); // 从 8/26 09:30 严格往后：第 1 次 8/27、第 2 次 8/28
	});
	test("非法表达式抛错", () => {
		expect(() => cronMatches("bad expr", new Date())).toThrow();
	});
});
