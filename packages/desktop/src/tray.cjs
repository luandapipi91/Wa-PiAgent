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
  // macOS 菜单栏图标固定为 18x18pt，并生成 1x/2x 表示保证 retina 清晰
  if (process.platform === "darwin" && !image.isEmpty()) {
    const size = { width: 18, height: 18 };
    const image1x = image.resize({ ...size, quality: "best" });
    const image2x = image.resize({ width: size.width * 2, height: size.height * 2, quality: "best" });
    const composite = nativeImage.createEmpty();
    composite.addRepresentation({ ...size, scaleFactor: 1, buffer: image1x.toPNG() });
    composite.addRepresentation({ ...size, scaleFactor: 2, buffer: image2x.toPNG() });
    image = composite;
  }
  tray = new Tray(image);
  tray.setToolTip("HiAgent");
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenu(onOpen, onQuit)));
  // 左键单击 = 打开
  tray.on("click", onOpen);
  return tray;
}
module.exports = { startTray };
