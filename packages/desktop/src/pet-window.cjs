// 桌面宠物窗口（呱呱）的 Electron 侧实现：显示器信息转换、配置持久化、建窗/销窗与 IPC。
// 画面本体是 src/assets/pet.html（单文件零依赖，由交付件移植而来）。
// 依赖全部经参数注入（BrowserWindow/ipcMain/screen/log/...），便于单测——风格同 util/native-dialogs.cjs。
const path = require("node:path");
const fs = require("node:fs");

/** 宠物窗口基准尺寸（与 pet.html 的 BASE_W / BASE_H 一致） */
const PET_BASE_W = 260;
const PET_BASE_H = 258;
/** 配置写盘节流：页面溜达时会持续移动窗口，按调用频率直写会高频落盘 */
const CONFIG_WRITE_MS = 1000;

/** Electron 矩形（{x,y,width,height}）→ 页面用的 {l,t,r,b}（等价 Qt 的虚拟屏矩形） */
function rectOf(src) {
	const x = Math.round(Number(src && src.x) || 0);
	const y = Math.round(Number(src && src.y) || 0);
	const w = Math.round(Number(src && src.width) || 0);
	const h = Math.round(Number(src && src.height) || 0);
	return { l: x, t: y, r: x + w, b: y + h };
}

/**
 * 显示器列表 → 页面需要的 { virt, screens }
 *  - virt：各屏 bounds 的并集，作为拖拽/溜达的边界（等价 Qt virtualGeometry）
 *  - screens：各屏 workArea 转 {l,t,r,b}（避开任务栏/Dock）
 * 拿不到显示器时回落到固定虚拟屏，页面照常工作（只在浏览器预览模式下才会走到）。
 */
function collectScreens(displays) {
	const list = Array.isArray(displays) ? displays : [];
	if (!list.length) {
		const fallback = { l: 0, t: 0, r: 1920, b: 1040 };
		return { virt: fallback, screens: [fallback] };
	}
	const bounds = list.map((d) => rectOf(d && d.bounds));
	const works = list.map((d) => rectOf(d && d.workArea));
	const virt = {
		l: Math.min(...bounds.map((r) => r.l)),
		t: Math.min(...bounds.map((r) => r.t)),
		r: Math.max(...bounds.map((r) => r.r)),
		b: Math.max(...bounds.map((r) => r.b)),
	};
	return { virt, screens: works };
}

/**
 * 宠物配置存储（guagua_config.json，格式 { scale, wander, pos:{x,y} }，与 PySide6 版共用格式）。
 * set 合并白名单字段后按 delayMs 节流落盘；flush 立即落盘（退出前调用）。
 */
function createConfigStore(filePath, options = {}) {
	const delayMs = Number.isFinite(options.delayMs)
		? options.delayMs
		: CONFIG_WRITE_MS;
	let cache = null;
	let timer = null;

	const read = () => {
		if (cache) return cache;
		try {
			const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
			cache = parsed && typeof parsed === "object" ? parsed : {};
		} catch {
			cache = {};
		}
		return cache;
	};

	const flush = () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		if (!cache) return;
		try {
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, JSON.stringify(cache), "utf8");
		} catch {
			/* 写盘失败只影响位置/缩放记忆，不影响宠物运行 */
		}
	};

	const set = (patch) => {
		const next = patch && typeof patch === "object" ? patch : {};
		const merged = { ...read() };
		if (Number.isFinite(Number(next.scale))) merged.scale = Number(next.scale);
		if (typeof next.wander === "boolean") merged.wander = next.wander;
		const p = next.pos;
		if (p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))) {
			merged.pos = { x: Math.round(Number(p.x)), y: Math.round(Number(p.y)) };
		}
		cache = merged;
		if (timer) clearTimeout(timer);
		timer = setTimeout(flush, delayMs);
	};

	return { read, set, flush };
}

module.exports = { collectScreens, createConfigStore, PET_BASE_W, PET_BASE_H };
