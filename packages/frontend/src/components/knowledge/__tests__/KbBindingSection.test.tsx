// KbBindingSection 组件测试（任务 B5，TDD）。
// 逐字契约（简报示意测试的断言语义，取值不可改）：
//   · 勾选行渲染库名「产品知识库」+ 描述「产品定价与规格」+ 索引中标「索引完成后可检索」
//   · 点击复选框 kb-bind-check-kb_1 → onToggle("kb_1")
//   · restricted 时提示含「自动启用搜索工具」
//   · selected 里的失效 id（kb_gone）不产生勾选行（queryByTestId 为 null）
//   · AgentConfig 保存链路两条都带 knowledgeBaseIds: ["kb_1"]：
//     命名 agent → api.put body.config；内置 subagent → saveOverride payload
// 注：简报示意代码是 vitest + jest-dom 语义，沿用本仓库 bun:test 约定（照 KbList.test.tsx）：
// vi.fn → mock、toBeInTheDocument → toBeTruthy、toBeNull；api/events mock 用 mock.module
//（AgentConfig.test.tsx 同款零侵入：get 按路径分发、put 记录 apiCalls）。
import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
	render,
	screen,
	fireEvent,
	waitFor,
	cleanup,
} from "@testing-library/react";
import { KbBindingSection } from "../KbBindingSection";
import { AgentConfig } from "../../AgentConfig";
import { useKnowledgeStore } from "../../../store/knowledge";
import { useAgentsStore } from "../../../store/agents";
import { useSubagentsStore } from "../../../store/subagents";
import { useSkillsStore } from "../../../store/skills";
import { useProvidersStore } from "../../../store/providers";
import type { KbInfo } from "@wa-pi/shared";
import type { AgentConfig as AgentConfigType } from "@wa-pi/shared";

// REST API 调用记录；get 对 /api/knowledge 返回清单（AgentConfig mount 必拉 listKbs，
// 直接 setState 注入会被 mount 拉取覆盖，照 KbFormModal.test.tsx 的做法让 get 回清单）；
// kbListFail=true 时 get /api/knowledge 拒绝，模拟清单未知态（未 resolve/失败，审查修复 1）
const apiCalls: { method: string; path: string; body?: any }[] = [];
const kbListFixture: KbInfo[] = [];
let kbListFail = false;
mock.module("../../../api-client", () => ({
	api: {
		get: mock(async (path: string) => {
			apiCalls.push({ method: "get", path });
			if (path === "/api/knowledge") {
				if (kbListFail) throw new Error("simulated knowledge list failure");
				return { type: "knowledge:list", kbs: kbListFixture };
			}
			return {};
		}),
		post: mock(async () => ({})),
		put: mock(async (path: string, body?: any) => {
			apiCalls.push({ method: "put", path, body });
			return {};
		}),
		del: mock(async () => ({})),
	},
}));

// SSE 事件总线 mock（AgentConfig.test.tsx 同款）：避免真实 EventSource 连接
mock.module("../../../events", () => ({
	onMessage: () => () => {},
	onEventType: () => () => {},
	connectEvents: () => {},
	disconnectEvents: () => {},
	onReconnect: () => () => {},
}));

const kbReady: KbInfo = {
	id: "kb_1",
	name: "产品知识库",
	description: "产品定价与规格",
	folderPath: "D:/资料/产品文档",
	status: "ready",
	fileCount: 1204,
	chunkCount: 18530,
	failedCount: 0,
	autoWatch: true,
	lastIndexedAt: Date.now(),
};

const kbs: KbInfo[] = [
	kbReady,
	{
		...kbReady,
		id: "kb_9",
		name: "索引中库",
		status: "indexing",
		progress: { phase: "embedding", filesTotal: 10, filesDone: 4, chunksDone: 0 },
	},
];

// 命名 agent 的测试配置（照 AgentConfig.test.tsx 的 cfg()）
const cfg = (name: string): AgentConfigType => ({
	displayName: name,
	avatar: "🤖",
	avatarColor: "#111111-#222222",
	description: `${name} 简介`,
	model: "glm-4.6",
	thinking: "high",
	tools: [],
	skills: [],
	mcpServers: [],
	partners: { askTo: [] },
	systemPromptBody: "你是工程师",
});

