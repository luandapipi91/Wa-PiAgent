// MediaPreviewModal 标注入口与保存接线：
// - 只有「附件图片（annotatablePath 与当前项一致）+ 路径在 .wa-pi/uploads 下 + 扩展名
//   png/jpg/jpeg/webp」时才在顶栏渲染笔按钮；
// - 进入标注态后主体换成 ImageAnnotator，顶栏隐藏缩放/复制/翻页，Esc 交给标注组件；
// - 保存走 fs-client.overwriteFile（POST /api/files/overwrite）→ bump 版本号 → toast → 退出标注态，
//   失败则 toast 并保留标注态（shapes 在 ImageAnnotator 内，不丢用户劳动）。
// 同目录画廊（useDirGallery）与缩略图条（ThumbStrip）与本任务无关：打桩以免目录请求/虚拟滚动干扰。
import { test, expect, beforeAll, afterAll, beforeEach, afterEach, mock } from "bun:test";

mock.module("../src/components/blocks/useDirGallery", () => ({
	useDirGallery: () => {},
}));
mock.module("../src/components/blocks/ThumbStrip", () => ({
	ThumbStrip: () => null,
}));

import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import i18n from "../src/i18n";
import { MediaPreviewModal } from "../src/components/blocks/MediaPreviewModal";
import {
	isAnnotatableImageSrc,
	type MediaItem,
} from "../src/components/blocks/media-utils";
import { openFileOrPreview } from "../src/open-file-preview";
import { useSessionStore } from "../src/store/session";
import { useProjectsStore } from "../src/store/projects";
import { useToastStore } from "../src/store/toast";
import { useImageRevisionStore } from "../src/store/image-revision";

// happy-dom 在 about:blank 下无法解析相对 URL（/file?path=...），与本目录其他预览测试同处理
beforeAll(() => (window as any).happyDOM?.setURL?.("http://localhost/"));
afterAll(() => (window as any).happyDOM?.setURL?.("about:blank"));

const A: MediaItem = {
	src: "/work/demo/.wa-pi/uploads/a.png",
	kind: "image",
	name: "a.png",
};
const B: MediaItem = {
	src: "/work/demo/.wa-pi/uploads/b.png",
	kind: "image",
	name: "b.png",
};

// ─── happy-dom 无 canvas 2D 与真实图片解码：注入打桩（同 ImageAnnotator.test.tsx）──
const ctxCalls: string[] = [];

function makeFakeCtx() {
	return {
		font: "",
		textBaseline: "",
		strokeStyle: "",
		fillStyle: "",
		lineWidth: 0,
		lineCap: "",
		lineJoin: "",
		save: () => ctxCalls.push("save"),
		restore: () => ctxCalls.push("restore"),
		beginPath: () => ctxCalls.push("beginPath"),
		closePath: () => ctxCalls.push("closePath"),
		moveTo: () => ctxCalls.push("moveTo"),
		lineTo: () => ctxCalls.push("lineTo"),
		quadraticCurveTo: () => ctxCalls.push("quadraticCurveTo"),
		stroke: () => ctxCalls.push("stroke"),
		fill: () => ctxCalls.push("fill"),
		arc: () => ctxCalls.push("arc"),
		ellipse: () => ctxCalls.push("ellipse"),
		strokeRect: () => ctxCalls.push("strokeRect"),
		fillText: () => ctxCalls.push("fillText"),
		clearRect: () => ctxCalls.push("clearRect"),
		drawImage: () => ctxCalls.push("drawImage"),
		measureText: (text: string) => ({ width: text.length * 8 }),
	};
}

const canvasProto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
const originalGetContext = canvasProto.getContext;
const originalToBlob = canvasProto.toBlob;
const originalGetRect = canvasProto.getBoundingClientRect;
const originalImage = (globalThis as Record<string, unknown>).Image;
const originalFetch = globalThis.fetch;

/** 导出画布时用的 mime（标注保存按扩展名映射，断言 png→image/png 用） */
let exportedMime = "";
/** 图片解码结果的自然尺寸（超限用例改成 9000 等） */
let imageNatural = { w: 100, h: 100 };

