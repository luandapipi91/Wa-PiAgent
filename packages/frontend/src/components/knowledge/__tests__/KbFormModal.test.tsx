// KbFormModal 组件测试（任务 B3，TDD）。
// 逐字契约（简报示意测试的断言语义，取值不可改）：
//   · placeholder「不填则使用文件夹名」「不填则生成默认描述」
//   · 未选文件夹提交 → 内联提示含「请选择文件夹」且 onSave 未被调用
//   · 两段式：kb-folder-input（失焦/回车自动扫描）→「3 个文件可索引」→ kb-save → onSave 带 folderPath
//   · 跳过原因计数「建议排除 2」（suggested_excluded 中文映射 + 数量）
//   · 编辑模式回填：kb-name-input value = 产品知识库
// 注：简报示意代码是 vitest + jest-dom 语义，沿用本仓库 bun:test 约定（照 KbList.test.tsx）：
// vi.fn → mock、toBeInTheDocument → toBeTruthy；api mock 用 mock.module（B2 同款零侵入）。
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
	render,
	screen,
	fireEvent,
	waitFor,
	cleanup,
} from "@testing-library/react";
import { KbFormModal, type KbFormPayload } from "../KbFormModal";
import { KnowledgePage } from "../KnowledgePage";
import { useKnowledgeStore } from "../../../store/knowledge";
import { _setFsTransport } from "../../../fs-client";
import enLocale from "../../../i18n/locales/en";
import type { KbInfo } from "@wa-pi/shared";

// 伪 preview 回包：3 个可索引 + 2 项建议排除 + 1 项二进制（覆盖跳过原因计数映射）
const previewPayload = {
	type: "knowledge:preview",
	preview: {
		totalFiles: 3,
		totalBytes: 48000,
		skippable: [
			{ path: "D:/资料/产品文档/node_modules/a.js", reason: "suggested_excluded" },
			{ path: "D:/资料/产品文档/node_modules/b.js", reason: "suggested_excluded" },
			{ path: "D:/资料/产品文档/logo.png", reason: "binary" },
		],
	},
};

// POST 调用记录（供挂接链路断言：保存发了什么路径/载荷）；
// get 回带 kbReady 的清单：KnowledgePage mount 必拉 listKbs（会覆盖 setState 注入），
// 让清单稳定含 kbReady，供「更新入口」测试使用（弹窗测试不消费 get，互不影响）
const postCalls: Array<[string, unknown]> = [];
// GET 调用记录（重建成功后 refetch listKbs 断言用）；get 回带 kbReady 的清单：
// KnowledgePage mount 必拉 listKbs（会覆盖 setState 注入），
// 让清单稳定含 kbReady，供「更新入口」测试使用（弹窗测试不消费 get，互不影响）
const getCalls: string[] = [];
// POST 失败闸（重建重复索引 400 测试用）：设为路径时该路径的 post 拒绝；beforeEach 复位
let postFailPath: string | null = null;
// toast 断言（ContactsPanel.test.tsx 同款）：ToastContainer 只在 App 挂载，测试里 mock store 断 add 调用
const toastAdd = mock(() => {});
// preview 延迟闸（扫描竞态测试用）：非 undefined 时 preview 响应挂起直到放行；beforeEach 复位
let previewGate: Promise<void> | undefined;

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

mock.module("../../../store/toast", () => ({
	useToastStore: { getState: () => ({ add: toastAdd, toasts: [] }) },
}));

mock.module("../../../api-client", () => ({
	api: {
		get: mock(async (path: string) => {
			getCalls.push(path);
			return { type: "knowledge:list", kbs: [kbReady] };
		}),
		post: mock(async (path: string, body?: unknown) => {
			postCalls.push([path, body]);
			if (postFailPath === path) {
				throw new Error("知识库 kb_1 已有进行中的索引任务");
			}
			if (path === "/api/knowledge/preview") {
				if (previewGate) await previewGate;
				return previewPayload;
			}
			return {};
		}),
		put: mock(async () => ({})),
		del: mock(async () => ({})),
	},
}));