// 内置 subagent 测试数据（照 AgentConfig.test.tsx 的 store 注入形状）
const builtinSubagent = {
	name: "general-purpose",
	displayName: "通用子智能体",
	description: "",
	emoji: "🤖",
	gradient: ["#4b5563", "#6b7280"] as [string, string],
	readOnly: false,
	systemPrompt: "",
	builtinToolNames: [],
};

const configSaveCall = (agentName: string) =>
	apiCalls.find(
		(c) =>
			c.method === "put" &&
			c.path === `/api/agents/${encodeURIComponent(agentName)}/config`,
	);

beforeEach(() => {
	cleanup();
	apiCalls.length = 0;
	kbListFail = false;
	kbListFixture.length = 0;
	kbListFixture.push(...kbs);
	useKnowledgeStore.setState(useKnowledgeStore.getInitialState(), true);
	useAgentsStore.setState({ list: [], configs: {} });
	useSkillsStore.setState({ allSkills: [] });
	useProvidersStore.setState({ providers: [] });
	useSubagentsStore.setState(useSubagentsStore.getInitialState(), true);
});

describe("KbBindingSection 勾选列表", () => {
	test("勾选列表渲染库名+描述截断+状态", () => {
		render(<KbBindingSection kbs={kbs} selected={[]} onToggle={mock()} />);
		expect(screen.getByText("产品知识库")).toBeTruthy();
		// 两行 fixture 共享同一描述（kb_9 = { ...kbReady } 展开），getByText 会多匹配，
		// 按断言语义（描述被渲染）取 getAllByText
		expect(screen.getAllByText(/产品定价与规格/).length).toBeGreaterThanOrEqual(1);
		// 索引中的库标注「索引完成后可检索」（但可勾选，行仍渲染）
		expect(screen.getByText(/索引完成后可检索/)).toBeTruthy();
		expect(screen.getByTestId("kb-bind-check-kb_9")).toBeTruthy();
	});

	test("勾选/取消回调 toggle 对应 id", () => {
		const onToggle = mock();
		render(<KbBindingSection kbs={kbs} selected={[]} onToggle={onToggle} />);
		fireEvent.click(screen.getByTestId("kb-bind-check-kb_1"));
		expect(onToggle).toHaveBeenCalledWith("kb_1");
	});

	test("受限模式提示（审查重点 4）", () => {
		render(
			<KbBindingSection kbs={kbs} selected={[]} onToggle={mock()} restricted />,
		);
		expect(screen.getByText(/自动启用搜索工具/)).toBeTruthy();
	});

	test("空清单且受限时不显示受限提示（无库可绑，提示误导）", () => {
		render(
			<KbBindingSection kbs={[]} selected={[]} onToggle={mock()} restricted />,
		);
		expect(screen.queryByText(/自动启用搜索工具/)).toBeNull();
		// 空清单提示仍在（引导用户先去建库）
		expect(screen.getByText(/暂无知识库/)).toBeTruthy();
	});

	test("error 库状态摘要含「暂不可检索」暗示", () => {
		const failed = { ...kbReady, id: "kb_err", status: "error" as const };
		render(
			<KbBindingSection
				kbs={[failed]}
				selected={[]}
				onToggle={mock()}
			/>,
		);
		expect(screen.getByText(/索引中断/)).toBeTruthy();
		expect(screen.getByText(/暂不可检索/)).toBeTruthy();
	});

	test("已删除库 id 不进勾选列表（审查重点 2）", () => {
		render(
			<KbBindingSection kbs={kbs} selected={["kb_gone"]} onToggle={mock()} />,
		);
		expect(screen.queryByTestId("kb-bind-check-kb_gone")).toBeNull();
	});
});