// ─── 覆盖保存的 fetch 打桩：记录请求，按 case 返回成功/错误 ───
type FetchCall = { url: string; init: RequestInit };
let fetchCalls: FetchCall[] = [];
let overwriteResult: () => Response | Promise<Response> = () =>
	new Response(JSON.stringify({ type: "fs:overwrite", path: A.src }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

beforeEach(() => {
	ctxCalls.length = 0;
	exportedMime = "";
	imageNatural = { w: 100, h: 100 };
	canvasProto.getContext = () => makeFakeCtx();
	canvasProto.toBlob = (cb: (blob: Blob | null) => void, mime: string) => {
		exportedMime = mime;
		cb(new Blob(["png"], { type: mime }));
	};
	canvasProto.getBoundingClientRect = () => new DOMRect(0, 0, 100, 100);
	(globalThis as Record<string, unknown>).Image = class {
		naturalWidth = imageNatural.w;
		naturalHeight = imageNatural.h;
		onload: (() => void) | null = null;
		onerror: (() => void) | null = null;
		set src(_value: string) {
			this.onload?.();
		}
	};
	fetchCalls = [];
	overwriteResult = () =>
		new Response(JSON.stringify({ type: "fs:overwrite", path: A.src }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	(globalThis as Record<string, unknown>).fetch = mock(
		async (url: string, init: RequestInit) => {
			fetchCalls.push({ url, init });
			return overwriteResult();
		},
	);

	useSessionStore.setState({ mediaPreview: null });
	useToastStore.setState({ toasts: [] });
	useImageRevisionStore.setState({ revisions: {} });
	useProjectsStore.setState({
		projects: [{ id: "p1", name: "demo", cwd: "/work/demo" } as any],
		sessions: [{ id: "s1", projectId: "p1" } as any],
	});
});

afterEach(() => {
	cleanup();
	canvasProto.getContext = originalGetContext;
	canvasProto.toBlob = originalToBlob;
	canvasProto.getBoundingClientRect = originalGetRect;
	(globalThis as Record<string, unknown>).Image = originalImage;
	globalThis.fetch = originalFetch;
});

function openPreview(items: MediaItem[], annotatablePath?: string) {
	useSessionStore
		.getState()
		.openMediaPreview(
			items,
			0,
			"s1",
			annotatablePath ? { annotatablePath } : undefined,
		);
}

const toastMessages = () =>
	useToastStore.getState().toasts.map((toast) => toast.message);

/** 在标注画布上画一笔（宿主 mock 比例 1：client 坐标 = 自然坐标） */
function drawStroke(canvas: HTMLElement) {
	fireEvent.pointerDown(canvas, {
		pointerId: 1,
		button: 0,
		clientX: 10,
		clientY: 10,
	});
	fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 40, clientY: 30 });
	fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 60, clientY: 50 });
}

// ─── 入口：笔按钮的显示条件 ───

test("附件图片（uploads 下 png 且 annotatablePath 匹配）→ 顶栏出现笔按钮", () => {
	openPreview([A, B], A.src);
	render(<MediaPreviewModal />);
	expect(screen.getByTestId("media-annotate")).toBeTruthy();
});

test("笔按钮是图片上的圆形悬浮按钮：不在顶栏、70px、默认半透明、悬停放大变清晰", () => {
	openPreview([A, B], A.src);
	render(<MediaPreviewModal />);
	const btn = screen.getByTestId("media-annotate");

	// 不再是右上角顶栏里的图标按钮：顶栏（拖动把手）内不应包含它
	const topbar = document.querySelector("[data-modal-drag-handle]");
	expect(topbar?.contains(btn)).toBe(false);

	// 圆形 70px、绝对定位浮在图片上、默认半透明 + 悬停放大并变清晰
	expect(btn.className).toContain("h-[70px]");
	expect(btn.className).toContain("w-[70px]");
	expect(btn.className).toContain("rounded-full");
	expect(btn.className).toContain("absolute");
	expect(btn.className).toContain("opacity-60");
	expect(btn.className).toContain("hover:opacity-100");
	expect(btn.className).toContain("hover:scale-110");
	expect(btn.className).toContain("transition-");
	// 有可访问名称（图标按钮不能只有 title）
	expect(btn.getAttribute("aria-label")).toBeTruthy();
});

test("annotatablePath 不匹配（聊天里的图片等其他入口）→ 不出现笔按钮", () => {
	openPreview([A, B], B.src);
	render(<MediaPreviewModal />);
	expect(screen.queryByTestId("media-annotate")).toBeNull();
	cleanup();

	// 完全没有 annotatablePath（MarkdownImage 等入口）同样不显示
	openPreview([A, B]);
	render(<MediaPreviewModal />);
	expect(screen.queryByTestId("media-annotate")).toBeNull();
});

