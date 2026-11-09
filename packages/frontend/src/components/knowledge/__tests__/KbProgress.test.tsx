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
					progress: { phase: "embedding", filesTotal: 100, filesDone: 80, chunksDone: 640 },
				}}
				onCancel={onCancel}
			/>,
		);
		// 逐字断言：80%（round(filesDone/filesTotal*100)）
		expect(screen.getByText(/80%/)).toBeTruthy();
	});

	test("取消按钮回调", () => {
		const onCancel = mock();
		render(<KbProgress kb={indexingKb} onCancel={onCancel} />);
		fireEvent.click(screen.getByTestId("kb-cancel"));
		expect(onCancel).toHaveBeenCalledWith("kb_1");
	});

	test("ready 后进度区消失", () => {
		render(<KbProgress kb={kbReady} onCancel={mock()} />);
		expect(screen.queryByTestId("kb-cancel")).toBeNull();
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
		expect(screen.getByTestId("kb-cancel")).toBeTruthy();
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
