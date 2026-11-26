// openFileOrPreview 统一分发测试：html → browser store（BrowserPanel），非 html → session store（文件预览）
import { test, expect, beforeEach } from "bun:test";
import { useBrowserStore } from "../src/store/browser";
import { useSessionStore } from "../src/store/session";
import { openFileOrPreview } from "../src/open-file-preview";

beforeEach(() => {
	useBrowserStore.setState({ open: false, path: null, sessionId: null });
	useSessionStore.setState({ filePreview: null, mediaPreview: null });
});

test("html 文件 → 打开 BrowserPanel（browser store），不打开文件预览", () => {
	openFileOrPreview("/work/demo/dist/index.html", "s1");
	expect(useBrowserStore.getState().open).toBe(true);
	expect(useBrowserStore.getState().path).toBe("/work/demo/dist/index.html");
	expect(useBrowserStore.getState().sessionId).toBe("s1");
	expect(useSessionStore.getState().filePreview).toBeNull();
});

test("非 html 文件 → 打开内置文件预览器（session store）", () => {
	openFileOrPreview("/work/demo/src/index.ts", "s1");
	expect(useBrowserStore.getState().open).toBe(false);
	expect(useSessionStore.getState().filePreview).toEqual({
		path: "/work/demo/src/index.ts",
		sessionId: "s1",
	});
});

test("htm 扩展名同样走浏览器预览", () => {
	openFileOrPreview("/work/demo/page.htm", "s2");
	expect(useBrowserStore.getState().open).toBe(true);
	expect(useSessionStore.getState().filePreview).toBeNull();
});

test("大写 .HTML 扩展名同样走浏览器预览", () => {
	openFileOrPreview("/work/demo/DIST/INDEX.HTML", "s1");
	expect(useBrowserStore.getState().open).toBe(true);
	expect(useSessionStore.getState().filePreview).toBeNull();
});

// 图片/视频走媒体画廊：与消息里的图片同一个窗（自带同目录缩略图条与左右切换），
// 而不是文件预览窗的图片分支（后者保留作兜底，如 markdown 链接直接打开图片）。

test("图片文件 → 打开媒体画廊（不进文件预览窗）", () => {
	openFileOrPreview("/work/demo/pics/cat.png", "s1");
	expect(useSessionStore.getState().filePreview).toBeNull();
	const mp = useSessionStore.getState().mediaPreview!;
	expect(mp.items).toEqual([
		{ src: "/work/demo/pics/cat.png", kind: "image", name: "cat.png" },
	]);
	expect(mp.index).toBe(0);
	expect(mp.sessionId).toBe("s1");
});

test("文件树双击 uploads 下的图片 → 同样带上标注入口（不必从附件缩略图进）", () => {
	const win = "H:/work/demo/.wa-pi/uploads/shot.png";
	openFileOrPreview(win, "s1");
	expect(useSessionStore.getState().mediaPreview!.annotatablePath).toBe(win);
});

test("项目内非 uploads 的图片 → 同样带标注入口（已放开目录限制）", () => {
	openFileOrPreview("/work/demo/pics/cat.png", "s1");
	expect(useSessionStore.getState().mediaPreview!.annotatablePath).toBe(
		"/work/demo/pics/cat.png",
	);
});

test("uploads 下但扩展名不在白名单（gif）→ 不带标注入口", () => {
	openFileOrPreview("/work/demo/.wa-pi/uploads/anim.gif", "s1");
	expect(useSessionStore.getState().mediaPreview!.annotatablePath).toBeUndefined();
});

test("edit:true（上传后点缩略图）→ 打开即进标注态", () => {
	openFileOrPreview("/work/demo/.wa-pi/uploads/shot.png", "s1", {
		annotatable: true,
		edit: true,
	});
	const mp = useSessionStore.getState().mediaPreview!;
	expect(mp.annotatablePath).toBe("/work/demo/.wa-pi/uploads/shot.png");
	expect(mp.autoAnnotate).toBe(true);
});

test("不带 edit → 只打开预览，不自动进标注态", () => {
	openFileOrPreview("/work/demo/.wa-pi/uploads/shot.png", "s1", {
		annotatable: true,
	});
	expect(useSessionStore.getState().mediaPreview!.autoAnnotate).toBe(false);
});