beforeEach(() => {
	cleanup();
	postCalls.length = 0;
	getCalls.length = 0;
	previewGate = undefined;
	postFailPath = null;
	toastAdd.mockReset();
});

afterEach(() => {
	_setFsTransport(null);
});

/** 伪 fs transport：「浏览」回退目录树（浏览器环境）拉目录用，避免真实网络 */
function mockFsTransport() {
	_setFsTransport({
		get: async (path: string) => {
			if (path === "/api/fs/home") return { home: "/Users/co" };
			if (path === "/api/fs/roots") return { roots: ["/"] };
			return {};
		},
		post: async (path: string) => {
			if (path === "/api/fs/list-dir")
				return { entries: [{ name: "资料", isDir: true }] };
			return {};
		},
		del: async () => ({}),
	});
}

describe("KbFormModal 校验与默认值提示", () => {
	test("未选文件夹提交被拦截（审查重点 3）：内联提示「请选择文件夹」且不调 onSave", async () => {
		const onSave = mock(() => {});
		render(<KbFormModal onSave={onSave} />);
		fireEvent.click(screen.getByTestId("kb-save"));
		await waitFor(() =>
			expect(screen.getByText(/请选择文件夹/)).toBeTruthy(),
		);
		expect(onSave).not.toHaveBeenCalled();
	});

	test("名称/描述 placeholder 提示默认值规则", () => {
		render(<KbFormModal onSave={mock(() => {})} />);
		expect(screen.getByPlaceholderText(/不填则使用文件夹名/)).toBeTruthy();
		expect(screen.getByPlaceholderText(/不填则生成默认描述/)).toBeTruthy();
	});
});