describe("AgentConfig 保存链路带上 knowledgeBaseIds", () => {
	test("命名 agent：勾选后保存 → api.put config 含 knowledgeBaseIds: [kb_1]", async () => {
		useAgentsStore.setState({ configs: { dev: cfg("dev") } });
		render(<AgentConfig agentName="dev" onClose={() => {}} />);
		// mount 拉取清单（get mock 回包）后勾选行就绪
		const check = await waitFor(() =>
			screen.getByTestId("kb-bind-check-kb_1"),
		);
		fireEvent.click(check);
		fireEvent.click(screen.getByTestId("cfg-save"));
		const call = configSaveCall("dev");
		expect(call).toBeTruthy();
		expect(call!.body.config.knowledgeBaseIds).toEqual(["kb_1"]);
	});

	test("内置 subagent：勾选后保存 → saveOverride payload 含 knowledgeBaseIds: [kb_1]", async () => {
		const saveOverride = mock();
		useSubagentsStore.setState({
			subagents: [builtinSubagent],
			saveOverride,
		});
		render(<AgentConfig agentName="general-purpose" onClose={() => {}} />);
		const check = await waitFor(() =>
			screen.getByTestId("kb-bind-check-kb_1"),
		);
		fireEvent.click(check);
		fireEvent.click(screen.getByTestId("cfg-save"));
		expect(saveOverride).toHaveBeenCalledWith(
			expect.objectContaining({ knowledgeBaseIds: ["kb_1"] }),
		);
	});

	describe("受限提示与内置 subagent 豁免（最终审查修复）", () => {
		test("命名 agent tools 非空 → 显示受限提示（未破坏原语义）", async () => {
			useAgentsStore.setState({
				configs: { dev: { ...cfg("dev"), tools: ["read", "bash"] } },
			});
			render(<AgentConfig agentName="dev" onClose={() => {}} />);
			await waitFor(() => screen.getByTestId("kb-bind-check-kb_1"));
			expect(screen.getByText(/自动启用搜索工具/)).toBeTruthy();
		});

		test("内置 subagent（builtinToolNames 非空）→ 不显示受限提示（kernel 全放行，提示对其不成立）", async () => {
			useSubagentsStore.setState({
				subagents: [
					{ ...builtinSubagent, builtinToolNames: ["read", "bash"] },
				],
			});
			render(<AgentConfig agentName="general-purpose" onClose={() => {}} />);
			await waitFor(() => screen.getByTestId("kb-bind-check-kb_1"));
			expect(screen.queryByText(/自动启用搜索工具/)).toBeNull();
		});
	});

	test("保存时过滤失效 id（审查重点 2）：勾选的库已从清单删除 → 不进 payload", async () => {
		// draft 预置已失效的 kb_gone（清单里只有 kb_1/kb_9），保存后 payload 只含有效 id
		const withGone = {
			...cfg("dev"),
			knowledgeBaseIds: ["kb_gone"],
		};
		useAgentsStore.setState({ configs: { dev: withGone } });
		render(<AgentConfig agentName="dev" onClose={() => {}} />);
		await waitFor(() => screen.getByTestId("kb-bind-check-kb_1"));
		fireEvent.click(screen.getByTestId("cfg-save"));
		const call = configSaveCall("dev");
		expect(call).toBeTruthy();
		expect(call!.body.config.knowledgeBaseIds).toEqual([]);
	});

	test("清单未知态不清空既有绑定（审查修复 1）：加载失败时保存 payload 原样保留", async () => {
		// get /api/knowledge 失败 → store loading 复位但清单从未成功加载（未知态）
		kbListFail = true;
		const withBinding = { ...cfg("dev"), knowledgeBaseIds: ["kb_1"] };
		useAgentsStore.setState({ configs: { dev: withBinding } });
		render(<AgentConfig agentName="dev" onClose={() => {}} />);
		// draft 就绪（name input 渲染）且 listKbs 失败已落定（loading 复位）
		await waitFor(() => screen.getByTestId("cfg-name-input"));
		await waitFor(() =>
			expect(useKnowledgeStore.getState().loading).toBe(false),
		);
		fireEvent.click(screen.getByTestId("cfg-save"));
		const call = configSaveCall("dev");
		expect(call).toBeTruthy();
		// 未知态 ≠ 空态：不把清单未知当「库里没有」，既有绑定原样保留
		expect(call!.body.config.knowledgeBaseIds).toEqual(["kb_1"]);
	});
});
