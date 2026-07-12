// 托盘菜单模板（纯数据 + click 回调），可单测。
function buildTrayMenu(onOpen, onQuit) {
  return [
    { label: "打开 HiAgent", click: onOpen },
    { type: "separator" },
    { label: "退出", click: onQuit },
  ];
}
module.exports = { buildTrayMenu };
