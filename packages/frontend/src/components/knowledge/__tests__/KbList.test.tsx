// KbList 知识库列表：状态徽章文案（逐字）/删除确认契约/autoWatch 开关回调 + store 进度合并。
// 注：简报示意代码用 vitest + jest-dom（toBeInTheDocument/vi.fn），本仓库未装 vitest，
// 沿用 bun:test + @testing-library/react 约定（照 ExtensionSection.test.tsx，断言 toBeTruthy）；
// 删除确认复用现有 ConfirmDialog，其确认按钮 testid 为 confirm-ok（全仓既有惯例）。
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { KbList } from "../KbList";
import { KnowledgePage } from "../KnowledgePage";
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

	test("indexing 库不渲染「索引中」徽章（进度区文案已说明生成中，徽章重复且误导）", () => {
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
		expect(screen.queryByText(/索引中/)).toBeNull();
		// 进度区仍在：统一文案 + 进度条
		expect(screen.getByText(/知识库生成中/)).toBeTruthy();
		expect(screen.getByTestId("kb-progress-kb_2")).toBeTruthy();
	});

	test("索引进行中：编辑/重建按钮置灰不可点（点了没反应更糟）", () => {
		const onEdit = mock(() => {});
		const onReindex = mock(() => {});
		render(
			<KbList
				kbs={[
					{
						...kbReady,
						id: "kb_3",
						status: "indexing",
						progress: { phase: "embedding", filesTotal: 10, filesDone: 5, chunksDone: 0 },
					},
				]}
				onEdit={onEdit}
				onReindex={onReindex}
			/>,
		);
		const edit = screen.getByTestId("kb-edit-kb_3") as HTMLButtonElement;
		const reindex = screen.getByTestId("kb-reindex-kb_3") as HTMLButtonElement;
		expect(edit.disabled).toBe(true);
		expect(reindex.disabled).toBe(true);
		fireEvent.click(reindex);
		fireEvent.click(edit);
		expect(onReindex).not.toHaveBeenCalled();
		expect(onEdit).not.toHaveBeenCalled();
	});

	test("就绪库：编辑/重建按钮可用", () => {
		const onEdit = mock(() => {});
		const onReindex = mock(() => {});
		render(<KbList kbs={[kbReady]} onEdit={onEdit} onReindex={onReindex} />);
		const edit = screen.getByTestId("kb-edit-kb_1") as HTMLButtonElement;
		const reindex = screen.getByTestId("kb-reindex-kb_1") as HTMLButtonElement;
		expect(edit.disabled).toBe(false);
		expect(reindex.disabled).toBe(false);
		fireEvent.click(reindex);
		expect(onReindex).toHaveBeenCalledWith("kb_1");
	});

	test("索引中删除按钮禁用并提示原因（不再走完确认后吃 400）", () => {
		render(
			<KbList
				kbs={[{ ...kbReady, id: "kb_busy", status: "indexing" }]}
				onDelete={mock(() => {})}
			/>,
		);
		const del = screen.getByTestId("kb-delete-kb_busy") as HTMLButtonElement;
		expect(del.disabled).toBe(true);
		expect(del.getAttribute("title")).toContain("索引");
	});

	test("failedCount>0 渲染「失败 3 文件」且可点击", () => {
		const onShowFailed = mock(() => {});
		render(
			<KbList
				kbs={[{ ...kbReady, status: "error", failedCount: 3 }]}
				onShowFailed={onShowFailed}
			/>,
		);
		const badge = screen.getByText("失败 3 文件");
		expect(badge).toBeTruthy();
		// 点击不抛错（B4 才接失败弹窗）；契约：带库 id 回调，B4 弹窗按 id 拉失败清单
		expect(() => fireEvent.click(badge)).not.toThrow();
		expect(onShowFailed).toHaveBeenCalledWith("kb_1");
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

	test("确认框打开期间库转为 indexing：确认框自动消失（不再确认后才吃 400）", () => {
		const onDelete = mock(() => {});
		const { rerender } = render(<KbList kbs={[kbReady]} onDelete={onDelete} />);
		fireEvent.click(screen.getByTestId("kb-delete-kb_1"));
		expect(screen.getByTestId("confirm-ok")).toBeTruthy();
		// 外部（watcher 自动重建 / 他处重建）把该库改为索引中
		rerender(<KbList kbs={[{ ...kbReady, status: "indexing" }]} onDelete={onDelete} />);
		expect(screen.queryByTestId("confirm-ok")).toBeNull();
		expect(onDelete).not.toHaveBeenCalled();
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
			chunksTotal: 200,
			status: "indexing",
		});
		const s = useKnowledgeStore.getState();
		expect(s.progress["kb_1"]?.filesDone).toBe(42);
		expect(s.kbs[0]?.status).toBe("indexing");
		expect(s.kbs[0]?.progress?.filesDone).toBe(42);
		// 块总量必须一并落到库进度上，否则进度条退回文件口径（一上来 100%）
		expect(s.kbs[0]?.progress?.chunksTotal).toBe(200);
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

test("error 库徽章带失败原因（lastError）作为 title/aria-label", () => {
  render(
    <KbList
      kbs={[
        {
          ...kbReady,
          id: "kb_err",
          status: "error",
          lastError: "模型加载失败 model exploded",
        },
      ]}
    />,
  );
  const badge = screen.getByTestId("kb-status-kb_err");
  expect(badge.textContent).toBe("索引中断");
  // 失败原因必须能被用户看到（悬停/读屏），不能只有四个字
  expect(badge.getAttribute("title")).toContain("model exploded");
  expect(badge.getAttribute("aria-label")).toContain("model exploded");
});

test("终态帧触发一次清单刷新：计数与失败数不会停在创建时的 0", async () => {
  const { api } = await import("../../../api-client");
  const getMock = api.get as unknown as { mockClear(): void; mock: { calls: unknown[][] } };
  getMock.mockClear();
  useKnowledgeStore.setState({ kbs: [{ ...kbReady, status: "indexing" }], progress: {}, loading: false, loaded: true });
  useKnowledgeStore.getState().applyProgress({
    type: "knowledge:progress",
    kbId: "kb_1",
    phase: "committing",
    filesTotal: 3,
    filesDone: 3,
    chunksDone: 7,
    status: "ready",
  });
  // fileCount/chunkCount/failedCount/lastIndexedAt 只能从清单回包获得：终态必须补一次拉取
  await waitFor(() =>
    expect(
      getMock.mock.calls.filter((c) => c[0] === "/api/knowledge").length,
    ).toBe(1),
  );
});

// ── 清单三态 + 请求序号（S9/S10）─────────────────────────────────────────
// 契约：拉取失败 = 未知态，不得渲染成「暂无知识库」（那是「已知为空」）；
// 并发拉取时晚到的旧回包不得覆盖新回包（否则删库/索引完成后计数会回退）。

describe("knowledge store：清单三态与并发序号", () => {
	beforeEach(() => {
		cleanup();
		useKnowledgeStore.setState({
			kbs: [],
			progress: {},
			loading: false,
			loaded: false,
			error: null,
		});
	});

	test("listKbs 失败进入 error 态：显示加载失败与重试，不显示「暂无知识库」", async () => {
		const { api } = await import("../../../api-client");
		const getMock = api.get as unknown as {
			mockRejectedValueOnce(e: Error): void;
			mock: { calls: unknown[][] };
		};
		getMock.mockRejectedValueOnce(new Error("kernel 未启动"));

		render(<KnowledgePage />);
		await waitFor(() => expect(screen.getByTestId("kb-load-error")).toBeTruthy());
		// 失败 ≠ 空清单：空态文案会误导用户以为没有库
		expect(screen.queryByTestId("kb-empty")).toBeNull();
		expect(screen.getByTestId("kb-load-error").textContent).toContain("kernel 未启动");

		// 重试按钮重新拉清单：本次 mock 走默认成功实现（空清单），error 清除后转真空态
		const before = getMock.mock.calls.length;
		fireEvent.click(screen.getByTestId("kb-retry"));
		await waitFor(() => expect(screen.getByTestId("kb-empty")).toBeTruthy());
		expect(getMock.mock.calls.length).toBeGreaterThan(before);
		expect(useKnowledgeStore.getState().error).toBeNull();
		expect(useKnowledgeStore.getState().loaded).toBe(true);
	});

	test("并发 listKbs 乱序返回：晚到的旧响应不覆盖新状态", async () => {
		const { api } = await import("../../../api-client");
		const getMock = api.get as unknown as {
			mockImplementationOnce(fn: () => Promise<unknown>): void;
			mockResolvedValueOnce(v: unknown): void;
		};
		// 第 1 次：挂起，等测试放行；第 2 次：立即返回 fileCount=3
		let releaseFirst: ((v: unknown) => void) | null = null;
		getMock.mockImplementationOnce(
			() => new Promise((resolve) => (releaseFirst = resolve)),
		);
		getMock.mockResolvedValueOnce({
			type: "knowledge:list",
			kbs: [{ ...kbReady, fileCount: 3 }],
		});

		useKnowledgeStore.getState().listKbs(); // 第 1 次（慢）
		useKnowledgeStore.getState().listKbs(); // 第 2 次（快）
		await waitFor(() => expect(useKnowledgeStore.getState().kbs[0]?.fileCount).toBe(3));

		// 放行第 1 次的旧回包（fileCount=99）：序号已过期，必须被丢弃
		expect(releaseFirst).not.toBeNull();
		act(() => {
			(releaseFirst as unknown as (v: unknown) => void)({
				type: "knowledge:list",
				kbs: [{ ...kbReady, fileCount: 99 }],
			});
		});
		await act(async () => {});
		expect(useKnowledgeStore.getState().kbs[0]?.fileCount).toBe(3);
	});
});

// ── 审查修复轮 1：刷新失败不清空列表、重试防连点、首帧不闪空态、写操作作废在途回包 ──
describe("knowledge store：刷新/重试/写操作与在途回包", () => {
	beforeEach(() => {
		cleanup();
		useKnowledgeStore.setState({
			kbs: [],
			progress: {},
			loading: false,
			loaded: false,
			error: null,
		});
	});

	test("首帧未加载时不闪「暂无知识库」：显示加载中，成功后才切换到真空态", async () => {
		const { api } = await import("../../../api-client");
		const getMock = api.get as unknown as {
			mockImplementationOnce(fn: () => Promise<unknown>): void;
		};
		let release: ((v: unknown) => void) | null = null;
		getMock.mockImplementationOnce(() => new Promise((r) => (release = r)));

		render(<KnowledgePage />);
		// loading 初值是 false，这里不可能靠 loading 判断「还没加载过」——必须用 loaded
		expect(screen.queryByTestId("kb-empty")).toBeNull();
		expect(screen.getByTestId("kb-loading")).toBeTruthy();

		act(() => {
			(release as unknown as (v: unknown) => void)({
				type: "knowledge:list",
				kbs: [],
			});
		});
		await act(async () => {});
		expect(screen.getByTestId("kb-empty")).toBeTruthy();
	});

	test("重试按钮在请求进行中置灰并显示加载态（防连点）", async () => {
		const { api } = await import("../../../api-client");
		const getMock = api.get as unknown as {
			mockRejectedValueOnce(e: Error): void;
			mockImplementationOnce(fn: () => Promise<unknown>): void;
		};
		getMock.mockRejectedValueOnce(new Error("kernel 未启动"));
		render(<KnowledgePage />);
		await waitFor(() => expect(screen.getByTestId("kb-retry")).toBeTruthy());

		let release: ((v: unknown) => void) | null = null;
		getMock.mockImplementationOnce(() => new Promise((r) => (release = r)));
		fireEvent.click(screen.getByTestId("kb-retry"));
		const btn = screen.getByTestId("kb-retry") as HTMLButtonElement;
		expect(btn.disabled).toBe(true);
		expect(btn.textContent).toContain("加载中");

		act(() => {
			(release as unknown as (v: unknown) => void)({
				type: "knowledge:list",
				kbs: [],
			});
		});
		await act(async () => {});
	});

	test("已成功加载过：后续刷新失败保留列表、不出错误块，只给弱提示", async () => {
		const { api } = await import("../../../api-client");
		const getMock = api.get as unknown as {
			mockResolvedValueOnce(v: unknown): void;
			mockRejectedValueOnce(e: Error): void;
		};
		// 第一次（mount）成功落地 → 列表可见
		getMock.mockResolvedValueOnce({ type: "knowledge:list", kbs: [kbReady] });
		render(<KnowledgePage />);
		await waitFor(() => expect(screen.getByTestId("kb-list")).toBeTruthy());

		getMock.mockRejectedValueOnce(new Error("kernel 断开"));
		await act(async () => {
			useKnowledgeStore.getState().listKbs();
		});

		// 误报加载失败是错的：数据还在（loaded 不变），只是可能不是最新
		expect(screen.queryByTestId("kb-load-error")).toBeNull();
		expect(screen.getByTestId("kb-list")).toBeTruthy();
		expect(screen.getByTestId("kb-refresh-warn")).toBeTruthy();
	});

	test("删库成功后在途清单回包不把已删库加回来（写操作作废在途回包）", async () => {
		const { api } = await import("../../../api-client");
		const getMock = api.get as unknown as {
			mockImplementationOnce(fn: () => Promise<unknown>): void;
		};
		let release: ((v: unknown) => void) | null = null;
		getMock.mockImplementationOnce(() => new Promise((r) => (release = r)));
		const other = { ...kbReady, id: "kb_2", name: "另一个库" };
		useKnowledgeStore.setState({
			kbs: [kbReady, other],
			progress: {},
			loading: false,
			loaded: true,
			error: null,
		});

		useKnowledgeStore.getState().listKbs(); // 在途（回包含 kb_1）
		await act(async () => {
			await useKnowledgeStore.getState().deleteKb("kb_1");
		});
		expect(useKnowledgeStore.getState().kbs.map((k) => k.id)).toEqual(["kb_2"]);

		act(() => {
			(release as unknown as (v: unknown) => void)({
				type: "knowledge:list",
				kbs: [kbReady, other],
			});
		});
		await act(async () => {});
		expect(useKnowledgeStore.getState().kbs.map((k) => k.id)).toEqual(["kb_2"]);
	});

	test("自动更新开关成功后在途清单回包不改回旧值", async () => {
		const { api } = await import("../../../api-client");
		const getMock = api.get as unknown as {
			mockImplementationOnce(fn: () => Promise<unknown>): void;
		};
		let release: ((v: unknown) => void) | null = null;
		getMock.mockImplementationOnce(() => new Promise((r) => (release = r)));
		useKnowledgeStore.setState({
			kbs: [{ ...kbReady, autoWatch: true }],
			progress: {},
			loading: false,
			loaded: true,
			error: null,
		});

		useKnowledgeStore.getState().listKbs(); // 在途（回包 autoWatch: true）
		await act(async () => {
			await useKnowledgeStore.getState().setAutoWatch("kb_1", false);
		});
		expect(useKnowledgeStore.getState().kbs[0]?.autoWatch).toBe(false);

		act(() => {
			(release as unknown as (v: unknown) => void)({
				type: "knowledge:list",
				kbs: [{ ...kbReady, autoWatch: true }],
			});
		});
		await act(async () => {});
		expect(useKnowledgeStore.getState().kbs[0]?.autoWatch).toBe(false);
	});
});
