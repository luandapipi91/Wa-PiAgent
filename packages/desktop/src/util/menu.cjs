// 托盘菜单模板（纯数据 + click 回调），可单测。
function buildTrayMenu(onOpen, onQuit) {
  return [
    { label: "打开 WA PI Agent", click: onOpen },
    { type: "separator" },
    { label: "退出", click: onQuit },
  ];
}

// 编辑菜单模板（数据共享：macOS 应用菜单与 Windows/Linux 隐藏菜单共用）。
// Windows/Linux 上编辑快捷键（Ctrl+Z / Ctrl+Shift+Z / Ctrl+X/C/V/A）依赖
// 应用菜单中带 role 的菜单项绑定到 webContents 命令，菜单置 null 会让
// 这些快捷键全部失效（输入框 Ctrl+Z 撤销无响应）。
function buildEditMenuTemplate() {
  return [
    {
      label: "编辑",
      submenu: [
        { label: "撤销", role: "undo" },
        { label: "重做", role: "redo" },
        { type: "separator" },
        { label: "剪切", role: "cut" },
        { label: "复制", role: "copy" },
        { label: "粘贴", role: "paste" },
        { label: "全选", role: "selectAll" },
      ],
    },
  ];
}

// macOS 应用菜单：中文 + 仅保留必要菜单（App、编辑、窗口）。
function buildAppMenuTemplate(appName) {
  return [
    {
      label: appName,
      submenu: [
        { label: `关于 ${appName}`, role: "about" },
        { type: "separator" },
        { label: `隐藏 ${appName}`, role: "hide" },
        { label: "隐藏其他", role: "hideOthers" },
        { label: "显示全部", role: "unhide" },
        { type: "separator" },
        { label: `退出 ${appName}`, role: "quit" },
      ],
    },
    ...buildEditMenuTemplate(),
    {
      label: "窗口",
      submenu: [
        { label: "最小化", role: "minimize" },
        { label: "关闭", role: "close" },
        { type: "separator" },
        { label: "前置全部窗口", role: "front" },
      ],
    },
  ];
}

module.exports = { buildTrayMenu, buildAppMenuTemplate, buildEditMenuTemplate };