test("路径不在 .wa-pi/uploads 下 或 扩展名不在白名单（gif）→ 不出现笔按钮", () => {
	const outside: MediaItem = {
		src: "/work/demo/pics/a.png",
		kind: "image",
		name: "a.png",
	};
	openPreview([outside], outside.src);
	render(<MediaPreviewModal />);
	expect(screen.queryByTestId("media-annotate")).toBeNull();
	cleanup();

	const gif: MediaItem = {
		src: "/work/demo/.wa-pi/uploads/a.gif",
		kind: "image",
		name: "a.gif",
	};
	openPreview([gif], gif.src);
	render(<MediaPreviewModal />);
	expect(screen.queryByTestId("media-annotate")).toBeNull();
});

test("isAnnotatableImageSrc：uploads 段 + png/jpg/jpeg/webp 白名单", () => {
	expect(isAnnotatableImageSrc("/w/p/.wa-pi/uploads/a.png")).toBe(true);
	expect(isAnnotatableImageSrc("C:\\w\\p\\.wa-pi\\uploads\\a.JPG")).toBe(true);
	expect(isAnnotatableImageSrc("/w/p/.wa-pi/uploads/a.jpeg")).toBe(true);
	expect(isAnnotatableImageSrc("/w/p/.wa-pi/uploads/a.webp")).toBe(true);
	expect(isAnnotatableImageSrc("/w/p/.wa-pi/uploads/a.gif")).toBe(false);
	expect(isAnnotatableImageSrc("/w/p/pics/a.png")).toBe(false);
	expect(isAnnotatableImageSrc("/w/p/.wa-pi/uploadsx/a.png")).toBe(false);
});

test("路径写法不同（annotatablePath 反斜杠 / item.src 正斜杠）→ 仍能匹配并显示笔按钮", () => {
	// 真实链路：上传接口在 Windows 返回反斜杠路径，同目录画廊回写的 src 是正斜杠归一形式
	const win: MediaItem = {
		src: "C:/work/demo/.wa-pi/uploads/a.png",
		kind: "image",
		name: "a.png",
	};
	openPreview([win], "C:\\work\\demo\\.wa-pi\\uploads\\a.png");
	render(<MediaPreviewModal />);
	expect(screen.getByTestId("media-annotate")).toBeTruthy();
});

// ─── 标注态 ───

test("点击笔 → 进入标注态：主体换成 ImageAnnotator，顶栏保留缩放、隐藏复制/笔/翻页", () => {
	openPreview([A, B], A.src);
	render(<MediaPreviewModal />);
	fireEvent.click(screen.getByTestId("media-annotate"));

	expect(screen.getByTestId("image-annotator")).toBeTruthy();
	expect(screen.getByTestId("annotator-bar")).toBeTruthy();
	expect(screen.getByTestId("annotator-canvas").getAttribute("aria-label")).toBe(
		"a.png",
	);
	// 图片缩放视口被替换（不再叠一层）
	expect(screen.queryByTestId("zoomable-image")).toBeNull();
	// 顶栏：复制 / 笔 / 翻页隐藏；缩放控件保留（编辑态也要能缩放，控的是标注画布）
	expect(screen.queryByTestId("media-copy")).toBeNull();
	expect(screen.queryByTestId("media-annotate")).toBeNull();
	expect(screen.queryByTestId("media-next")).toBeNull();
	expect(screen.getByTestId("media-zoom-out")).toBeTruthy();
	expect(screen.getByTestId("media-zoom-in")).toBeTruthy();
	expect(screen.getByTestId("media-zoom-percent").textContent).toBe("100%");
	expect(screen.getByTestId("media-counter").textContent).toBe("1 / 2");
});

test("标注态点取消（无图形）→ 回到可缩放图片预览", () => {
	openPreview([A, B], A.src);
	render(<MediaPreviewModal />);
	fireEvent.click(screen.getByTestId("media-annotate"));
	fireEvent.click(screen.getByTestId("annotator-cancel"));

	expect(screen.queryByTestId("image-annotator")).toBeNull();
	expect(screen.getByTestId("zoomable-image")).toBeTruthy();
	expect(screen.getByTestId("media-annotate")).toBeTruthy();
	// 弹窗未关闭
	expect(useSessionStore.getState().mediaPreview).not.toBeNull();
});

test("标注态 Esc 不关闭预览窗（closeOnEsc=false），由标注组件退出标注态", () => {
	openPreview([A, B], A.src);
	render(<MediaPreviewModal />);
	fireEvent.click(screen.getByTestId("media-annotate"));
	fireEvent.keyDown(window, { key: "Escape" });

	expect(useSessionStore.getState().mediaPreview).not.toBeNull();
	expect(screen.queryByTestId("image-annotator")).toBeNull();
	expect(screen.getByTestId("zoomable-image")).toBeTruthy();
});

