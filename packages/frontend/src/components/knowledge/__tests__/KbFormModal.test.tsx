// KbFormModal 组件测试（任务 B3，TDD）。
// 逐字契约（简报示意测试的断言语义，取值不可改）：
//   · placeholder「不填则使用文件夹名」「不填则生成默认描述」
//   · 未选文件夹提交 → 内联提示含「请选择文件夹」且 onSave 未被调用
//   · 两段式：kb-folder-input 只读（只能经「浏览」选择，选定即自动扫描）→「3 个文件可索引」→ kb-save → onSave 带 folderPath
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
// planToken：预览计划令牌，创建时回传给 kernel 比对目录是否变化（任务 9）
const previewPayload = {
	type: "knowledge:preview",
	planToken: "plan_123",
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
// preview 备用回包（非「资料」路径）：与主回包 totalFiles 不同，供「扫描中改路径」用例区分新旧响应
const previewPayloadAlt = {
	type: "knowledge:preview",
	planToken: "plan_123",
	preview: { totalFiles: 5, totalBytes: 9000, skippable: [] },
};
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
// 创建回包（任务 9）：默认空对象，测试可注入 planChanged 模拟「预览后目录有变化」
let createReply: Record<string, unknown> = {};

/** 注入 POST /api/knowledge 的回包（如带 planChanged） */
function mockCreateReply(reply: Record<string, unknown>) {
	createReply = reply;
}

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
				// 按 folderPath 区分回包：选「资料」回主回包（3 个），其他路径回备用（5 个），
				// 供「扫描中改路径」用例严格验证旧响应被作废（回包相同则看不出丢弃）
				const fp = (body as { folderPath?: string } | undefined)?.folderPath ?? "";
				return fp.endsWith("/资料") ? previewPayload : previewPayloadAlt;
			}
			if (path === "/api/knowledge") return createReply;
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
	createReply = {};
	toastAdd.mockReset();
	// KbFormModal 现在读 store 比对重复登记：每个用例复位，避免注入的 kbs 跨用例污染
	useKnowledgeStore.setState({ kbs: [], progress: {}, loading: false });
});

afterEach(() => {
	_setFsTransport(null);
});

/** 伪 fs transport：「浏览」回退目录树（浏览器环境）拉目录用，避免真实网络；dirs 可配多个目录供改选场景 */
function mockFsTransport(dirs: string[] = ["资料"]) {
	_setFsTransport({
		get: async (path: string) => {
			if (path === "/api/fs/home") return { home: "/Users/co" };
			if (path === "/api/fs/roots") return { roots: ["/"] };
			return {};
		},
		post: async (path: string) => {
			if (path === "/api/fs/list-dir")
				return { entries: dirs.map((name) => ({ name, isDir: true })) };
			return {};
		},
		del: async () => ({}),
	});
}

