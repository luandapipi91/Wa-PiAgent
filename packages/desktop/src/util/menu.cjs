// 托盘菜单模板（纯数据 + click 回调），可单测。
function buildTrayMenu(onOpen, onQuit) {
  return [
    { label: "打开 HiAgent", click: onOpen },
    { type: "separator" },
    { label: "退出", click: onQuit },
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

module.exports = { buildTrayMenu, buildAppMenuTemplate };
