// 主窗口状态持久化（位置/大小/最大化）：文件读写与恢复前的屏内校验。
// 背景：更新重启（quitAndInstall → 安装器拉起新壳）与彻底退出再打开是进程真实退出的
// 少数场景；主窗口此前无持久化，重启后必回硬编码默认值（用户报告：更新后窗口状态丢失）。
// 依赖全部经参数注入（不 require electron），便于单测——风格同 pet-window.cjs。
const fs = require("node:fs");
const path = require("node:path");

/**
 * 创建窗口状态存取器：userData/window_state.json 的读写。
 * read()：文件不存在 / 非法 JSON / 读盘失败 → null（由调用方回退默认值），不抛异常。
 */
function createWindowStateStore(filePath) {
	return {
		read() {
			try {
				const raw = fs.readFileSync(filePath, "utf8");
				const parsed = JSON.parse(raw);
				if (!parsed || typeof parsed !== "object") return null;
				return parsed;
			} catch {
				return null;
			}
		},
		write(state) {
			try {
				fs.mkdirSync(path.dirname(filePath), { recursive: true });
				fs.writeFileSync(filePath, JSON.stringify(state));
			} catch {
				// 落盘失败只影响下次恢复，不打断当前退出/关闭流程
			}
		},
	};
}

/**
 * 校验并规范化持久化的窗口状态，非法或完全跑出屏幕的返回 null（调用方回退默认值）。
 * - raw：read() 的结果，可为 null
 * - displays：screen.getAllDisplays() 的结果（[{ bounds: {x,y,width,height} }]）；
 *   拿不到显示器列表（undefined / 空数组）时只做形状校验，不误杀。
 * 返回 { x, y, width, height, maximized } 或 null。
 */
function sanitizeWindowState(raw, displays) {
	if (!raw || typeof raw !== "object") return null;
	// 严格校验：状态只由我们自己写入数字；类型不符视为损坏，回退默认值
	const x = raw.x;
	const y = raw.y;
	const width = raw.width;
	const height = raw.height;
	if (
		typeof x !== "number" ||
		typeof y !== "number" ||
		typeof width !== "number" ||
		typeof height !== "number" ||
		!Number.isFinite(x) ||
		!Number.isFinite(y) ||
		!Number.isFinite(width) ||
		!Number.isFinite(height) ||
		width <= 0 ||
		height <= 0
	) {
		return null;
	}
	// 有显示器列表时要求窗口至少有一角落在某块屏内（允许有意拖出边缘的部分越界）；
	// 完全在屏外（如拔掉副屏后的残留坐标）视为无效
	if (Array.isArray(displays) && displays.length > 0) {
		const visible = displays.some((d) => {
			const b = d && d.bounds;
			if (!b) return false;
			return (
				x < b.x + b.width &&
				x + width > b.x &&
				y < b.y + b.height &&
				y + height > b.y
			);
		});
		if (!visible) return null;
	}
	return { x, y, width, height, maximized: Boolean(raw.maximized) };
}

module.exports = { createWindowStateStore, sanitizeWindowState };