// ─── 顶栏 ✕：标注态先走丢弃确认，再关窗 ───

test("标注态点 ✕（无未保存图形）→ 直接关窗", () => {
	openPreview([A, B], A.src);
	render(<MediaPreviewModal />);
	fireEvent.click(screen.getByTestId("media-annotate"));
	fireEvent.click(screen.getByTestId("media-close"));

	expect(screen.queryByTestId("media-preview-modal")).toBeNull();
	expect(useSessionStore.getState().mediaPreview).toBeNull();
});

test("标注态点 ✕（有未保存图形）→ 先弹丢弃确认，确认后关窗", () => {
	openPreview([A, B], A.src);
	render(<MediaPreviewModal />);
	fireEvent.click(screen.getByTestId("media-annotate"));
	drawStroke(screen.getByTestId("annotator-canvas"));

	fireEvent.click(screen.getByTestId("media-close"));
	// 未确认前不关窗、不丢图形
	expect(screen.getByTestId("annotator-confirm")).toBeTruthy();
	expect(screen.getByTestId("media-preview-modal")).toBeTruthy();
	expect(useSessionStore.getState().mediaPreview).not.toBeNull();

	fireEvent.click(screen.getByTestId("annotator-confirm-yes"));
	expect(useSessionStore.getState().mediaPreview).toBeNull();
});

test("丢弃确认点「取消」→ 撤销关窗意图，继续标注；之后浮条取消只回预览不关窗", () => {
	openPreview([A, B], A.src);
	render(<MediaPreviewModal />);
	fireEvent.click(screen.getByTestId("media-annotate"));
	drawStroke(screen.getByTestId("annotator-canvas"));

	fireEvent.click(screen.getByTestId("media-close"));
	fireEvent.click(screen.getByTestId("annotator-confirm-no"));
	expect(screen.getByTestId("image-annotator")).toBeTruthy();

	// 取消关窗意图：再走浮条「取消」并确认丢弃，只回普通预览，不关窗
	fireEvent.click(screen.getByTestId("annotator-cancel"));
	fireEvent.click(screen.getByTestId("annotator-confirm-yes"));
	expect(useSessionStore.getState().mediaPreview).not.toBeNull();
	expect(screen.getByTestId("zoomable-image")).toBeTruthy();
});

// ─── 尺寸预检（规格 §3.1 条件 4） ───

test("图片尺寸超限（naturalWidth 9000）→ 显示超限错误态、无画布与浮条，取消回普通预览", async () => {
	imageNatural = { w: 9000, h: 100 };
	openPreview([A, B], A.src);
	render(<MediaPreviewModal />);
	fireEvent.click(screen.getByTestId("media-annotate"));

	await waitFor(() =>
		expect(screen.getByTestId("annotator-too-large")).toBeTruthy(),
	);
	expect(screen.queryByTestId("annotator-canvas")).toBeNull();
	expect(screen.queryByTestId("annotator-bar")).toBeNull();

	fireEvent.click(screen.getByTestId("annotator-too-large-cancel"));
	expect(screen.queryByTestId("image-annotator")).toBeNull();
	expect(screen.getByTestId("zoomable-image")).toBeTruthy();
	expect(useSessionStore.getState().mediaPreview).not.toBeNull();
});

// ─── 保存接线 ───

test("保存成功：覆盖原图 → bump 版本号 → toast「已保存」→ 退出标注态", async () => {
	openPreview([A, B], A.src);
	render(<MediaPreviewModal />);
	fireEvent.click(screen.getByTestId("media-annotate"));
	// 零图形时保存按钮禁用（没有可导出的标注），先画一笔
	drawStroke(screen.getByTestId("annotator-canvas"));
	// 点击后保存链路在 await 后改状态：包在 act 里等微任务刷完，避免测试环境的调度延迟
	await act(async () => {
		fireEvent.click(screen.getByTestId("annotator-save"));
	});
	expect(screen.queryByTestId("image-annotator")).toBeNull();

	// 覆盖请求：POST /api/files/overwrite，multipart 字段 file + path
	expect(fetchCalls.length).toBe(1);
	expect(fetchCalls[0].url).toBe("/api/files/overwrite");
	expect(fetchCalls[0].init.method).toBe("POST");
	const form = fetchCalls[0].init.body as FormData;
	expect(form.get("path")).toBe(A.src);
	expect(form.get("file")).toBeInstanceOf(Blob);

	// mime 按扩展名映射（png）
	expect(exportedMime).toBe("image/png");
	// 版本号自增（任务 5 的预览/缩略图按它拼 URL 绕开缓存）
	expect(useImageRevisionStore.getState().revisions[A.src]).toBe(1);
	// 成功提示 + 回到普通预览
	expect(toastMessages()).toContain(i18n.t("blocks.imageAnnotator.saved"));
	expect(screen.getByTestId("zoomable-image")).toBeTruthy();
});

