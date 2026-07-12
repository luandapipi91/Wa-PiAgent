// Electron Tray + Menu（替 systray2）。「打开」focus 既有窗口。
const { Tray, Menu, nativeImage } = require("electron");
const path = require("node:path");
const { buildTrayMenu } = require("./util/menu.cjs");

let tray = null;
function startTray({ iconPath, onOpen, onQuit }) {
  // icon 缺省用 1x1 nativeImage 占位（Task 6 换真青蛙 ico）
  let image;
  try { image = nativeImage.createFromPath(iconPath); } catch { image = nativeImage.createEmpty(); }
  if (image.isEmpty()) image = nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip("HiAgent");
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenu(onOpen, onQuit)));
  // 左键单击 = 打开
  tray.on("click", onOpen);
  return tray;
}
module.exports = { startTray };
