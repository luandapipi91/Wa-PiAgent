// KbProgress 索引进度：百分比文案（逐字 80%）/取消回调/ready 消失 + store applyProgress 并入钉住。
// 注：简报示意代码用 vitest + jest-dom，本仓库未装 vitest，沿用 bun:test + @testing-library/react
// 约定（照 KbList.test，断言 toBeTruthy/toBeNull）；断言语义与取值逐字对齐简报，不可改。
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { KbProgress } from "../KbProgress";
import { useKnowledgeStore } from "../../../store/knowledge";
import type { KbInfo, KbProgressEvent } from "@wa-pi/shared";

const apiPost = mock(async () => ({ type: "knowledge:cancel" }));

mock.module("../../../api-client", () => ({
	api: {
		get: mock(async () => ({ type: "knowledge:list", kbs: [] })),
		post: apiPost,
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

const indexingKb: KbInfo = {
	...kbReady,
	status: "indexing",
	progress: { phase: "embedding", filesTotal: 100, filesDone: 10, chunksDone: 0 },
};

describe("KbProgress 进度条", () => {
	beforeEach(() => {
		cleanup();
	});

	test("文案统一「知识库生成中…」：不再按阶段显示「生成向量中…」", () => {
		render(
			<KbProgress
				kb={{
					...kbReady,
					status: "indexing",
					progress: { phase: "embedding", filesTotal: 100, filesDone: 100, chunksDone: 0, chunksTotal: 200 },
				}}
				onCancel={mock()}
			/>,
		);
		expect(screen.getByText(/知识库生成中/)).toBeTruthy();
		expect(screen.queryByText(/生成向量中/)).toBeNull();
	});

	test("解析阶段只占前 50%：80/100 文件 → 40%（不是 80%）", () => {
		render(
			<KbProgress
				kb={{
					...kbReady,
					status: "indexing",
					progress: { phase: "extracting", filesTotal: 100, filesDone: 80, chunksDone: 0 },
				}}
				onCancel={mock()}
			/>,
		);
		expect(screen.getByText("40%")).toBeTruthy();
	});

	test("嵌入阶段按块推进：文件已全部解析但只嵌了 50/200 块 → 63%（不再一上来 100%）", () => {
		render(
			<KbProgress
				kb={{
					...kbReady,
					status: "indexing",
					progress: { phase: "embedding", filesTotal: 100, filesDone: 100, chunksDone: 50, chunksTotal: 200 },
				}}
				onCancel={mock()}
			/>,
		);
		expect(screen.getByText("63%")).toBeTruthy();
	});

	test("嵌入阶段缺块总量（旧快照未带）→ 停在 50% 而不是 100%", () => {
		render(
			<KbProgress
				kb={{
					...kbReady,
					status: "indexing",
					progress: { phase: "embedding", filesTotal: 100, filesDone: 100, chunksDone: 0 },
				}}
				onCancel={mock()}
			/>,
		);
		expect(screen.getByText("50%")).toBeTruthy();
	});

	test("落库收尾走到 100%", () => {
		render(
			<KbProgress
				kb={{
					...kbReady,
					status: "indexing",
					progress: { phase: "committing", filesTotal: 100, filesDone: 100, chunksDone: 200, chunksTotal: 200 },
				}}
				onCancel={mock()}
			/>,
		);
		expect(screen.getByText("100%")).toBeTruthy();
	});

	test("刚创建扫描中（0 文件）：显示 0% 进度条而非空白", () => {
		render(
			<KbProgress
				kb={{
					...kbReady,
					id: "kb_new",
					status: "scanning",
					progress: { phase: "scanning", filesTotal: 0, filesDone: 0, chunksDone: 0 },
				}}
				onCancel={mock()}
			/>,
		);
		expect(screen.getByText("0%")).toBeTruthy();
	});

	test("progress 事件驱动进度条更新（审查重点 1）", () => {
		const onCancel = mock();
		const { rerender } = render(
			<KbProgress
				kb={{
					...kbReady,
					status: "indexing",
					progress: { phase: "embedding", filesTotal: 100, filesDone: 10, chunksDone: 0 },
				}}
				onCancel={onCancel}
			/>,
		);
		rerender(
			<KbProgress
				kb={{
					...kbReady,
					status: "indexing",
					progress: { phase: "embedding", filesTotal: 100, filesDone: 100, chunksDone: 80, chunksTotal: 200 },
				}}
				onCancel={onCancel}
			/>,
		);
		// 嵌入阶段按块推进：解析占 50%，嵌入再占 50%（80/200 块 → 50 + 20 = 70%）
		expect(screen.getByText("70%")).toBeTruthy();
	});

	test("取消按钮回调", () => {
		const onCancel = mock();
		render(<KbProgress kb={indexingKb} onCancel={onCancel} />);
		fireEvent.click(screen.getByTestId("kb-cancel-index-kb_1"));
		expect(onCancel).toHaveBeenCalledWith("kb_1");
	});

	test("ready 后进度区消失", () => {
		render(<KbProgress kb={kbReady} onCancel={mock()} />);
		expect(screen.queryByTestId("kb-cancel-index-kb_1")).toBeNull();
	});

	test("取消按钮 testid 带 kbId：两个库同时索引时按钮不撞车", () => {
		// 同一页面可能出现多个索引进度区（KbList 渲染全部 indexing 的库），
		// 裸 testid 会让 e2e/自动化选中第一个而误导第二个的取消操作。
		const indexingProgress = {
			phase: "embedding" as const,
			filesTotal: 10,
			filesDone: 1,
			chunksDone: 0,
		};
		render(
			<>
				<KbProgress
					kb={{ ...kbReady, id: "kb_1", status: "indexing", progress: indexingProgress }}
					onCancel={mock()}
				/>
				<KbProgress
					kb={{ ...kbReady, id: "kb_2", status: "indexing", progress: indexingProgress }}
					onCancel={mock()}
				/>
			</>,
		);
		expect(screen.getByTestId("kb-cancel-index-kb_1")).toBeTruthy();
		expect(screen.getByTestId("kb-cancel-index-kb_2")).toBeTruthy();
	});

	test("scanning 阶段也渲染进度区（仅 ready/error 消失）", () => {
		render(
			<KbProgress
				kb={{
					...kbReady,
					status: "scanning",
					progress: { phase: "scanning", filesTotal: 0, filesDone: 0, chunksDone: 0 },
				}}
				onCancel={mock()}
			/>,
		);
		expect(screen.getByTestId("kb-cancel-index-kb_1")).toBeTruthy();
	});
});

describe("store applyProgress（SSE knowledge:progress 并入，审查重点 1）", () => {
	beforeEach(() => {
		cleanup();
		useKnowledgeStore.setState({ kbs: [kbReady], progress: {}, loading: false });
	});

	test("applyProgress(evt) 并入 kbs 数组对应项 progress + progress map", () => {
		const evt: KbProgressEvent = {
			type: "knowledge:progress",
			kbId: "kb_1",
			phase: "embedding",
			filesTotal: 100,
			filesDone: 80,
			chunksDone: 640,
			status: "indexing",
		};
		useKnowledgeStore.getState().applyProgress(evt);
		const s = useKnowledgeStore.getState();
		expect(s.kbs[0].status).toBe("indexing");
		expect(s.kbs[0].progress?.filesDone).toBe(80);
		expect(s.kbs[0].progress?.filesTotal).toBe(100);
		expect(s.progress["kb_1"]?.filesDone).toBe(80);
	});

	test("终态帧清除进度并落 status（断连后 refetch 兜底前的语义闭环）", () => {
		useKnowledgeStore.getState().applyProgress({
			type: "knowledge:progress",
			kbId: "kb_1",
			phase: "embedding",
			filesTotal: 100,
			filesDone: 80,
			chunksDone: 640,
			status: "indexing",
		});
		useKnowledgeStore.getState().applyProgress({
			type: "knowledge:progress",
			kbId: "kb_1",
			phase: "committing",
			filesTotal: 100,
			filesDone: 100,
			chunksDone: 800,
			status: "ready",
		});
		const s = useKnowledgeStore.getState();
		expect(s.kbs[0].status).toBe("ready");
		expect(s.kbs[0].progress).toBeUndefined();
		expect(s.progress["kb_1"]).toBeUndefined();
	});
});

describe("store cancelIndex", () => {
	beforeEach(() => {
		cleanup();
		useKnowledgeStore.setState({ kbs: [kbReady], progress: {}, loading: false });
	});

	test("调 POST /api/knowledge/:id/cancel（取消后 refetch 对齐快照）", async () => {
		apiPost.mockClear();
		await useKnowledgeStore.getState().cancelIndex("kb_1");
		expect(apiPost).toHaveBeenCalledWith("/api/knowledge/kb_1/cancel");
	});
});
