// KbList 知识库列表：状态徽章文案（逐字）/删除确认契约/autoWatch 开关回调 + store 进度合并。
// 注：简报示意代码用 vitest + jest-dom（toBeInTheDocument/vi.fn），本仓库未装 vitest，
// 沿用 bun:test + @testing-library/react 约定（照 ExtensionSection.test.tsx，断言 toBeTruthy）；
// 删除确认复用现有 ConfirmDialog，其确认按钮 testid 为 confirm-ok（全仓既有惯例）。
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { KbList } from "../KbList";
import { useKnowledgeStore } from "../../../store/knowledge";
import type { KbInfo } from "@wa-pi/shared";

mock.module("../../../api-client", () => ({
	api: {
		get: mock(async () => ({ type: "knowledge:list", kbs: [] })),
		post: mock(async () => ({})),
		put: mock(async () => ({})),
		del: mock(async () => ({})),
	},
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

describe("KbList 状态徽章", () => {
	beforeEach(() => {
		cleanup();
		useKnowledgeStore.setState({ kbs: [], progress: {}, loading: false });
	});

	test("ready 库渲染绿色徽章「就绪」", () => {
		render(<KbList kbs={[kbReady]} />);
		const badge = screen.getByText("就绪");
		expect(badge).toBeTruthy();
		// 徽章色：就绪绿（--success 的 20% 透明底）
		expect((badge as HTMLElement).style.color).toBe("var(--success)");
	});

	test("indexing 库渲染「索引中 42%」", () => {
		render(
			<KbList
				kbs={[
					{
						...kbReady,
						id: "kb_2",
						status: "indexing",
						progress: {
							phase: "embedding",
							filesTotal: 100,
							filesDone: 42,
							chunksDone: 0,
						},
					},
				]}
			/>,
		);
		expect(screen.getByText("索引中 42%")).toBeTruthy();
	});

	test("failedCount>0 渲染「失败 3 文件」且可点击", () => {
		render(
			<KbList
				kbs={[{ ...kbReady, status: "error", failedCount: 3 }]}
				onShowFailed={mock(() => {})}
			/>,
		);
		const badge = screen.getByText("失败 3 文件");
		expect(badge).toBeTruthy();
		// 点击不抛错（B4 才接失败弹窗，本任务只要求回调可触发）
		expect(() => fireEvent.click(badge)).not.toThrow();
	});

	test("error 且 failedCount=0 渲染「索引中断」", () => {
		render(<KbList kbs={[{ ...kbReady, status: "error", failedCount: 0 }]} />);
		expect(screen.getByText("索引中断")).toBeTruthy();
	});
});

describe("KbList 操作契约", () => {
	beforeEach(() => {
		cleanup();
		useKnowledgeStore.setState({ kbs: [], progress: {}, loading: false });
	});

	test("删除按钮先弹确认（审查重点 5）：确认前不调 onDelete，确认后带 id 调用", () => {
		const onDelete = mock(() => {});
		render(<KbList kbs={[kbReady]} onDelete={onDelete} />);
		fireEvent.click(screen.getByTestId("kb-delete-kb_1"));
		expect(onDelete).not.toHaveBeenCalled(); // 确认框出现而非直接删
		fireEvent.click(screen.getByTestId("confirm-ok"));
		expect(onDelete).toHaveBeenCalledWith("kb_1");
	});

	test("autoWatch 开关切换回调", () => {
		const onToggleWatch = mock(() => {});
		render(<KbList kbs={[kbReady]} onToggleWatch={onToggleWatch} />);
		fireEvent.click(screen.getByTestId("kb-watch-toggle-kb_1"));
		expect(onToggleWatch).toHaveBeenCalledWith("kb_1", false);
	});
});

describe("knowledge store：SSE 进度合并", () => {
	beforeEach(() => {
		cleanup();
		useKnowledgeStore.setState({ kbs: [], progress: {}, loading: false });
	});

	test("applyProgress 进行中：写 progress map 并更新对应库 status/progress", () => {
		useKnowledgeStore.setState({ kbs: [kbReady] });
		useKnowledgeStore.getState().applyProgress({
			type: "knowledge:progress",
			kbId: "kb_1",
			phase: "embedding",
			filesTotal: 100,
			filesDone: 42,
			chunksDone: 0,
			status: "indexing",
		});
		const s = useKnowledgeStore.getState();
		expect(s.progress["kb_1"]?.filesDone).toBe(42);
		expect(s.kbs[0]?.status).toBe("indexing");
		expect(s.kbs[0]?.progress?.filesDone).toBe(42);
	});

	test("applyProgress 终态（ready）：清 progress map 与库内 progress", () => {
		useKnowledgeStore.setState({
			kbs: [{ ...kbReady, status: "indexing" }],
			progress: {
				kb_1: {
					type: "knowledge:progress",
					kbId: "kb_1",
					phase: "embedding",
					filesTotal: 100,
					filesDone: 99,
					chunksDone: 0,
					status: "indexing",
				},
			},
		});
		useKnowledgeStore.getState().applyProgress({
			type: "knowledge:progress",
			kbId: "kb_1",
			phase: "committing",
			filesTotal: 100,
			filesDone: 100,
			chunksDone: 100,
			status: "ready",
		});
		const s = useKnowledgeStore.getState();
		expect(s.progress["kb_1"]).toBeUndefined();
		expect(s.kbs[0]?.status).toBe("ready");
		expect(s.kbs[0]?.progress).toBeUndefined();
	});
});
