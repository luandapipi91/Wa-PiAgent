// FileViewer 组件测试：文本高亮渲染、图片 data URI、unsupported、loading、error 态、关闭回调。
// 头部分享按钮（ShareButton）依赖 share-client，整模块 mock（bun mock.module 路径须与组件 import 一致）。
import { test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";

const shareSettingsMock = mock(async () => ({
	token: "edgeone-token",
	channel: "edgeone",
}));
const shareUploadMock = mock(async () => ({}));

mock.module("../src/share-client", () => ({
	shareSettings: shareSettingsMock,
	shareUpload: shareUploadMock,
	saveShareSettings: async () => {},
}));
import {
	render,
	screen,
	fireEvent,
	waitFor,
	cleanup,
} from "@testing-library/react";
import { FileViewer } from "../src/components/blocks/FileViewer";
import { _setFsTransport } from "../src/fs-client";
import { makeFakeFsTransport } from "./fs-transport";
import { useSessionStore } from "../src/store/session";
import { useToastStore } from "../src/store/toast";

const fake = makeFakeFsTransport();

beforeEach(() => {
	_setFsTransport(fake.transport);
	fake.calls.length = 0;
	fake.sent.length = 0;
	fake.responses.clear();
	useToastStore.setState({ toasts: [] });
});
afterEach(() => cleanup());

test("文本文件：加载后渲染 base64 解码内容 + 文件名", async () => {
	fake.setResponse("fs:readFile", {
		content: btoa("hello world"),
		mimeType: "text/plain",
	});
	const onClose = () => {};
	render(<FileViewer path="/work/demo/index.ts" onClose={onClose} />);

	await waitFor(() =>
		expect(screen.getByTestId("file-viewer").textContent).toContain(
			"hello world",
		),
	);
	expect(screen.getByTestId("file-viewer").textContent).toContain("index.ts");
	// 非 md 路径必须走 Prism 行号分支：行号容器存在（防止未来误把非 md 也切到 md 分支）
	expect(
		screen.getByTestId("file-viewer").querySelector("[data-line]"),
	).not.toBeNull();
});

test("图片文件：拼成 data URI 渲染到 <img>", async () => {
	const b64 = "iVBORw0KGgo="; // 任意合法 base64 片段
	fake.setResponse("fs:readFile", { content: b64, mimeType: "image/png" });
	render(<FileViewer path="/work/demo/logo.png" onClose={() => {}} />);

	await waitFor(() => expect(screen.getByTestId("image-viewer")).toBeTruthy());
	const img = screen.getByAltText("logo.png") as HTMLImageElement;
	expect(img.src).toBe(`data:image/png;base64,${b64}`);
});

test("unsupported 文件：显示不支持占位", async () => {
	// fs-client.readFile 依赖 type === "fs:unsupported" 分支判定，必须带 type 字段
	fake.setResponse("fs:readFile", {
		type: "fs:unsupported",
		reason: "不支持的文件类型: application/zip",
	});
	render(<FileViewer path="/work/demo/a.zip" onClose={() => {}} />);

	await waitFor(() =>
		expect(screen.getByTestId("fv-unsupported").textContent).toContain(
			"不支持预览该文件",
		),
	);
});

test("unsupported 文件：显示在文件管理器中打开按钮，点击调用 revealFile", async () => {
	fake.setResponse("fs:readFile", {
		type: "fs:unsupported",
		reason: "不支持的文件类型: application/zip",
	});
	render(<FileViewer path="/work/demo/a.zip" onClose={() => {}} />);
	await waitFor(() =>
		expect(screen.getByTestId("fv-unsupported").textContent).toContain(
			"不支持预览该文件",
		),
	);

	// 按钮文案随平台变化（测试环境 happy-dom UA 含 Win → 在资源管理器中打开）；
	// 用 testId 定位避免绑定具体平台文案
	const btn = screen.getByTestId("fv-reveal");
	// 空状态页操作按钮统一无边框幽灵风格（fv-empty-btn）
	expect(btn.className).toContain("fv-empty-btn");
	fireEvent.click(btn);

	const call = fake.calls.find((c) => c.path === "/api/fs/reveal-file");
	expect(call).toBeTruthy();
	expect((call!.body as { path: string }).path).toBe("/work/demo/a.zip");
});

test("unsupported 文件：显示默认方式打开按钮，点击调用 openFileWithDefaultApp", async () => {
	fake.setResponse("fs:readFile", {
		type: "fs:unsupported",
		reason: "不支持的文件类型: application/zip",
	});
	render(<FileViewer path="/work/demo/a.zip" onClose={() => {}} />);
	await waitFor(() =>
		expect(screen.getByTestId("fv-unsupported").textContent).toContain(
			"不支持预览该文件",
		),
	);

	const btn = screen.getByTestId("fv-open-default");
	expect(btn.className).toContain("fv-empty-btn");
	fireEvent.click(btn);

	const call = fake.calls.find(
		(c) => c.path === "/api/fs/open-with-default-app",
	);
	expect(call).toBeTruthy();
	expect((call!.body as { path: string }).path).toBe("/work/demo/a.zip");
});

test("读取失败：显示错误态 + 关闭按钮", async () => {
	// 让 readFile 抛错：transport.post 返回空对象 → readFile 因 !res.content throw
	fake.setResponse("fs:readFile", {});
	render(<FileViewer path="/work/demo/x.txt" onClose={() => {}} />);

	await waitFor(() =>
		expect(screen.getByTestId("fv-error").textContent).toContain(
			"无法读取文件",
		),
	);
});

test("点击关闭按钮触发 onClose", async () => {
	fake.setResponse("fs:readFile", {
		content: btoa("x"),
		mimeType: "text/plain",
	});
	let closed = false;
	render(
		<FileViewer
			path="/work/demo/a.txt"
			onClose={() => {
				closed = true;
			}}
		/>,
	);

	await waitFor(() => expect(screen.getByTestId("file-viewer")).toBeTruthy());
	fireEvent.click(screen.getByTitle("关闭"));
	expect(closed).toBe(true);
});

// ===== md 预览渲染 =====

const MD_SAMPLE = `# Preview Title

| ColA | ColB |
|------|------|
| 1    | 2    |

\`\`\`ts
const x = 1;
\`\`\`

\`\`\`mermaid
graph TD
  A[Start] --> B[End]
\`\`\`
`;

test("md 文件：渲染为 markdown（h1/table/pre），不出现 Prism 行号容器", async () => {
	fake.setResponse("fs:readFile", {
		content: btoa(MD_SAMPLE),
		mimeType: "text/markdown",
	});
	render(<FileViewer path="/work/demo/README.md" onClose={() => {}} />);

	await waitFor(() => expect(screen.getByTestId("text-block")).toBeTruthy());
	const textBlock = screen.getByTestId("text-block");
	expect(textBlock.querySelector("h1")?.textContent).toBe("Preview Title");
	expect(textBlock.querySelector("table")).toBeTruthy();
	expect(textBlock.querySelector("pre")).toBeTruthy();
	// md 渲染不走 FileViewer 的 Prism 分支：不出现行号容器
	expect(
		screen.getByTestId("file-viewer").querySelector("[data-line]"),
	).toBeNull();
	// mermaid 代码块走 MermaidBlock 渲染（异步 debounce → mermaid.render）
	// 实测 happy-dom 下 mermaid.render 的 promise 既不 resolve 也不 reject，组件停留在
	// mermaid-loading 态（渲染链路本身正常，是测试环境限制）。故断言任一 mermaid 容器
	// （loading/svg/error）出现，证明该代码块走了 MermaidBlock 分支即可。
	await waitFor(
		() => {
			const fv = screen.getByTestId("file-viewer");
			const mermaidEl = fv.querySelector(
				"[data-testid='mermaid-loading'], [data-testid='mermaid-svg'], [data-testid='mermaid-error']",
			);
			expect(mermaidEl).not.toBeNull();
		},
		{ timeout: 5000 },
	);
});

test("md 文件：内联路径复用聊天区渲染为文件胶囊", async () => {
	fake.setResponse("fs:readFile", {
		content: btoa("# T\n\n`docs/a.md`\n"),
		mimeType: "text/markdown",
	});
	fake.setResponse("fs:stat", { exists: true });
	render(
		<FileViewer
			path="/work/demo/README.md"
			onClose={() => {}}
			sessionId="s1"
		/>,
	);

	await waitFor(() => expect(screen.getByTestId("file-pill")).toBeTruthy());
});

// ===== md 原始 HTML 渲染（rehype-raw）=====

const MD_WITH_HTML = `# HTML 渲染测试

<div align="center">
<img src="assets/pic.png" alt="测试图" width="96" />
</div>

段落 <br/> 换行
`;

test("md 文件：原始 HTML（div/img/br）渲染为真实标签，相对路径图片经 fs-client 读成 data URI", async () => {
	const htmlFake = makeFakeFsTransport((evt) => {
		if (evt.type === "fs:readFile") {
			if (evt.path === "/work/demo/README.md") {
				return {
					content: Buffer.from(MD_WITH_HTML, "utf-8").toString("base64"),
					mimeType: "text/markdown",
				};
			}
			if (evt.path === "/work/demo/assets/pic.png") {
				return { content: btoa("fake-png"), mimeType: "image/png" };
			}
		}
		return undefined;
	});
	_setFsTransport(htmlFake.transport);
	render(<FileViewer path="/work/demo/README.md" onClose={() => {}} />);

	await waitFor(() => expect(screen.getByTestId("text-block")).toBeTruthy());
	const tb = screen.getByTestId("text-block");
	// div/br 渲染为真实标签（不再是转义文本）
	expect(tb.querySelector("div[align='center']")).toBeTruthy();
	expect(tb.querySelector("br")).toBeTruthy();
	// 不应出现转义后的 HTML 文本
	expect(tb.textContent).not.toContain("&lt;div");
	// img 渲染且相对路径被解析成 data URI（经 fs-client 按文件目录读取）
	await waitFor(() => {
		const img = tb.querySelector("img");
		expect(img).toBeTruthy();
		expect(img?.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
		expect(img?.getAttribute("alt")).toBe("测试图");
		// width 透传：README 里 <img width="96"> 的尺寸不能丢
		expect(img?.getAttribute("width")).toBe("96");
	});
	// 相对路径基于预览文件目录解析（/work/demo/ + assets/pic.png）
	const readCall = htmlFake.calls.find(
		(c) =>
			c.type === "fs:readFile" &&
			(c.body as any)?.path?.includes("assets/pic.png"),
	);
	expect(readCall).toBeTruthy();
});

test("md 链接：相对路径点击在预览器内打开、外部链接 target=_blank", async () => {
	fake.setResponse("fs:readFile", {
		content: Buffer.from(
			"[文档](./docs/intro.md)\n\n[外部](https://example.com)",
			"utf-8",
		).toString("base64"),
		mimeType: "text/markdown",
	});
	const openSpy = spyOn(
		useSessionStore.getState(),
		"openFilePreview",
	).mockImplementation(() => {});
	render(
		<FileViewer
			path="/work/demo/README.md"
			sessionId="s1"
			onClose={() => {}}
		/>,
	);

	await waitFor(() => expect(screen.getByText("文档")).toBeTruthy());

	// 相对路径链接：点击触发 openFilePreview（解析为基于预览文件目录的绝对路径）
	fireEvent.click(screen.getByText("文档"));
	expect(openSpy).toHaveBeenCalledWith("/work/demo/docs/intro.md", "s1");

	// 外部链接：target=_blank（交给 setWindowOpenHandler 内置窗口打开）
	const externalLink = screen.getByText("外部");
	expect(externalLink.getAttribute("target")).toBe("_blank");

	openSpy.mockRestore();
});

test("底部地址栏：代码预览点击复制按钮复制文件路径", async () => {
	let copied = "";
	Object.defineProperty(navigator, "clipboard", {
		value: {
			writeText: async (t: string) => {
				copied = t;
			},
		},
		configurable: true,
	});
	fake.setResponse("fs:readFile", {
		content: btoa("hello"),
		mimeType: "text/plain",
	});
	render(<FileViewer path="/work/demo/index.ts" onClose={() => {}} />);
	await waitFor(() =>
		expect(screen.getByTestId("file-viewer").textContent).toContain("hello"),
	);
	fireEvent.click(screen.getByTestId("fv-copy-path"));
	await waitFor(() => expect(copied).toBe("/work/demo/index.ts"));
});

test("底部地址栏：unsupported 预览也有复制路径按钮", async () => {
	fake.setResponse("fs:readFile", {
		type: "fs:unsupported",
		reason: "不支持的文件类型: application/zip",
	});
	render(<FileViewer path="/work/demo/a.zip" onClose={() => {}} />);
	await waitFor(() =>
		expect(screen.getByTestId("fv-unsupported").textContent).toContain(
			"不支持预览该文件",
		),
	);
	expect(screen.getByTestId("fv-copy-path")).toBeTruthy();
});

// ===== 头部分享按钮 =====

test("md 预览头部：出现分享按钮 share-file-btn", async () => {
	fake.setResponse("fs:readFile", {
		content: btoa("# T\n"),
		mimeType: "text/markdown",
	});
	render(<FileViewer path="/work/demo/README.md" onClose={() => {}} />);
	await waitFor(() => expect(screen.getByTestId("text-block")).toBeTruthy());
	expect(screen.getByTestId("share-file-btn")).toBeTruthy();
});

test("代码预览头部：出现分享按钮 share-file-btn", async () => {
	fake.setResponse("fs:readFile", {
		content: btoa("const a = 1;"),
		mimeType: "text/plain",
	});
	render(<FileViewer path="/work/demo/index.ts" onClose={() => {}} />);
	await waitFor(() => expect(screen.getByTestId("file-viewer")).toBeTruthy());
	expect(screen.getByTestId("share-file-btn")).toBeTruthy();
});

test("点击分享按钮：打开分享弹层（share-result-modal）", async () => {
	fake.setResponse("fs:readFile", {
		content: btoa("# T\n"),
		mimeType: "text/markdown",
	});
	render(
		<FileViewer path="/work/demo/README.md" onClose={() => {}} sessionId="s1" />,
	);
	await waitFor(() => expect(screen.getByTestId("text-block")).toBeTruthy());
	fireEvent.click(screen.getByTestId("share-file-btn"));
	await waitFor(() =>
		expect(screen.getByTestId("share-result-modal")).toBeTruthy(),
	);
	// 弹层内展示待分享文件（README.md 文件名）
	expect(screen.getByTestId("share-files")).toBeTruthy();
});
