// 桌面宠物窗口（呱呱）的 Electron 侧实现：显示器信息转换、配置持久化、建窗/销窗与 IPC。
// 画面本体是 src/assets/pet.html（单文件零依赖，由交付件移植而来）。
// 依赖全部经参数注入（BrowserWindow/ipcMain/screen/log/...），便于单测——风格同 util/native-dialogs.cjs。
const path = require("node:path");
const fs = require("node:fs");

/** 宠物窗口基准尺寸（页面的 #win 在 100% 缩放下的尺寸） */
const PET_BASE_W = 260;
const PET_BASE_H = 258;
/** 宠物窗口的固定尺寸：取「最大缩放下的宠物」与「两级菜单所需」的较大者。
 *  窗口几何恒定后，缩放只改窗口内部，菜单 / 锚点 / 穿透都不再受缩放影响。 */
const PET_WIN_W = 560;
const PET_WIN_H = 660;
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

/**
 * 装配宠物窗口：建窗/销窗、IPC 契约、配置持久化。
 * 依赖注入便于单测；所有 IPC 均校验 event.sender（主窗口请求与宠物窗口请求分开校验）。
 * 返回 { setEnabled, celebrate, flush, dispose, getWindow, isOpen }。
 */
function setupPetWindow(deps = {}) {
	// 解构放在函数体内而不是参数表：参数表里带默认值（platform = ...）会让 tsc 推断出参数对象类型，
	// 测试里传 mock 依赖会被多余属性检查拦下（报 “不存在于类型 { platform?: Platform }”）。
	const {
		BrowserWindow,
		ipcMain,
		screen,
		log,
		app,
		configFile,
		getMainWindow,
		onPetClosed,
		onShowMain,
	} = deps;
	const platform = deps.platform || process.platform;
	let petWin = null;
	const config = createConfigStore(configFile);
	const petPreload = path.join(__dirname, "pet-preload.cjs");
	const petHtml = path.join(__dirname, "assets", "pet.html");

	const isPetSender = (event) =>
		Boolean(petWin) &&
		!petWin.isDestroyed() &&
		event.sender === petWin.webContents;

	const isMainSender = (event) => {
		const main = typeof getMainWindow === "function" ? getMainWindow() : null;
		return (
			Boolean(main) && !main.isDestroyed?.() && event.sender === main.webContents
		);
	};

	/** 无历史位置时的默认摆放：主屏右下角（宠物页面 boot 后会按记忆位置自行校正） */
	const defaultBounds = () => {
		let area = { x: 0, y: 0, width: 1920, height: 1080 };
		try {
			area = screen.getPrimaryDisplay().workArea;
		} catch {
			/* 拿不到就用兜底矩形 */
		}
		return {
			x: Math.round(area.x + area.width - PET_WIN_W - 20),
			y: Math.round(area.y + area.height - PET_WIN_H - 60),
			width: PET_WIN_W,
			height: PET_WIN_H,
		};
	};

	// 只有内部通道（菜单「关闭桌面宠物」/ 设置开关）才允许真正关闭，
	// 其它任何关闭请求（cmd+w、窗口菜单、系统）一律拦下。
	let allowClose = false;
	// 应用退出必须放行：否则退出流程会被 close 拦截卡住，整个应用退不掉。
	if (app && typeof app.on === "function") {
		app.on("before-quit", () => { allowClose = true; });
	}
	const create = () => {
		if (petWin && !petWin.isDestroyed()) return petWin;
		allowClose = false;
		const bounds = defaultBounds();
		petWin = new BrowserWindow({
			...bounds,
			transparent: true, // 逐像素透明（配合页面 body.transparent-host）
			frame: false, // 无边框
			resizable: false,
			// 不出现在系统的窗口列表里（macOS 的「窗口」菜单 / Dock 右键列表）：
			// panel 是 NSPanel，不参与系统的普通窗口枚举，顺带也不抢焦点、不进 Cmd+Tab。
			type: "panel",
			skipTaskbar: true, // 不占任务栏（Windows / Linux）
			hasShadow: false, // 透明窗口必须去掉窗口投影
			useContentSize: true, // 尺寸=内容尺寸，配合页面的缩放换算
			show: false, // 等页面加载完再显示，避免空白帧
			// 置顶（需求变更）：点击其它应用后不被遮挡。macOS 默认 floating 层级，
			// 高于普通应用窗口、不抢焦点；交付说明原写的「普通窗口层级」已按用户要求改掉。
			alwaysOnTop: true,
			webPreferences: {
				nodeIntegration: false,
				contextIsolation: true,
				sandbox: false, // preload 需要 require('electron')
				preload: petPreload,
			},
		});
		const win = petWin;
		// 双保险：显式声明不从「窗口」菜单里列出（panel 已不参与枚举，这里再声明一次）。
		win.excludedFromShownWindowsMenu = true;
		win.webContents.once("did-finish-load", () => {
			if (win && !win.isDestroyed()) win.show();
		});
		// 拦下系统关闭（cmd+w / 窗口菜单 / 系统）：只有内部 destroy() 设置的
		// allowClose 才放行，否则宠物会被意外关掉且难以恢复。
		win.on("close", (e) => {
			if (!allowClose) e.preventDefault();
		});
		win.on("closed", () => {
			if (petWin === win) petWin = null;
		});
		win.loadFile(petHtml);
		return petWin;
	};

	const destroy = () => {
		if (!petWin || petWin.isDestroyed()) {
			petWin = null;
			return;
		}
		const win = petWin;
		petWin = null;
		allowClose = true; // 内部销毁：放行随后的 close
		try {
			// 先 hide 再 close：hide 让「窗口可见性变化」在对象仍存活时先处理完，
			// 降低销毁瞬间与系统可见性/遮挡通知（macOS 异步到达）的竞态。
			if (typeof win.isVisible === "function" && win.isVisible()) win.hide();
		} catch {
			/* hide 失败不影响后续 close */
		}
		try {
			// 走正常关闭流程（close），不用 destroy：destroy 是强制销毁、不触发关闭流程，
			// 系统可见性变化事件会在对象已释放之后才被 Electron 内部钩子处理 → 主进程抛
			// “Object has been destroyed”（BrowserWindow.visibilityChanged）。
			// 仓库既有窗口（预览窗口）同样只用 hide / close。
			win.close();
		} catch (e) {
			log?.error?.("[pet] 关闭宠物窗口失败", e);
		}
	};

	/** 透明区域穿透：forward 让穿透态仍能收到 mousemove（macOS/Windows 支持，Linux 忽略） */
	const applyClickThrough = (flag) => {
		if (!petWin || petWin.isDestroyed()) return;
		try {
			if (flag) {
				if (platform === "linux") petWin.setIgnoreMouseEvents(true);
				else petWin.setIgnoreMouseEvents(true, { forward: true });
			} else {
				petWin.setIgnoreMouseEvents(false);
			}
		} catch (e) {
			log?.error?.("[pet] 切换点击穿透失败", e);
		}
	};

	// ---- IPC：主窗口 → 主进程 ----
	// 点击宠物 → 唤回主窗口：主窗口收起时连 Dock 图标都被隐藏，
	// 那时宠物是唯一还看得见的入口。仅当主窗口确实不可见时才动作，已开着就不打扰。
	ipcMain.on("pet:show-main", (event) => {
		if (!isPetSender(event)) return;
		const main = typeof getMainWindow === "function" ? getMainWindow() : null;
		if (!main || main.isDestroyed() || main.isVisible()) return;
		if (typeof onShowMain === "function") onShowMain();
	});

	ipcMain.on("petwin:set-enabled", (event, enabled) => {
		if (!isMainSender(event)) return;
		if (enabled === true) create();
		else destroy();
	});

	ipcMain.on("petwin:celebrate", (event) => {
		if (!isMainSender(event)) return;
		if (!petWin || petWin.isDestroyed()) return;
		petWin.webContents.send("petwin:celebrate");
	});

	// ---- IPC：宠物窗口 → 主进程 ----
	ipcMain.on("pet:move", (event, x, y) => {
		if (!isPetSender(event)) return;
		const nx = Math.round(Number(x));
		const ny = Math.round(Number(y));
		if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
		petWin.setPosition(nx, ny);
	});

	ipcMain.on("pet:size", (event, w, h) => {
		if (!isPetSender(event)) return;
		const nw = Math.round(Number(w));
		const nh = Math.round(Number(h));
		if (!Number.isFinite(nw) || !Number.isFinite(nh)) return;
		petWin.setContentSize(Math.max(1, nw), Math.max(1, nh));
	});

	// 位置与尺寸一次下发（原子）：拆成 pet:move + pet:size 两次 IPC 时，窗口会出现
	// 「位置已变、尺寸未变」的中间态，拖动缩放滑条时表现为宠物在屏幕上乱跳。
	ipcMain.on("pet:bounds", (event, x, y, w, h) => {
		if (!isPetSender(event)) return;
		const nx = Math.round(Number(x));
		const ny = Math.round(Number(y));
		const nw = Math.round(Number(w));
		const nh = Math.round(Number(h));
		if (![nx, ny, nw, nh].every((v) => Number.isFinite(v))) return;
		petWin.setBounds({
			x: nx,
			y: ny,
			width: Math.max(1, nw),
			height: Math.max(1, nh),
		});
	});

	ipcMain.on("pet:click-through", (event, flag) => {
		if (!isPetSender(event)) return;
		applyClickThrough(flag === true);
	});

	ipcMain.handle("pet:cursor", () => {
		const p = screen.getCursorScreenPoint();
		return { x: Math.round(p.x), y: Math.round(p.y) };
	});

	// 页面用 sendSync 同步读取：必须用 ipcMain.on + event.returnValue
	ipcMain.on("pet:screens", (event) => {
		if (!isPetSender(event)) return;
		event.returnValue = collectScreens(screen.getAllDisplays());
	});

	ipcMain.on("pet:save-config", (event, cfg) => {
		if (!isPetSender(event)) return;
		config.set(cfg);
	});

	ipcMain.on("pet:load-config", (event) => {
		if (!isPetSender(event)) return;
		event.returnValue = config.read();
	});

	ipcMain.on("pet:close", (event) => {
		if (!isPetSender(event)) return;
		destroy();
		// 用户主动关闭 → 回执主窗口把设置开关置关（避免「设置了开、宠物却不在」的不一致）
		if (typeof onPetClosed === "function") onPetClosed();
	});

	return {
		setEnabled: (enabled) => {
			if (enabled) create();
			else destroy();
		},
		celebrate: () => {
			if (!petWin || petWin.isDestroyed()) return false;
			petWin.webContents.send("petwin:celebrate");
			return true;
		},
		flush: () => config.flush(),
		dispose: () => {
			config.flush();
			destroy();
		},
		getWindow: () => petWin,
		isOpen: () => Boolean(petWin) && !petWin.isDestroyed(),
	};
}

module.exports = {
	collectScreens,
	createConfigStore,
	setupPetWindow,
	PET_BASE_W,
	PET_BASE_H,
	PET_WIN_W,
	PET_WIN_H,
};