test("edit:true 但扩展名不支持（gif）→ 也不自动进标注态", () => {
	openFileOrPreview("/work/demo/.wa-pi/uploads/anim.gif", "s1", { edit: true });
	const mp = useSessionStore.getState().mediaPreview!;
	expect(mp.annotatablePath).toBeUndefined();
	expect(mp.autoAnnotate).toBe(false);
});

test("显式 annotatable:false → 保留调用方关掉入口的能力", () => {
	openFileOrPreview("/work/demo/.wa-pi/uploads/shot.png", "s1", {
		annotatable: false,
	});
	expect(useSessionStore.getState().mediaPreview!.annotatablePath).toBeUndefined();
});

test("视频文件 → 打开媒体画廊（kind=video，播放交给画廊）", () => {
	openFileOrPreview("/work/demo/pics/clip.mp4", "s1");
	expect(useSessionStore.getState().filePreview).toBeNull();
	expect(useSessionStore.getState().mediaPreview!.items).toEqual([
		{ src: "/work/demo/pics/clip.mp4", kind: "video", name: "clip.mp4" },
	]);
});

test("大写图片扩展名 .PNG 同样走媒体画廊", () => {
	openFileOrPreview("C:\\work\\demo\\PIC.PNG", "s1");
	expect(useSessionStore.getState().filePreview).toBeNull();
	expect(useSessionStore.getState().mediaPreview!.items[0]).toEqual({
		src: "C:\\work\\demo\\PIC.PNG",
		kind: "image",
		name: "PIC.PNG",
	});
});

test("html 优先：图片扩展名之外的 html 仍走浏览器预览", () => {
	openFileOrPreview("/work/demo/pics/page.html", "s1");
	expect(useBrowserStore.getState().open).toBe(true);
	expect(useSessionStore.getState().mediaPreview).toBeNull();
});

test("非媒体文件不受影响：仍走内置文件预览", () => {
	openFileOrPreview("/work/demo/notes.md", "s1");
	expect(useSessionStore.getState().mediaPreview).toBeNull();
	expect(useSessionStore.getState().filePreview).toMatchObject({
		path: "/work/demo/notes.md",
		sessionId: "s1",
	});
});

// 同值短路场景：store 不产生变更 → driver effect 不触发 → 主进程收不到 open，
// 窗口若被隐藏（如主窗口收起到托盘时连带 hide）就永远唤不回（2026-11-26 修）。此时
// 直接发 restore 指令唤回窗口，不经 store（不破回环闸）；无桥（web）时 Modal 本就
// 显示该文件，跳过即可。
const previewBridgeCalls = () => {
	const calls: unknown[] = [];
	(window as any).waPiFilePreviewWin = { cmd: (p: unknown) => calls.push(p) };
	return calls;
};

test("同值双击（store 短路场景）→ 有桥时发 restore 指令唤回窗口，不产生状态变更", () => {
	const calls = previewBridgeCalls();
	useSessionStore.setState({
		filePreview: { path: "/work/demo/src/index.ts", sessionId: "s1" },
	});
	openFileOrPreview("/work/demo/src/index.ts", "s1");
	expect(calls).toEqual([{ type: "restore" }]);
	expect(useSessionStore.getState().filePreview).toEqual({
		path: "/work/demo/src/index.ts",
		sessionId: "s1",
	});
	delete (window as any).waPiFilePreviewWin;
});

test("同值双击但无桥（web）→ 不发指令，不产生状态变更（Modal 已显示该文件）", () => {
	delete (window as any).waPiFilePreviewWin;
	useSessionStore.setState({
		filePreview: { path: "/work/demo/src/index.ts", sessionId: "s1" },
	});
	openFileOrPreview("/work/demo/src/index.ts", "s1");
	expect(useSessionStore.getState().filePreview).toEqual({
		path: "/work/demo/src/index.ts",
		sessionId: "s1",
	});
});

test("同路径但不同会话 → 不算同值，仍走 store 更新（不误发 restore）", () => {
	const calls = previewBridgeCalls();
	useSessionStore.setState({
		filePreview: { path: "/work/demo/src/index.ts", sessionId: "s1" },
	});
	openFileOrPreview("/work/demo/src/index.ts", "s2");
	expect(calls).toEqual([]);
	expect(useSessionStore.getState().filePreview).toEqual({
		path: "/work/demo/src/index.ts",
		sessionId: "s2",
	});
	delete (window as any).waPiFilePreviewWin;
});
