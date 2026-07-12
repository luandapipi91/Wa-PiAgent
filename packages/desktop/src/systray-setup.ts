// 托盘：菜单「打开 HiAgent / 退出」。systray2 helper 需在 ./traybin/（相对 CWD）可解析，
// 调用方需先把 helper 解压到 cacheDir/traybin/ 并 process.chdir(cacheDir)。
import * as ns from "systray2";
import { unwrapSysTray } from "./util/interop";

const SEPARATOR = { title: "<SEPARATOR>", tooltip: "", enabled: true };

export interface TrayHandle {
  kill(): Promise<void>;
}

export function startTray(opts: {
  iconPath: string;
  onOpen: () => void;
  onQuit: () => void;
}): Promise<TrayHandle> {
  const SysTray = unwrapSysTray(ns);
  return new Promise((resolve, reject) => {
    const tray = new SysTray({
      menu: {
        icon: opts.iconPath,
        title: "HiAgent",
        tooltip: "HiAgent",
        isTemplateIcon: process.platform === "darwin",
        items: [
          { title: "打开 HiAgent", tooltip: "打开", checked: false, enabled: true },
          SEPARATOR,
          { title: "退出", tooltip: "退出", checked: false, enabled: true },
        ],
      },
      debug: false,
      copyDir: false,
    });
    tray.ready().then(() => {
      tray.onClick((action: any) => {
        const title = action?.item?.title;
        if (title === "打开 HiAgent") opts.onOpen();
        else if (title === "退出") opts.onQuit();
      });
      resolve({ kill: () => tray.kill(false) });
    }).catch(reject);
  });
}
