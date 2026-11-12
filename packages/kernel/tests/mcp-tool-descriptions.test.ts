// mcp-tool-descriptions.test.ts — MCP 工具描述索引（注册名 → 服务器官方 description）
//
// 全部注入 fake：fake mcpFile（只实现 list）+ fake probe（返回预设 toolSummaries），
// 不 spawn 任何 MCP 子进程、不发网络请求。
import { test, expect, describe } from "bun:test";
import type { McpServerConfig } from "@wa-pi/shared";
import type { McpProbeResult } from "../src/mcp-probe";
import { McpToolDescriptionIndex } from "../src/mcp-tool-descriptions";
import { createMcpToolName } from "../src/mcp-tool-names";

/** 只实现 list 的最小 mcpFile 假实现 */
function fakeMcpFile(servers: McpServerConfig[]) {
	const calls: Array<string | undefined> = [];
	return {
		calls,
		async list(projectId?: string) {
			calls.push(projectId);
			return servers;
		},
	};
}

function serverConfig(name: string, extra: Partial<McpServerConfig> = {}): McpServerConfig {
	return { name, url: `https://example.test/${name}`, ...extra } as McpServerConfig;
}

/** 记录调用的 fake probe：按服务器名返回预设结果（缺省 connected + 两个工具） */
function fakeProbe(overrides: Record<string, McpProbeResult> = {}) {
	const probed: string[] = [];
	const probe = async (config: McpServerConfig): Promise<McpProbeResult> => {
		probed.push(config.name);
		const preset = overrides[config.name];
		if (preset) return preset;
		return {
			state: "connected",
			tools: ["search", "fetch"],
			toolSummaries: [
				{ name: "search", description: `${config.name} search desc` },
				{ name: "fetch", description: `${config.name} fetch desc` },
			],
		};
	};
	return { probed, probe };
}

function makeIndex(opts: {
	servers: McpServerConfig[];
	probe: (config: McpServerConfig) => Promise<McpProbeResult>;
	ttlMs?: number;
}) {
	const mcpFile = fakeMcpFile(opts.servers);
	const index = new McpToolDescriptionIndex({
		mcpFile,
		agentDir: "/tmp/agent-dir",
		cwd: "/tmp/cwd",
		probe: opts.probe,
		...(opts.ttlMs === undefined ? {} : { ttlMs: opts.ttlMs }),
	});
	return { index, mcpFile };
}

describe("McpToolDescriptionIndex", () => {
	test("首次 needsRefresh 为 true，refresh 后按注册名给出官方描述", async () => {
		const { probe } = fakeProbe();
		const { index } = makeIndex({ servers: [serverConfig("dbx")], probe });

		expect(index.needsRefresh()).toBe(true);
		expect(index.descriptions().size).toBe(0);

		await index.refresh();

		expect(index.needsRefresh()).toBe(false);
		const map = index.descriptions();
		// 注册名不是朴素拼接：用 createMcpToolName 的期望值断言
		expect(map.get(createMcpToolName("dbx", "search"))).toBe("dbx search desc");
		expect(map.get(createMcpToolName("dbx", "fetch"))).toBe("dbx fetch desc");
		expect(map.size).toBe(2);
	});

	test("TTL 内 needsRefresh 为 false，过期后重新为 true", async () => {
		const { probe } = fakeProbe();
		const { index } = makeIndex({ servers: [serverConfig("dbx")], probe, ttlMs: 20 });

		await index.refresh();
		expect(index.needsRefresh()).toBe(false);

		await Bun.sleep(35);
		expect(index.needsRefresh()).toBe(true);
	});

	test("并发 refresh 单飞：只跑一轮 probe", async () => {
		const { probe, probed } = fakeProbe();
		const { index } = makeIndex({
			servers: [serverConfig("a"), serverConfig("b")],
			probe,
		});

		await Promise.all([index.refresh(), index.refresh(), index.refresh()]);

		expect(probed.sort()).toEqual(["a", "b"]);
	});

	test("单台失败静默跳过，其它台照常入表", async () => {
		const { probe } = fakeProbe({
			broken: { state: "failed", tools: [], toolSummaries: [], error: "connection refused" },
		});
		const { index } = makeIndex({
			servers: [serverConfig("ok"), serverConfig("broken")],
			probe,
		});

		await index.refresh();

		const map = index.descriptions();
		expect(map.get(createMcpToolName("ok", "search"))).toBe("ok search desc");
		expect(map.size).toBe(2);
	});

	test("全失败时保留旧缓存不清空", async () => {
		let failing = false;
		const probe = async (config: McpServerConfig): Promise<McpProbeResult> => {
			if (failing) {
				return { state: "failed", tools: [], toolSummaries: [], error: "boom" };
			}
			return {
				state: "connected",
				tools: ["search"],
				toolSummaries: [{ name: "search", description: "旧描述" }],
			};
		};
		const { index } = makeIndex({ servers: [serverConfig("dbx")], probe });

		await index.refresh();
		expect(index.descriptions().size).toBe(1);

		failing = true;
		await index.refresh();

		// 网络抖动不该把描述永久抹掉
		expect(index.descriptions().get(createMcpToolName("dbx", "search"))).toBe("旧描述");
	});

	test("enabled:false 的服务器不 probe，也不入表", async () => {
		const { probe, probed } = fakeProbe();
		const { index } = makeIndex({
			servers: [serverConfig("on"), serverConfig("off", { enabled: false })],
			probe,
		});

		await index.refresh();

		expect(probed).toEqual(["on"]);
		expect(index.descriptions().size).toBe(2);
	});

	test("0 台服务器时不清空旧缓存", async () => {
		const servers: McpServerConfig[] = [serverConfig("dbx")];
		const { probe } = fakeProbe();
		const mcpFile = {
			async list() {
				return servers;
			},
		};
		const index = new McpToolDescriptionIndex({
			mcpFile,
			agentDir: "/tmp/agent-dir",
			cwd: "/tmp/cwd",
			probe,
		});

		await index.refresh();
		expect(index.descriptions().size).toBe(2);

		servers.length = 0;
		await index.refresh();

		expect(index.descriptions().size).toBe(2);
	});

	test("probe 抛异常（探测器异常）按失败跳过，不冒泡", async () => {
		const probe = async (config: McpServerConfig): Promise<McpProbeResult> => {
			if (config.name === "throws") throw new Error("探测异常");
			return {
				state: "connected",
				tools: ["search"],
				toolSummaries: [{ name: "search", description: "ok desc" }],
			};
		};
		const { index } = makeIndex({
			servers: [serverConfig("ok"), serverConfig("throws")],
			probe,
		});

		await index.refresh();

		expect(index.descriptions().get(createMcpToolName("ok", "search"))).toBe("ok desc");
	});
});
