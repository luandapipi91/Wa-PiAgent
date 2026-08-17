// 原生文件对话框与 shell 定位能力：附件选文件 / 技能目录选择 / 打开技能文件夹。
// 依赖注入 mock electron 的 dialog/shell/ipcMain/BrowserWindow，验证 IPC 注册与返回契约。
import { test, expect } from "bun:test";
import { setupNativeDialogs } from "../src/util/native-dialogs.cjs";

type ShowOpenDialogResult = { canceled: boolean; filePaths: string[] };

function makeHarness(showOpenDialogResult?: ShowOpenDialogResult) {
	const handlers = new Map<string, (...args: any[]) => any>();
	const calls: Array<[string, any]> = [];

	const dialog = {
		showOpenDialog: async (win: any, opts: any) => {
			calls.push(["showOpenDialog", { win, properties: opts.properties }]);
			return showOpenDialogResult ?? { canceled: true, filePaths: [] };
		},
	};
	const shell = {
		showItemInFolder: (p: string) => {
			calls.push(["showItemInFolder", p]);
		},
	};
	const ipcMain = {
		handle: (name: string, fn: (...args: any[]) => any) => {
			handlers.set(name, fn);
		},
	};
	const BrowserWindow = {
		fromWebContents: (wc: any) => ({ fromWebContents: wc }),
	};

	setupNativeDialogs({ dialog, shell, ipcMain, BrowserWindow });
	return { handlers, calls };
}

const SENDER = { sender: { id: 1 } };

test("注册三个 IPC handler", () => {
	const { handlers } = makeHarness();
	expect([...handlers.keys()].sort()).toEqual([
		"dialog:open-directory",
		"dialog:open-files",
		"shell:show-item-in-folder",
	]);
});

test("dialog:open-files 取消返回空数组", async () => {
	const { handlers } = makeHarness();
	const result = await handlers.get("dialog:open-files")!(SENDER);
	expect(result).toEqual([]);
});

test("dialog:open-files 选择后返回文件路径数组", async () => {
	const { handlers } = makeHarness({
		canceled: false,
		filePaths: ["/a.txt", "/b.txt"],
	});
	const result = await handlers.get("dialog:open-files")!(SENDER);
	expect(result).toEqual(["/a.txt", "/b.txt"]);
});

test("dialog:open-files 使用 openFile + multiSelections 属性", async () => {
	const { handlers, calls } = makeHarness();
	await handlers.get("dialog:open-files")!(SENDER);
	const props = calls.find((c) => c[0] === "showOpenDialog")![1].properties;
	expect(props).toContain("openFile");
	expect(props).toContain("multiSelections");
	expect(props).not.toContain("openDirectory");
});

test("dialog:open-directory 取消返回 null", async () => {
	const { handlers } = makeHarness();
	const result = await handlers.get("dialog:open-directory")!(SENDER);
	expect(result).toBeNull();
});

test("dialog:open-directory 选择后返回目录路径", async () => {
	const { handlers } = makeHarness({
		canceled: false,
		filePaths: ["/home/co/skills"],
	});
	const result = await handlers.get("dialog:open-directory")!(SENDER);
	expect(result).toBe("/home/co/skills");
});

test("dialog:open-directory 使用 openDirectory 属性", async () => {
	const { handlers, calls } = makeHarness();
	await handlers.get("dialog:open-directory")!(SENDER);
	const props = calls.find((c) => c[0] === "showOpenDialog")![1].properties;
	expect(props).toContain("openDirectory");
	expect(props).not.toContain("openFile");
});

test("shell:show-item-in-folder 定位有效路径并返回 true", () => {
	const { handlers, calls } = makeHarness();
	const result = handlers.get("shell:show-item-in-folder")!(
		{},
		"/home/co/skills",
	);
	expect(result).toBe(true);
	expect(calls.find((c) => c[0] === "showItemInFolder")![1]).toBe(
		"/home/co/skills",
	);
});

test("shell:show-item-in-folder 忽略空/非字符串路径", () => {
	const { handlers, calls } = makeHarness();
	const fn = handlers.get("shell:show-item-in-folder")!;
	expect(fn({}, "")).toBe(false);
	expect(fn({}, null)).toBe(false);
	expect(fn({}, 123)).toBe(false);
	expect(fn({}, "   ")).toBe(false);
	expect(calls.some((c) => c[0] === "showItemInFolder")).toBe(false);
});
