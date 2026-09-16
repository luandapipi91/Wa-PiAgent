// 原生文件对话框与 shell 定位能力：
// - dialog:open-files         附件「选择要发送的文件」→ 系统多选文件对话框
// - dialog:open-directory     技能「添加目录」→ 系统选目录对话框
// - shell:show-item-in-folder 技能「打开技能文件夹」→ 系统文件管理器定位
// dialog/shell/ipcMain/BrowserWindow 由调用方注入（解耦 Electron，便于单测）。
function setupNativeDialogs({ dialog, shell, ipcMain, BrowserWindow }) {
	ipcMain.handle("dialog:open-files", async (event) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		const result = await dialog.showOpenDialog(win, {
			properties: ["openFile", "multiSelections"],
		});
		return result.canceled ? [] : result.filePaths;
	});

	ipcMain.handle("dialog:open-directory", async (event) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		const result = await dialog.showOpenDialog(win, {
			properties: ["openDirectory", "createDirectory"],
		});
		return result.canceled ? null : result.filePaths[0];
	});

	ipcMain.handle("shell:show-item-in-folder", (_event, filePath) => {
		if (typeof filePath === "string" && filePath.trim()) {
			shell.showItemInFolder(filePath);
			return true;
		}
		return false;
	});
}

module.exports = { setupNativeDialogs };