/** 走「浏览 → 目录树选中 → 确定」模拟用户选择文件夹（源文件夹只读后唯一选择入口）；mock roots 下选中后路径为 /<name> */
async function pickFolder(name: string) {
	fireEvent.click(screen.getByTestId("kb-browse"));
	await screen.findByText(name);
	fireEvent.click(screen.getByText(name));
	await waitFor(() =>
		expect(
			(screen.getByTestId("dir-pick") as HTMLButtonElement).disabled,
		).toBe(false),
	);
	fireEvent.click(screen.getByTestId("dir-pick"));
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

describe("KbFormModal 输入框无浏览器默认黑色聚焦框", () => {
	// 回归：源文件夹输入框聚焦时露出浏览器默认黑色粗 outline，与弹窗内其余输入框观感不一致
	// （对齐 KbAgentsModal 搜索框同款契约：outline-none 去黑框，边框走主题 hairline）
	test("新建模式三个输入框均为 outline-none（源文件夹/名称/描述）", () => {
		render(<KbFormModal onSave={mock(() => {})} />);
		for (const testId of ["kb-folder-input", "kb-name-input", "kb-desc-input"]) {
			const input = screen.getByTestId(testId);
			expect(input.className).toContain("outline-none");
		}
	});
});

describe("KbFormModal 源文件夹只能选择不能手输", () => {
	// 契约：源文件夹不允许手动输入（readOnly），唯一入口是「浏览」选择；placeholder 引导浏览而非「输入或粘贴」
	test("kb-folder-input 为 readOnly，placeholder 引导「浏览」", () => {
		render(<KbFormModal onSave={mock(() => {})} />);
		const input = screen.getByTestId("kb-folder-input") as HTMLInputElement;
		expect(input.readOnly).toBe(true);
		expect(input.placeholder).toContain("浏览");
		expect(input.placeholder).not.toContain("输入或粘贴");
	});
});

describe("KbFormModal 同文件夹重复登记提示", () => {
	// 契约：新建模式下所选文件夹已被登记 → 内联警告（带已登记库名）+「创建并索引」禁用；
	// kernel 创建侧同样拦截（realpath 归一）兑底，前端提前到选择阶段提示
	const dupKb: KbInfo = {
		...kbReady,
		id: "kb_dup",
		name: "已登记库",
		folderPath: "/资料",
	};

	test("选择已登记路径：显示重复警告且创建按钮禁用", async () => {
		useKnowledgeStore.setState({ kbs: [dupKb], progress: {}, loading: false });
		mockFsTransport();
		render(<KbFormModal onSave={mock(async () => ({ ok: true }))} />);
		await pickFolder("资料");
		const warn = await screen.findByTestId("kb-duplicate");
		expect(warn.textContent).toContain("已登记库");
		expect(warn.textContent).toContain("重复添加");
		expect(
			(screen.getByTestId("kb-save") as HTMLButtonElement).disabled,
		).toBe(true);
	});

	test("选择未登记路径：无重复警告且创建按钮可用", async () => {
		useKnowledgeStore.setState({ kbs: [dupKb], progress: {}, loading: false });
		mockFsTransport(["资料", "文档"]);
		render(<KbFormModal onSave={mock(async () => ({ ok: true }))} />);
		await pickFolder("文档");
		await screen.findByText(/5 个文件可索引/);
		expect(screen.queryByTestId("kb-duplicate")).toBeNull();
		expect(
			(screen.getByTestId("kb-save") as HTMLButtonElement).disabled,
		).toBe(false);
	});
});

describe("KbFormModal 自动扫描（选定即预览，无需按钮）", () => {
	test("浏览选择文件夹后自动扫描：展示可索引数，且弹窗内不存在扫描按钮/失焦回车触发已随手输移除", async () => {
		mockFsTransport();
		render(<KbFormModal onSave={mock(async () => ({ ok: true }))} />);
		// 没有可点的扫描按钮
		expect(screen.queryByTestId("kb-scan")).toBeNull();
		await pickFolder("资料");
		// 选完直接出预览（无需再点扫描）
		await screen.findByText(/3 个文件可索引/);
		expect(
			postCalls.some(([p]) => p === "/api/knowledge/preview"),
		).toBe(true);
		expect(
			(screen.getByTestId("kb-folder-input") as HTMLInputElement).value,
		).toContain("资料");
	});
});

describe("KbFormModal 两段式（扫描预览 → 创建并索引）", () => {
	test("选文件夹后提交：先 preview 展示可索引数，再 save 带 folderPath", async () => {
		mockFsTransport();
		const onSave = mock(async () => ({ ok: true }));
		render(<KbFormModal onSave={onSave} />);
		await pickFolder("资料");
		// 自动扫描：选定即预览
		await screen.findByText(/3 个文件可索引/);
		fireEvent.click(screen.getByTestId("kb-save"));
		await waitFor(() =>
			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({ folderPath: "/资料" }),
			),
		);
	});

	test("预览返回 planToken：保存时随 payload 透传（供后端比对目录变化）", async () => {
		mockFsTransport();
		const onSave = mock(async () => ({ ok: true }));
		render(<KbFormModal onSave={onSave} />);
		await pickFolder("资料");
		await screen.findByText(/3 个文件可索引/);
		fireEvent.click(screen.getByTestId("kb-save"));
		await waitFor(() =>
			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({ planToken: "plan_123" }),
			),
		);
	});

	test("扫描预览展示跳过原因计数：建议排除 2 / 二进制 1", async () => {
		mockFsTransport();
		render(<KbFormModal onSave={mock(async () => ({ ok: true }))} />);
		await pickFolder("资料");
		await screen.findByText(/3 个文件可索引/);
		expect(screen.getByText(/建议排除 2/)).toBeTruthy();
		expect(screen.getByText(/二进制 1/)).toBeTruthy();
	});

	test("扫描中重新选择新路径：旧响应作废不落地，提交走新路径（审查修复 1 语义保持）", async () => {
		mockFsTransport(["资料", "文档"]);
		const onSave = mock(async () => ({ ok: true }));
		render(<KbFormModal onSave={onSave} />);
		// 挂起 preview 响应，制造在途扫描
		let release!: () => void;
		previewGate = new Promise<void>((r) => {
			release = r;
		});
		await pickFolder("资料"); // A 路径在途挂起
		// 扫描中重新选择新路径 B（作废在途扫描）
		fireEvent.click(screen.getByTestId("kb-browse"));
		await screen.findByText("文档");
		fireEvent.click(screen.getByText("文档"));
		await waitFor(() =>
			expect(
				(screen.getByTestId("dir-pick") as HTMLButtonElement).disabled,
			).toBe(false),
		);
		fireEvent.click(screen.getByTestId("dir-pick"));
		// 放行响应：A 的旧回包（3 个）须被序号丢弃，只有 B 的新回包（5 个）落地
		release();
		await new Promise((r) => setTimeout(r, 10));
		expect(screen.queryByText(/3 个文件可索引/)).toBeNull();
		await screen.findByText(/5 个文件可索引/);
		// 提交走新路径 B
		fireEvent.click(screen.getByTestId("kb-save"));
		await waitFor(() =>
			expect(onSave).toHaveBeenCalledWith(
				expect.objectContaining({ folderPath: "/文档" }),
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
		mockFsTransport();
		render(<KnowledgePage />);
		fireEvent.click(screen.getByTestId("kb-add-button"));
		expect(screen.getByTestId("kb-form-modal")).toBeTruthy();
		await pickFolder("资料");
		await screen.findByText(/3 个文件可索引/);
		fireEvent.click(screen.getByTestId("kb-save"));
		await waitFor(() =>
			expect(screen.queryByTestId("kb-form-modal")).toBeNull(),
		);
		expect(
			postCalls.some(
				([p, b]) =>
					p === "/api/knowledge" &&
					(b as KbFormPayload).folderPath === "/资料" &&
					(b as KbFormPayload).name === undefined,
			),
		).toBeTruthy();
	});

	test("预览后目录变化：创建成功弹出变化提示（新增/减少文件数）", async () => {
		mockFsTransport();
		mockCreateReply({
			type: "knowledge:create",
			kb: { ...kbReady, id: "kb_new" },
			planChanged: { added: ["c.md"], removed: ["b.txt"] },
		});
		render(<KnowledgePage />);
		fireEvent.click(screen.getByTestId("kb-add-button"));
		await pickFolder("资料");
		// 两段式：先扫描预览（带回 planToken），再提交
		await screen.findByText(/3 个文件可索引/);
		fireEvent.click(screen.getByTestId("kb-save"));
		await waitFor(() =>
			expect(toastAdd).toHaveBeenCalledWith(
				expect.stringContaining("新增 1"),
				"info",
			),
		);
		// 提示同时带减少数
		expect(toastAdd).toHaveBeenCalledWith(
			expect.stringContaining("减少 1"),
			"info",
		);
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