describe("KbFormModal 自动扫描（选定路径即预览，无需按钮）", () => {
	test("输入路径失焦即自动扫描：展示可索引数，且弹窗内不存在扫描按钮", async () => {
		render(<KbFormModal onSave={mock(async () => ({ ok: true }))} />);
		const input = screen.getByTestId("kb-folder-input");
		fireEvent.change(input, { target: { value: "D:/资料/产品文档" } });
		// 没有可点的扫描按钮：选定路径（失焦）即触发
		expect(screen.queryByTestId("kb-scan")).toBeNull();
		fireEvent.blur(input);
		await screen.findByText(/3 个文件可索引/);
		expect(
			postCalls.some(([p]) => p === "/api/knowledge/preview"),
		).toBe(true);
	});

	test("输入路径回车即自动扫描（不必等失焦）", async () => {
		render(<KbFormModal onSave={mock(async () => ({ ok: true }))} />);
		const input = screen.getByTestId("kb-folder-input");
		fireEvent.change(input, { target: { value: "D:/资料/产品文档" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await screen.findByText(/3 个文件可索引/);
	});

	test("目录树选中文件夹后自动扫描（不再需要手点扫描）", async () => {
		mockFsTransport();
		render(<KbFormModal onSave={mock(async () => ({ ok: true }))} />);
		fireEvent.click(screen.getByTestId("kb-browse"));
		// 目录树懒加载出 home 下的子目录 → 选中 → 确定
		await screen.findByText("资料");
		fireEvent.click(screen.getByText("资料"));
		await waitFor(() =>
			expect(
				(screen.getByTestId("dir-pick") as HTMLButtonElement).disabled,
			).toBe(false),
		);
		fireEvent.click(screen.getByTestId("dir-pick"));
		// 选完直接出预览（无需再点扫描）
		await screen.findByText(/3 个文件可索引/);
		expect(
			(screen.getByTestId("kb-folder-input") as HTMLInputElement).value,
		).toContain("资料");
	});

	test("同一路径不重复扫描：改回原路径重新失焦仍只算一次（去重）", async () => {
		render(<KbFormModal onSave={mock(async () => ({ ok: true }))} />);
		const input = screen.getByTestId("kb-folder-input");
		fireEvent.change(input, { target: { value: "D:/资料/产品文档" } });
		fireEvent.blur(input);
		await screen.findByText(/3 个文件可索引/);
		const first = postCalls.filter(([p]) => p === "/api/knowledge/preview").length;
		fireEvent.blur(input);
		await new Promise((r) => setTimeout(r, 10));
		const second = postCalls.filter(([p]) => p === "/api/knowledge/preview").length;
		expect(second).toBe(first);
	});
});

describe("KbFormModal 两段式（扫描预览 → 创建并索引）", () => {
	test("选文件夹后提交：先 preview 展示可索引数，再 save 带 folderPath", async () => {
		const onSave = mock(async () => ({ ok: true }));
		render(<KbFormModal onSave={onSave} />);
		fireEvent.change(screen.getByTestId("kb-folder-input"), {
			target: { value: "D:/资料/产品文档" },
		});
		// 自动扫描：路径失焦即预览（按钮已移除）
		fireEvent.blur(screen.getByTestId("kb-folder-input"));
		await screen.findByText(/3 个文件可索引/);
		fireEvent.click(screen.getByTestId("kb-save"));
		await waitFor(() =>
			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({ folderPath: "D:/资料/产品文档" }),
			),
		);
	});

	test("扫描预览展示跳过原因计数：建议排除 2 / 二进制 1", async () => {
		render(<KbFormModal onSave={mock(async () => ({ ok: true }))} />);
		fireEvent.change(screen.getByTestId("kb-folder-input"), {
			target: { value: "D:/资料/产品文档" },
		});
		fireEvent.blur(screen.getByTestId("kb-folder-input"));
		await screen.findByText(/3 个文件可索引/);
		expect(screen.getByText(/建议排除 2/)).toBeTruthy();
		expect(screen.getByText(/二进制 1/)).toBeTruthy();
	});

	test("扫描中改路径：旧响应 resolve 后不落地旧路径预览，提交走新路径（审查修复 1）", async () => {
		const onSave = mock(async () => ({ ok: true }));
		render(<KbFormModal onSave={onSave} />);
		fireEvent.change(screen.getByTestId("kb-folder-input"), {
			target: { value: "D:/旧路径A" },
		});
		// 挂起 preview 响应，制造在途扫描
		let release!: () => void;
		previewGate = new Promise<void>((r) => {
			release = r;
		});
		fireEvent.blur(screen.getByTestId("kb-folder-input"));
		// 扫描中改路径 B（作废在途扫描）
		fireEvent.change(screen.getByTestId("kb-folder-input"), {
			target: { value: "D:/新路径B" },
		});
		// 放行旧响应（A 路径的 previewPayload），flush 宏任务让 handleScan 走完
		release();
		await new Promise((r) => setTimeout(r, 10));
		// 旧预览不得出现（否则 A 的「3 个文件可索引」会误导 B 路径提交）
		expect(screen.queryByTestId("kb-preview")).toBeNull();
		expect(screen.queryByText(/3 个文件可索引/)).toBeNull();
		// 提交走新路径 B
		fireEvent.click(screen.getByTestId("kb-save"));
		await waitFor(() =>
			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({ folderPath: "D:/新路径B" }),
			),
		);
	});

	test("操作行取消按钮为文字「取消」（与标题栏关闭区分，对齐 McpForm 惯例）", () => {
		render(<KbFormModal onSave={mock(() => {})} />);
		expect(screen.getByTestId("kb-cancel").textContent).toBe("取消");
	});
});

describe("KbFormModal 编辑模式", () => {
	test("回填现有名称/描述（kb-name-input = 产品知识库）", () => {
		render(<KbFormModal kb={kbReady} onSave={mock(async () => ({ ok: true }))} />);
		expect(
			(screen.getByTestId("kb-name-input") as HTMLInputElement).value,
		).toBe("产品知识库");
		expect(
			(screen.getByTestId("kb-desc-input") as HTMLInputElement).value,
		).toBe("产品定价与规格");
	});

	test("编辑模式无文件夹输入与扫描区，保存直接走 onSave（PUT 语义：只更名称/描述）", async () => {
		const onSave = mock(async () => ({ ok: true }));
		render(<KbFormModal kb={kbReady} onSave={onSave} />);
		expect(screen.queryByTestId("kb-folder-input")).toBeNull();
		expect(screen.queryByTestId("kb-scan")).toBeNull();
		fireEvent.click(screen.getByTestId("kb-save"));
		await waitFor(() => expect(onSave).toHaveBeenCalled());
	});
});

// 挂接链路（实现要点）：新建按钮/卡片更新入口打开弹窗；保存成功后关弹窗 + 刷新清单。
// KnowledgePage 的 store/api 均走本文件顶部已 mock 的 api-client（零侵入）。
describe("KnowledgePage 挂接", () => {
	beforeEach(() => {
		cleanup();
		postCalls.length = 0;
		useKnowledgeStore.setState({ kbs: [], progress: {}, loading: false });
	});

	test("新建按钮打开弹窗；保存成功后关闭弹窗并发 POST（带 folderPath，名称留空 → undefined 由后端兜底）", async () => {
		render(<KnowledgePage />);
		fireEvent.click(screen.getByTestId("kb-add-button"));
		expect(screen.getByTestId("kb-form-modal")).toBeTruthy();
		fireEvent.change(screen.getByTestId("kb-folder-input"), {
			target: { value: "D:/资料/产品文档" },
		});
		fireEvent.click(screen.getByTestId("kb-save"));
		await waitFor(() =>
			expect(screen.queryByTestId("kb-form-modal")).toBeNull(),
		);
		expect(
			postCalls.some(
				([p, b]) =>
					p === "/api/knowledge" &&
					(b as KbFormPayload).folderPath === "D:/资料/产品文档" &&
					(b as KbFormPayload).name === undefined,
			),
		).toBeTruthy();
	});

	test("卡片「编辑」入口打开编辑弹窗并回填名称（保存文案 = 保存）", async () => {
		render(<KnowledgePage />);
		// 清单来自 get mock（mount 时 listKbs 拉取），等卡片就绪再操作
		fireEvent.click(await screen.findByTestId("kb-edit-kb_1"));
		expect(
			(screen.getByTestId("kb-name-input") as HTMLInputElement).value,
		).toBe("产品知识库");
		expect(screen.getByTestId("kb-save").textContent).toBe("保存");
	});

	test("en 文案无字面双 &&（React 不解析 HTML 实体，审查修复 2）", () => {
		expect((enLocale as any).kb.saveNew).toBe("Create & Index");
		expect((enLocale as any).kb.cancel).toBe("Cancel");
	});

	test("卡片「重建」入口 → POST /api/knowledge/kb_1/index 被调，成功后 refetch 清单（最终审查修复）", async () => {
		render(<KnowledgePage />);
		// 等卡片就绪（mount 时 listKbs 拉取清单）；此时已有 1 次 GET（mount）
		await screen.findByTestId("kb-reindex-kb_1");
		const getBefore = getCalls.filter((p) => p === "/api/knowledge").length;
		fireEvent.click(screen.getByTestId("kb-reindex-kb_1"));
		await waitFor(() =>
			expect(
				postCalls.some(([p]) => p === "/api/knowledge/kb_1/index"),
			).toBeTruthy(),
		);
		// 成功后刷新清单（与 cancelIndex 同构：POST 成功 → listKbs()）
		await waitFor(() =>
			expect(
				getCalls.filter((p) => p === "/api/knowledge").length,
			).toBeGreaterThan(getBefore),
		);
	});

	test("重建遇 kernel 重复索引防护（400）→ toast 提示且不 refetch", async () => {
		postFailPath = "/api/knowledge/kb_1/index";
		render(<KnowledgePage />);
		fireEvent.click(await screen.findByTestId("kb-reindex-kb_1"));
		// POST 已发出但被防护拒绝
		await waitFor(() =>
			expect(
				postCalls.some(([p]) => p === "/api/knowledge/kb_1/index"),
			).toBeTruthy(),
		);
		// 失败经 toast 提示（formatApiError 对纯 message 错误原样展示）
		await waitFor(() =>
			expect(toastAdd).toHaveBeenCalledWith(
				"知识库 kb_1 已有进行中的索引任务",
				"error",
			),
		);
		// 失败路径：不刷新清单（除 mount 外无新增 GET）
		expect(getCalls.filter((p) => p === "/api/knowledge").length).toBe(1);
	});
});
