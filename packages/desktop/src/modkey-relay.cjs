// 预览「选择元素」快捷键的单点监听接线：
// webContents.before-input-event 工作在 Chromium 输入层，先于事件派发给窗口内
// 任何 frame（含 iframe 内焦点）——这是唯一能同时覆盖「焦点在主应用」与「焦点在
// 预览 iframe」的单一监听点。判定命中（Ctrl/Meta 单按松开）后经 IPC 单向通知
// 渲染进程，由前端 postMessage 下发 iframe 切换拾取开关。纯观察，不 preventDefault。
const { createModKeyTracker } = require("./modkey-tracker.cjs");

/** IPC 频道名（preload.cjs 的 waPiModKey.onTapModKey 对应监听它） */
const MODKEY_CHANNEL = "wa-pi:modkey-tap";

/** @param {import("electron").WebContents} webContents 主窗口 / 浮动预览窗均可 */
function wireModKeyRelay(webContents) {
	const tracker = createModKeyTracker();
	webContents.on("before-input-event", (_event, input) => {
		if (tracker.feed(input)) {
			webContents.send(MODKEY_CHANNEL);
		}
	});
}

module.exports = { wireModKeyRelay, MODKEY_CHANNEL };
