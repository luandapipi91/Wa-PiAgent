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
		configFile,
		getMainWindow,
		onPetClosed,
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
			x: Math.round(area.x + area.width - PET_BASE_W - 20),
			y: Math.round(area.y + area.height - PET_BASE_H - 60),
			width: PET_BASE_W,
			height: PET_BASE_H,
		};
	};

	const create = () => {
		if (petWin && !petWin.isDestroyed()) return petWin;
		const bounds = defaultBounds();
		petWin = new BrowserWindow({
			...bounds,
			transparent: true, // 逐像素透明（配合页面 body.transparent-host）
			frame: false, // 无边框
			resizable: false,
			skipTaskbar: true, // 不占任务栏
			hasShadow: false, // 透明窗口必须去掉窗口投影
			useContentSize: true, // 尺寸=内容尺寸，配合页面的缩放换算
			show: false, // 等页面加载完再显示，避免空白帧
			// 不设置 alwaysOnTop：保持普通窗口层级
			webPreferences: {
				nodeIntegration: false,
				contextIsolation: true,
				sandbox: false, // preload 需要 require('electron')
				preload: petPreload,
			},
		});
		const win = petWin;
		win.webContents.once("did-finish-load", () => {
			if (win && !win.isDestroyed()) win.show();
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
		try {
			// 走正常关闭流程（close），不用 destroy：destroy 是强制销毁、不触发关闭流程，
			// 系统可见性变化事件会在对象已释放之后才被 Electron 内部钩子处理 → 主进程抛
			// “Object has been destroyed”（BrowserWindow.visibilityChanged）并整应用退出。
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
};