test("保存失败：toast「保存失败」并保留标注态，版本号不变", async () => {
	overwriteResult = () =>
		new Response(
			JSON.stringify({
				error: "仅允许覆盖项目 .wa-pi/uploads 内的文件",
				failure: { code: "fs.forbidden" },
			}),
			{ status: 403, headers: { "content-type": "application/json" } },
		);
	openPreview([A, B], A.src);
	render(<MediaPreviewModal />);
	fireEvent.click(screen.getByTestId("media-annotate"));
	drawStroke(screen.getByTestId("annotator-canvas"));
	await act(async () => {
		fireEvent.click(screen.getByTestId("annotator-save"));
	});
	expect(toastMessages()).toContain(i18n.t("blocks.imageAnnotator.saveFailed"));
	// 标注态保留，用户可重试
	expect(screen.getByTestId("image-annotator")).toBeTruthy();
	expect(useImageRevisionStore.getState().revisions[A.src]).toBeUndefined();
});

test("导出阶段失败（toBlob 返回 null）：toast「保存失败」并保留标注态，不发覆盖请求", async () => {
	// 导出就没成功：父组件拿不到 Blob，必须自己给提示（否则用户无限重试而无反馈）
	canvasProto.toBlob = (cb: (blob: Blob | null) => void) => cb(null);
	openPreview([A, B], A.src);
	render(<MediaPreviewModal />);
	fireEvent.click(screen.getByTestId("media-annotate"));
	drawStroke(screen.getByTestId("annotator-canvas"));

	await act(async () => {
		fireEvent.click(screen.getByTestId("annotator-save"));
	});
	expect(toastMessages()).toContain(i18n.t("blocks.imageAnnotator.saveFailed"));
	expect(fetchCalls.length).toBe(0);
	expect(screen.getByTestId("image-annotator")).toBeTruthy();
	// 可重试：保存按钮已复位（并未停在 saving）
	expect(
		(screen.getByTestId("annotator-save") as HTMLButtonElement).disabled,
	).toBe(false);
});

// ─── 保存中点 ✕：不记关窗意图 ───

test("保存中点 ✕ 不关窗；保存失败后取消丢弃也不会误关窗", async () => {
	// 覆盖写入挂起 → 标注器停在 saving 态（取消 / 关闭都被拒绝）
	let rejectOverwrite: ((e: unknown) => void) | null = null;
	overwriteResult = () =>
		new Promise<Response>((_resolve, reject) => {
			rejectOverwrite = reject;
		});

	openPreview([A, B], A.src);
	render(<MediaPreviewModal />);
	fireEvent.click(screen.getByTestId("media-annotate"));
	drawStroke(screen.getByTestId("annotator-canvas"));

	await act(async () => {
		fireEvent.click(screen.getByTestId("annotator-save"));
	});
	// 保存中：✕ 不关窗、也不弹丢弃确认（关窗请求被拒绝，不记意图）
	fireEvent.click(screen.getByTestId("media-close"));
	expect(screen.getByTestId("media-preview-modal")).toBeTruthy();
	expect(screen.queryByTestId("annotator-confirm")).toBeNull();

	// 保存失败 → 标注态保留，可重试
	await act(async () => {
		rejectOverwrite!(new Error("boom"));
	});
	expect(toastMessages()).toContain(i18n.t("blocks.imageAnnotator.saveFailed"));

	// 之后点浮条取消 + 确认丢弃：只回普通预览，不关窗（残留关窗意图会让这里误关）
	fireEvent.click(screen.getByTestId("annotator-cancel"));
	fireEvent.click(screen.getByTestId("annotator-confirm-yes"));
	expect(useSessionStore.getState().mediaPreview).not.toBeNull();
	expect(screen.getByTestId("zoomable-image")).toBeTruthy();
});

// ─── 入口来源：openFileOrPreview 的 annotatable 参数 ───

test("openFileOrPreview 传 annotatable 时把路径写进 mediaPreview.annotatablePath", () => {
	openFileOrPreview(A.src, "s1", { annotatable: true });
	expect(useSessionStore.getState().mediaPreview?.annotatablePath).toBe(A.src);

	openFileOrPreview(A.src, "s1");
	expect(
		useSessionStore.getState().mediaPreview?.annotatablePath,
	).toBeUndefined();
});
