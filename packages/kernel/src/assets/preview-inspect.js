/**
 * hiagent 预览 inspect 脚本（由 kernel 注入本地 html 预览）：
 * - hover 元素高亮 overlay（pointer-events:none，不干扰页面交互）
 * - 浮动工具条：选择父级 / 发送到聊天（postMessage 给父页面）
 * 脚本整体防御：任何异常静默降级，绝不影响被预览页面。
 * selector 段规则与 kernel preview-locate.ts 严格一致：
 *   有 id → tag#id；有 data-testid → tag[data-testid="v"]；有 role → tag[role="v"]；
 *   否则 tag:nth-of-type(n)；根 <html> → 裸 tag。
 */
(() => {
	function buildSelector(el) {
		var segs = [];
		var cur = el;
		while (cur && cur.tagName) {
			var tag = cur.tagName.toLowerCase();
			var parent = cur.parentElement;
			if (!parent || !parent.tagName) {
				segs.unshift(tag); // 根元素（html）：裸 tag
				break;
			}
			segs.unshift(segFor(cur, tag));
			cur = parent;
		}
		return segs.join(" > ");
	}
	// 元素段：有 id → tag#id；有 data-testid → tag[data-testid="v"]；有 role → tag[role="v"]；
	// 否则 tag:nth-of-type(n)（n 为同标签兄弟序号，从 1 起）。段规则与 kernel preview-locate.ts 严格一致。
	function segFor(el, tag) {
		if (el.id) return tag + "#" + el.id;
		var dt = el.getAttribute && el.getAttribute("data-testid");
		if (dt) return tag + '[data-testid="' + dt + '"]';
		var role = el.getAttribute && el.getAttribute("role");
		if (role) return tag + '[role="' + role + '"]';
		var nth = 0;
		for (var i = 0; i < el.parentElement.children.length; i++) {
			var s = el.parentElement.children[i];
			if (s.tagName && s.tagName.toLowerCase() === tag) nth++;
			if (s === el) break;
		}
		return tag + ":nth-of-type(" + nth + ")";
	}

	/**
	 * 从 /preview/<encDir>/<encRel> 还原磁盘绝对路径（dir 与 rel 各自 decodeURIComponent）。
	 * 嵌套 iframe 场景：内层页面向上层回传选中元素时需携带自身真实文件路径（srcPath），
	 * 否则主应用会用外层页面路径去 /api/preview-locate 定位行号、查错文件。
	 * 非 /preview/ 前缀、无文件段、解码失败 → null。
	 */
	function parsePreviewPathname(pathname) {
		if (typeof pathname !== "string") return null;
		if (pathname.lastIndexOf("/preview/", 0) !== 0) return null;
		var rest = pathname.slice("/preview/".length);
		var slash = rest.indexOf("/");
		if (slash === -1) return null; // 无文件段
		var dir, rel;
		try {
			// 段内允许 %2F 等编码（与 kernel resolvePreviewPath 的解码口径一致）
			// 解码后可能拼出多层路径/..，越权由 kernel allowlist 兑底，这里只做还原
			var dirRaw = rest.slice(0, slash);
			var relRaw = rest.slice(slash + 1);
			if (!dirRaw || !relRaw) return null;
			dir = decodeURIComponent(dirRaw);
			rel = decodeURIComponent(relRaw);
		} catch {
			return null;
		}
		return dir + "/" + rel;
	}

	/** 本预览页自身对应的磁盘路径（非 /preview 加载则 null）；发 picked 消息时携带 */
	function selfPreviewPath() {
		try {
			return parsePreviewPathname(location.pathname);
		} catch {
			return null;
		}
	}

	/**
	 * 向子 iframe 注入 inspect 脚本（srcdoc/about:blank 型）。
	 * 背景：srcdoc 型子 iframe 内容内联在属性里，不发 HTTP 请求，kernel 无从注入，
	 * 子文档内没有任何 inspect 脚本 → 元素选中完全失效。srcdoc/about:blank 子文档
	 * 继承父源，contentDocument 可达，由父页脚本代注入；script src 解析到同 host
	 * （dev 走 vite /preview 代理、生产由 kernel 直出）。跨源子 iframe 不可达，静默跳过。
	 * createScript(doc) 由调用方提供（真实环境创建 <script>，测试环境记录调用），
	 * 返回 truthy 表示已注入；未初始化（无 __hiagentInspect）才注入，防重入。
	 */
	function injectInspectIntoFrames(frames, createScript) {
		var injected = 0;
		for (var i = 0; i < frames.length; i++) {
			var doc = null;
			try {
				doc = frames[i].contentDocument;
			} catch {
				continue; // 跨源不可达：kernel 已无从注入也无能为力，静默跳过
			}
			if (!doc || !doc.documentElement) continue; // 尚未加载完成：load 事件会重试
			if (doc.defaultView && doc.defaultView.__hiagentInspect) continue; // 已初始化
			try {
				if (createScript(doc)) injected++;
			} catch {
				/* 静默降级：单个子 iframe 注入失败不影响其余 */
			}
		}
		return injected;
	}

	/** 元素语义标签（发给 agent 描述）：id → data-testid → role → aria-label → tag.类名（最多 3） */
	function elLabel(el) {
		var tag = el.tagName.toLowerCase();
		if (el.id) return tag + "#" + el.id;
		var dt = el.getAttribute && el.getAttribute("data-testid");
		if (dt) return tag + "[data-testid=" + dt + "]";
		var role = el.getAttribute && el.getAttribute("role");
		if (role) return tag + "[role=" + role + "]";
		var aria = el.getAttribute && el.getAttribute("aria-label");
		if (aria) return tag + "(" + aria.slice(0, 20) + ")";
		var cls = [];
		if (el.classList) {
			for (var i = 0; i < el.classList.length && cls.length < 3; i++)
				cls.push(el.classList[i]);
		}
		return cls.length ? tag + "." + cls.join(".") : tag;
	}

	/** 工具条上的元素名：有 id 用 tag#id，否则 tag.类名（最多 3 个） */
	function displayLabel(el) {
		var tag = el.tagName.toLowerCase();
		return el.id ? tag + "#" + el.id : elLabel(el);
	}

	/**
	 * 把文档坐标矩形 (x,y,w,h) 收敛到视口 (vw,vh) 内：
	 * - 框尺寸不变（宽/高超出视口才收缩到视口大小）
	 * - 仅平移 left/top，让框整体可见、可操作（选中屏幕边缘元素时选择框不跑到屏幕外）
	 * 返回 { left, top, width, height }。
	 */
	function clampRectToViewport(x, y, w, h, vw, vh) {
		var width = Math.min(w, vw);
		var height = Math.min(h, vh);
		var left = Math.min(Math.max(0, x), Math.max(0, vw - width));
		var top = Math.min(Math.max(0, y), Math.max(0, vh - height));
		return { left: left, top: top, width: width, height: height };
	}

	/**
	 * 由元素视口矩形计算 absolute 遮罩层的页面坐标：
	 * 先在【视口坐标系】内收敛（保证框完整落在当前视口内），再加滚动偏移
	 * 转成页面坐标赋给 overlay。注意顺序不能反：若先加偏移再 clamp，
	 * 滚动后框会被拉回文档首屏、视觉上「消失」。
	 */
	function layoutOverlayInPage(vLeft, vTop, w, h, sx, sy, vw, vh) {
		var c = clampRectToViewport(vLeft, vTop, w, h, vw, vh);
		return {
			left: c.left + sx,
			top: c.top + sy,
			width: c.width,
			height: c.height,
		};
	}

	// node/bun 单测环境：仅导出纯函数，不触碰 DOM
	if (typeof module !== "undefined" && module.exports) {
		module.exports = {
			buildSelector: buildSelector,
			displayLabel: displayLabel,
			parsePreviewPathname: parsePreviewPathname,
			injectInspectIntoFrames: injectInspectIntoFrames,
			elLabel: elLabel,
			clampRectToViewport: clampRectToViewport,
			layoutOverlayInPage: layoutOverlayInPage,
		};
		return;
	}
	if (typeof window === "undefined" || window.__hiagentInspect) return;
	window.__hiagentInspect = true;

	try {
		init();
	} catch {
		/* 静默降级：inspect 失败不影响页面 */
	}

	function init() {
		// 性能诊断：统计 render 调用次数/耗时、mousemove 频率、强制布局读取(layout)、
		// 锁定后 rAF 帧数，用于定位复杂预览页的卡顿（layout thrashing）。
		// 开启方式（任一）：
		//   a) 预览 iframe 自身上下文赋值 window.__inspectDebug = true（defineProperty setter 触发）；
		//   b) sandbox 不透明源 iframe 读不到顶层自定义属性，改由顶层 console 发消息跨源激活：
		//      document.querySelector('[data-testid="html-preview-iframe"]')
		//        .contentWindow.postMessage({type:'hiagent:inspect:debug',enabled:true},'*')
		// 开启后 setInterval 每 500ms 输出一次统计（不依赖 render 路径，设置完立刻可见）。
		var perf = (window.__inspectPerf = {
			render: 0,
			renderMs: 0,
			move: 0,
			layout: 0,
			rAF: 0,
		});
		var dbgTimer = null;
		var dbgStart = () => {
			if (dbgTimer) return;
			dbgTimer = setInterval(() => {
				console.warn(
					"[inspect] render=" +
						perf.render +
						" renderMs=" +
						perf.renderMs.toFixed(1) +
						" move=" +
						perf.move +
						" layout=" +
						perf.layout +
						" rAF=" +
						perf.rAF,
				);
			}, 500);
		};
		try {
			Object.defineProperty(window, "__inspectDebug", {
				configurable: true,
				set: (v) => {
					window.__inspectDebugOn = v === true;
					if (window.__inspectDebugOn) dbgStart();
				},
				get: () => window.__inspectDebugOn === true,
			});
		} catch {
			/* 忽略：个别环境 defineProperty 失败则退化为消息激活 */
		}
		var hl = document.createElement("div");
		hl.style.cssText =
			"position:absolute;pointer-events:none;z-index:2147483646;display:none;" +
			"outline:2px solid #2563eb;outline-offset:-2px;background:rgba(37,99,235,.12);";
		var bar = document.createElement("div");
		bar.style.cssText =
			"position:absolute;z-index:2147483647;display:none;gap:4px;" +
			"background:#2563eb;border-radius:5px;padding:2px 5px;font:12px/1.6 sans-serif;";
		var btnStyle =
			"background:transparent;border:none;color:#fff;font-size:11px;padding:1px 5px;cursor:pointer;";
		var btnParent = document.createElement("button");
		btnParent.textContent = "选择父级";
		btnParent.style.cssText = btnStyle;
		var btnSend = document.createElement("button");
		btnSend.textContent = "发送到聊天";
		btnSend.style.cssText = btnStyle;
		// 当前选中元素名显示（按钮左侧，让用户知道选中的是什么；不吃指针事件防挡住按钮）
		var label = document.createElement("span");
		label.style.cssText =
			"color:rgba(255,255,255,.85);font-size:11px;padding:1px 4px;" +
			"max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
			"pointer-events:none;user-select:none;";
		// 锁图标：点击元素锁定后出现，表示「高亮已锁定/固定」；再点一次解除锁定。
		// 预览脚本运行在被预览页(iframe)内，无法引用前端组件库，故内联 SVG（padlock）。
		var btnLock = document.createElement("button");
		btnLock.title = "锁定当前元素";
		btnLock.style.cssText = btnStyle + ";padding:7px 9px;display:none;";
		bar.appendChild(btnLock);
		bar.appendChild(label);
		bar.appendChild(btnParent);
		bar.appendChild(btnSend);
		document.documentElement.appendChild(hl);
		document.documentElement.appendChild(bar);

		// 高亮选择框下方提示：说明可关闭高亮选择功能（跟随浮窗显示）；按键按平台：mac 用 ⌘、Windows 用 Ctrl
		var tip = document.createElement("div");
		var isMac = /Mac|iPhone|iPad/.test(navigator.userAgent || "");
		tip.textContent = (isMac ? "⌘" : "Ctrl") + " 关闭高亮选择功能";
		tip.style.cssText =
			"position:absolute;z-index:2147483647;display:none;" +
			"background:rgba(30,41,59,.9);color:rgba(255,255,255,.75);" +
			"font:11px/1.5 sans-serif;padding:2px 6px;border-radius:4px;" +
			"pointer-events:none;white-space:nowrap;";
		document.documentElement.appendChild(tip);

		var current = null;
		// 工具条锁图标：DOM 构建 SVG（不 innerHTML，静态常量无用户输入）；缓存避免重复建
		var SVG_NS = "http://www.w3.org/2000/svg";
		var padlockCache = { locked: null, unlocked: null };
		function padlockSvg(locked) {
			var key = locked ? "locked" : "unlocked";
			if (padlockCache[key]) return padlockCache[key];
			var svg = document.createElementNS(SVG_NS, "svg");
			svg.setAttribute("width", "12");
			svg.setAttribute("height", "12");
			svg.setAttribute("viewBox", "0 0 24 24");
			svg.setAttribute("fill", "none");
			svg.setAttribute("stroke", "currentColor");
			svg.setAttribute("stroke-width", "1.6");
			svg.setAttribute("stroke-linecap", "round");
			svg.setAttribute("stroke-linejoin", "round");
			svg.style.cssText = "display:block;margin:auto;vertical-align:-0.125em";
			svg.setAttribute("aria-hidden", "true");
			var body = document.createElementNS(SVG_NS, "rect");
			body.setAttribute("x", "5");
			body.setAttribute("y", "10.5");
			body.setAttribute("width", "14");
			body.setAttribute("height", "9.5");
			body.setAttribute("rx", "2");
			var shackle = document.createElementNS(SVG_NS, "path");
			// 闭锁：钩环两端都插入锁体；开锁：右侧端抬起
			shackle.setAttribute(
				"d",
				locked ? "M8 10.5V7a4 4 0 0 1 8 0v3.5" : "M8 10.5V7a4 4 0 0 1 7.6-1.6",
			);
			svg.appendChild(body);
			svg.appendChild(shackle);
			padlockCache[key] = svg;
			return svg;
		}
		// 选择父级后的锁定：鼠标在锁定元素内部移动（含其子元素）不切换选中，移出才解锁。
		// 否则选完父级后随便动一下鼠标，hover 又把选中抢回子元素。
		var locked = false;
		// 点击锁定（pinned）：点击元素后高亮固定在该元素、不再跟鼠标走，浮窗显示锁图标。
		// 解除：再次点击当前元素 / 点锁图标 / 点「发送到聊天」。
		var pinned = false;
		// 全屏唯一锁定互斥：其他层（父/兄弟子层）存在锁定时，本层抑制 hover 高亮与
		// 提示 UI，避免双层高亮叠加混乱；点击其他层元素则抢占锁定（被抢占方自动解除）。
		// 状态经逐层消息传播：上行 lock（子→父）与下行 lock-hold（父→子）。
		var suppressed = false;
		// 锁定时的 selector 快照：框架重渲染重建节点后，按它找接替节点续锁
		var lockedSelector = null;
		// 全局唯一 hover：当前持有 hover 的子层窗口（本层 mousemove 恢复时通知它清除）
		var hoverOwner = null;
		/** pinnened 变化后同步全链：上行告知父层（抑制祖先生高亮）、下行抑制子层 */
		function broadcastLock() {
			try {
				if (window.parent !== window)
					window.parent.postMessage(
						{ type: "hiagent:inspect:lock", locked: pinned },
						"*",
					);
			} catch {
				/* 忽略 */
			}
			sendHoldToChildren(pinned, null);
		}
		/** 下行广播锁定持有状态；excludeWin 为锁定来源子层（防它收到 hold:true 被自己误解除） */
		function sendHoldToChildren(held, excludeWin) {
			var frames = document.querySelectorAll("iframe");
			for (var i = 0; i < frames.length; i++) {
				try {
					if (excludeWin && frames[i].contentWindow === excludeWin) continue;
					frames[i].contentWindow.postMessage(
						{ type: "hiagent:inspect:lock-hold", held: held },
						"*",
					);
				} catch {
					/* 忽略 */
				}
			}
		}
		function setSuppressed(v) {
			if (suppressed === v) return;
			suppressed = v;
			if (v && pinned) {
				// 其他层抢占了锁定：被动解除（不回发）。current 一并清空——
				// 否则抑制解除后 render 会把残留 current 当 hover 目标画出「鬼高亮」
				pinned = false;
				lockedSelector = null;
				current = null;
			}
			render();
		}
		/** 通知子层清除 hover 残留（excludeWin 为 hover 来源子层，它自己不需要清）；逐层下传到最深处 */
		function sendHoverClearToChildren(excludeWin) {
			var frames = document.querySelectorAll("iframe");
			for (var i = 0; i < frames.length; i++) {
				try {
					if (excludeWin && frames[i].contentWindow === excludeWin) continue;
					frames[i].contentWindow.postMessage(
						{ type: "hiagent:inspect:hover-clear" },
						"*",
					);
				} catch {
					/* 忽略 */
				}
			}
		}
		// Ctrl/Cmd 关闭/打开高亮选择功能（开关），状态经主应用持久化（本地预览 iframe 为
		// 不透明源、无法自用 localStorage，故由主应用存取并在 iframe 加载时下发）。
		// 初值 null = 尚未从主应用同步（query/set 任一到达后即为 true/false）。
		// 未知态与「关」同样处理（不绘制高亮）——若初值偏向开，主应用侧 query 回复
		// 一旦丢失，页面会永久保留高亮而开关显示关闭（状态失步，用户实测反馈）。
		var disabled = null;
		function applyInspectState() {
			if (disabled !== false) {
				hl.style.display = "none";
				bar.style.display = "none";
				tip.style.display = "none";
			} else if (current) {
				render();
			}
		}
		// 把开关状态下发到本页所有子 iframe（嵌套预览页的层级间状态一致）。
		// 非预览子 iframe（外部页面/广告等）无 inspect 脚本，消息被忽略，无害。
		function sendSetToChildren(enabled) {
			var frames = document.querySelectorAll("iframe");
			for (var i = 0; i < frames.length; i++) {
				try {
					frames[i].contentWindow.postMessage(
						{
							type: "hiagent:inspect:set",
							enabled: enabled,
							// held = 全屏存在任意锁定（自身锁定也算）：A 锁定时 hold 广播
							// 可能早于子 iframe 加载而丢失，靠 query/set 补齐，语义必须含自身
							held: suppressed || pinned,
						},
						"*",
					);
				} catch {
					/* 忽略 */
				}
			}
		}
		function setDisabled(v) {
			disabled = v;
			applyInspectState();
			sendSetToChildren(!v);
			try {
				window.parent.postMessage(
					{ type: "hiagent:inspect:changed", enabled: !v },
					"*",
				);
			} catch {
				/* 忽略 */
			}
		}
		function toggleInspect() {
			setDisabled(!disabled);
		}

		// 元素是否完全移出视口（窗口滚动/元素移动出屏幕）
		function isFullyOutOfViewport(r) {
			return (
				r.bottom <= 0 ||
				r.top >= window.innerHeight ||
				r.right <= 0 ||
				r.left >= window.innerWidth
			);
		}
		// 元素是否被某祖先 overflow 裁剪容器完全裁剪（元素在容器内滚出、容器本身仍在视口内）
		function isClippedByAncestor(el) {
			var p = el.parentElement;
			while (p && p !== document.body && p !== document.documentElement) {
				var ov = window.getComputedStyle(p).overflow;
				if (ov && ov !== "visible") {
					var pr = p.getBoundingClientRect();
					var er = el.getBoundingClientRect();
					if (
						er.bottom <= pr.top ||
						er.top >= pr.bottom ||
						er.right <= pr.left ||
						er.left >= pr.right
					)
						return true;
				}
				p = p.parentElement;
			}
			return false;
		}

		function render() {
			var _rt = performance.now();
			perf.render++;
			// 诊断埋点：把 render 的判定结果写到 hl 的 data 属性上，供外部（如 E2E/
			// 主应用调试）跨 iframe 读取，定位「高亮不出现」的隐藏原因
			function markHide(reason) {
				hl.dataset.hideReason = reason;
			}
			// 已关闭/尚未同步：任何触发（含 scroll/resize）都不再绘制，保持隐藏
			if (disabled !== false) {
				markHide("disabled:" + String(disabled));
				hl.style.display = "none";
				bar.style.display = "none";
				tip.style.display = "none";
				return;
			}
			// 其他层存在锁定（互斥抑制）：本层不再绘制任何高亮 UI，全屏只剩锁定层的框
			// （自己持有锁定权时不受抑制——锁定分支里已清除）
			if (suppressed && !pinned) {
				markHide("suppressed");
				hl.style.display = "none";
				bar.style.display = "none";
				tip.style.display = "none";
				return;
			}
			if (!current || !current.isConnected || !current.getBoundingClientRect) {
				markHide(pinned ? "no-current:pinned" : "no-current");
				// 锁定元素已脱离文档：框架重渲染（React 等）会重建节点 —— 先按锁定时的
				// selector 找接替节点续锁（tagName 一致才接，防 nth-of-type 误接）；
				// 找不到才真正解除锁定并隐藏高亮（不卡死/悬空）
				if (pinned && current && !current.isConnected) {
					var alt = null;
					if (lockedSelector) {
						try {
							alt = document.querySelector(lockedSelector);
						} catch {
							alt = null;
						}
					}
					if (alt && alt.tagName === current.tagName) {
						current = alt;
					} else {
						pinned = false;
						lockedSelector = null;
						current = null;
						broadcastLock();
					}
				}
				markHide("disconnected");
				hl.style.display = "none";
				bar.style.display = "none";
				tip.style.display = "none";
				btnLock.style.display = "none";
				return;
			}
			var r = current.getBoundingClientRect();
			perf.layout++;
			// 元素完全移出视口或被祖先裁剪容器裁剪时，高亮框随之隐藏（与元素一起消失）
			if (isFullyOutOfViewport(r) || isClippedByAncestor(current)) {
				markHide(isFullyOutOfViewport(r) ? "out-of-viewport" : "clipped");
				hl.style.display = "none";
				bar.style.display = "none";
				tip.style.display = "none";
				return;
			}
			var vw = window.innerWidth;
			var vh = window.innerHeight;
			var sx = window.scrollX;
			var sy = window.scrollY;
			// 高亮框/工具条/提示：先在视口系收敛再转页面坐标——滚动后仍贴合目标元素
			var hlR = layoutOverlayInPage(
				r.left,
				r.top,
				r.width,
				r.height,
				sx,
				sy,
				vw,
				vh,
			);
			hl.style.display = "block";
			hl.style.left = hlR.left + "px";
			hl.style.top = hlR.top + "px";
			hl.style.width = hlR.width + "px";
			hl.style.height = hlR.height + "px";
			// 工具条：位于元素上方（top-28）；内容撑开，需先 display 再量尺寸
			bar.style.display = "flex";
			var barW = bar.offsetWidth;
			var barH = bar.offsetHeight;
			var barR = layoutOverlayInPage(
				r.left,
				r.top - 28,
				barW,
				barH,
				sx,
				sy,
				vw,
				vh,
			);
			bar.style.left = barR.left + "px";
			bar.style.top = barR.top + "px";
			// 提示小字：位于高亮框下方（top+height+6）
			tip.style.display = "flex";
			var tipW = tip.offsetWidth;
			var tipH = tip.offsetHeight;
			var tipR = layoutOverlayInPage(
				r.left,
				r.top + r.height + 6,
				tipW,
				tipH,
				sx,
				sy,
				vw,
				vh,
			);
			tip.style.left = tipR.left + "px";
			tip.style.top = tipR.top + "px";
			var disp = displayLabel(current);
			if (label.textContent !== disp) label.textContent = disp;
			// 锁图标常驻：未锁定（开锁图标）点它锁定当前元素——不点击元素本身，
			// 页面零扰动（可交互元素点击会触发页面自身行为/重渲染，无法稳定锁定）；
			// 已锁定（闭锁图标）点它解除。hover 跟随中随时可锁。
			btnLock.style.display = "inline-block";
			btnLock.title = pinned ? "解除高亮锁定" : "锁定当前元素";
			delete hl.dataset.hideReason;
			// 只在锁定状态变化时才替换图标节点：render 会被 mousemove / 锁定后 rAF
			// 高频调用，若每次都 replaceChildren 重建锁 SVG，用户点击「正中间」（落点
			// 在 SVG 上）时节点刚好被拆换，mousedown/mouseup 之间 DOM 被换 → click
			// 派发异常 → 「点锁正中间不生效、点旁边（padding）反而 OK」。
			if (btnLock.__lockState !== pinned) {
				btnLock.__lockState = pinned;
				btnLock.replaceChildren(padlockSvg(pinned));
			}
			perf.renderMs += performance.now() - _rt;
		}

		document.addEventListener(
			"mousemove",
			(e) => {
				perf.move++;
				if (disabled !== false) return;
				// 其他层锁定中：本层不 hover 不高亮（互斥）；点击仍可抢占锁定
				if (suppressed) return;
				var t = e.target;
				if (!t || t === hl || t === bar || bar.contains(t)) return;
				if (!t.tagName) return;
				// 点击锁定中：hover 不再切换选中，高亮固定在锁定元素
				if (pinned) return;
				// 鼠标悬停在子 iframe 元素上（尚未进入/无法进入其文档）：本层不选中 iframe
				// 外壳（会画出罩住子层的大框），清掉自身残留 hover，等子层脚本接管
				if (t.tagName === "IFRAME") {
					if (current) {
						current = null;
						render();
					}
					return;
				}
				// 粘性区：元素上缘到工具条之间的通道（含工具条），鼠标经过时保持当前选中。
				// 否则从元素移向工具条会穿过间隙命中其他元素，选中被切走，永远点不到按钮。
				if (current && bar.style.display !== "none") {
					var r = current.getBoundingClientRect();
					perf.layout++;
					var br = bar.getBoundingClientRect();
					perf.layout++;
					if (
						e.clientX >= Math.min(r.left, br.left) - 4 &&
						e.clientX <= Math.max(r.right, br.right) + 4 &&
						e.clientY >= br.top - 4 &&
						e.clientY <= r.top
					) {
						return;
					}
				}
				// 锁定中：子元素不抢选；移出锁定元素才解锁恢复 hover
				if (locked && current) {
					if (t === current || current.contains(t)) return;
					locked = false;
				}
				var prev = current;
				current = t;
				// 全局唯一 hover（用户方案）：本层获得选中时，①清掉此前持有 hover 的
				// 子层残留；②向上广播「选中在我这里」，父层收到后清除它自己的残留——
				// 快速跨层移动时边界事件不可靠，靠子层主动广播保证父层必然感知
				if (!prev && hoverOwner) {
					try {
						hoverOwner.postMessage({ type: "hiagent:inspect:hover-clear" }, "*");
					} catch {
						/* 忽略 */
					}
					hoverOwner = null;
				}
				render();
				if (!prev) {
					try {
						window.parent.postMessage(
							{ type: "hiagent:inspect:hover", has: true },
							"*",
						);
					} catch {
						/* 忽略 */
					}
				}
			},
			true,
		);
		// 单击不锁定/不解锁（用户交互改为「双击锁定」）；仅隔离高亮层/工具条上的点击避免
		// 单击不做锁定/解锁（锁定改双击）；页面点击是否拦截由 blockMouseForPage 按
		// 「是否落在当前高亮框内」决定（见下方），此处无需独立 click handler。
		// 双击锁定/解锁：自实现双击检测（click 间隔 <400ms + 落在高亮框内 → 切换）。
		// 不用浏览器 dblclick 事件——快速连点时浏览器多击计数（第 3/5/7… 击不派发
		// dblclick）会丢切换，表现为「快速双击没办法快速解锁/锁定」。
		// capture：先于页面自身逻辑；浮窗内的点击交由按钮 handler 处理。
		var lastClickTime = 0;
		document.addEventListener(
			"click",
			(e) => {
				if (disabled !== false) return;
				var t = e.target;
				if (!t || t === hl || t === bar || bar.contains(t)) return;
				// 只处理「落在当前高亮框内」的点击（与 blockMouseForPage 同一命中语义）
				if (!current || !current.getBoundingClientRect) return;
				var r = current.getBoundingClientRect();
				if (
					e.clientX < r.left ||
					e.clientX > r.right ||
					e.clientY < r.top ||
					e.clientY > r.bottom
				) {
					return;
				}
				var now = performance.now();
				if (now - lastClickTime < 400) {
					// 自判定双击：切换锁定/解锁
					lastClickTime = 0;
					if (pinned) {
						// 已锁定：双击落在锁定框内 → 解锁（位置命中语义，见下）
						pinned = false;
						lockedSelector = null;
						render();
						broadcastLock();
						return;
					}
					pinned = true;
					current = t;
					lockedSelector = buildSelector(t);
					// 抢占成功：锁定权归本层，清除来自其他层的抑制（其锁定已被 hold 广播解除）
					suppressed = false;
					render();
					startFollow();
					// 互斥同步：抑制父层与兄弟子层的高亮，全屏只剩本层锁定
					broadcastLock();
					return;
				}
				lastClickTime = now;
			},
			true,
		);
		window.addEventListener("scroll", render, true);
		window.addEventListener("resize", render);

		// 有高亮选择框（current 已选中/锁定元素）时：点击落在高亮框（选中元素矩形）内的
		// 事件阻止冒泡到被预览页（不穿透触发页面 → 不重渲染，避免干扰选中/锁定）。
		// 点击高亮框外不拦（页面正常响应；hover 通过 mousemove 更新选中）。mousemove 不拦
		// （hover 切换依赖它）。工具条 bar / 高亮层 hl 上的事件不拦（按钮可点）。
		function blockMouseForPage(e) {
			if (disabled !== false) return;
			if (!current || !current.getBoundingClientRect) return;
			var r = current.getBoundingClientRect();
			if (
				e.clientX < r.left ||
				e.clientX > r.right ||
				e.clientY < r.top ||
				e.clientY > r.bottom
			) {
				return;
			}
			var t = e.target;
			if (t === hl || t === bar || bar.contains(t)) return;
			e.preventDefault();
			e.stopPropagation();
		}
		["mousedown", "mouseup", "click", "dblclick", "contextmenu"].forEach((ev) => {
			document.addEventListener(ev, blockMouseForPage, true);
		});

		// Ctrl / Cmd 单独按下再松开（期间无其他按键）→ 切换高亮开关。
		// 组合键（⌘C/⌘V/Ctrl+滚轮等）第一步也会按下修饰键——若 keydown 即翻转，
		// 日常复制粘贴都会静默误切开关，是「开关与实际高亮不符」的高频扰动源，
		// 故改为 keyup 时确认期间无其他按键才翻转。
		var pendingModKey = null;
		document.addEventListener(
			"keydown",
			(e) => {
				if (e.key === "Control" || e.key === "Meta") {
					if (!e.repeat) pendingModKey = e.key;
				} else {
					pendingModKey = null; // 组合键：取消待翻转
				}
			},
			true,
		);
		document.addEventListener(
			"keyup",
			(e) => {
				if ((e.key === "Control" || e.key === "Meta") && pendingModKey === e.key) {
					pendingModKey = null;
					toggleInspect();
				}
			},
			true,
		);
		/**
		 * e.source 是否为本页某个「本地预览子 iframe」的窗口（子层消息合法性校验，
		 * 防任意窗口伪造 picked/changed 注入）。判定：是本页 iframe + 解析后 src
		 * 与本文档同 protocol+host 且路径在 /preview/ 下。
		 * 注意不能用 location.origin 比较：预览页是 sandbox 不透明源，
		 * location.origin 为 "null"，与真实源永不相等，必须比 protocol+host。
		 */
		function isChildPreviewWindow(source) {
			var frames = document.querySelectorAll("iframe");
			for (var i = 0; i < frames.length; i++) {
				if (frames[i].contentWindow !== source) continue;
				try {
					var u = new URL(frames[i].getAttribute("src") || "", location.href);
					var here = new URL(location.href);
					if (u.protocol !== here.protocol || u.host !== here.host) return false;
					return u.pathname.lastIndexOf("/preview/", 0) === 0;
				} catch {
					return false;
				}
			}
			return false;
		}
		// 消息路由（支持嵌套 iframe 预览）：
		// - parent 下发 hiagent:inspect:set → 应用自身 + 逐层下发子 iframe
		// - 子 iframe 上来 hiagent:inspect:query → 用自身状态直接回复（主应用只处理直接子层）
		// - 子 iframe 上来 hiagent:inspect:changed → 走 setDisabled（同步自身 + 上报主应用 + 下发子层）
		// - 子 iframe 上来 hiagent:element-picked → 原样转发 parent（逐层中继到主应用）
		window.addEventListener("message", (e) => {
			var d = e.data;
			if (!d || typeof d.type !== "string") return;
			if (e.source === window.parent) {
				// 下行：父层持有锁定（lock-hold）→ 本层抑制 hover，并逐层下传子层
				if (d.type === "hiagent:inspect:lock-hold") {
					setSuppressed(!!d.held);
					sendHoldToChildren(!!d.held, null);
					return;
				}
				// 下行：鼠标已回到父层 → 清除本层 hover 残留（非锁定态），并逐层下传
				if (d.type === "hiagent:inspect:hover-clear") {
					if (!pinned && current) {
						current = null;
						render();
					}
					sendHoverClearToChildren();
					return;
				}
				// 跨源激活性能诊断：sandbox 不透明源 iframe 读不到顶层自定义属性，
				// 顶层 console postMessage 此消息开启（见 init 内性能诊断注释的用法 b）
				if (d.type === "hiagent:inspect:debug") {
					window.__inspectDebugOn = d.enabled === true;
					if (window.__inspectDebugOn) dbgStart();
					return;
				}
				if (d.type !== "hiagent:inspect:set") return;
				disabled = !d.enabled;
				// 随开关同步锁定持有状态（新加载子层 query 补齐用）；无 held 字段则不动
				if (d.held !== undefined) setSuppressed(!!d.held);
				applyInspectState();
				// 向子层透传的是 enabled 原值（曾误传 !d.enabled → 子层收到
				// set(enabled=false) 被禁用 → srcdoc 嵌套原型高亮选择不出现）
				sendSetToChildren(d.enabled);
				return;
			}
			if (!isChildPreviewWindow(e.source)) return;
			if (d.type === "hiagent:inspect:query") {
				try {
					e.source.postMessage(
						{
							type: "hiagent:inspect:set",
							enabled: !disabled,
							// 同 sendSetToChildren：含自身锁定，覆盖 hold 广播早于子层加载的时序
							held: suppressed || pinned,
						},
						"*",
					);
				} catch {
					/* 忽略 */
				}
				return;
			}
			if (d.type === "hiagent:inspect:changed") {
				setDisabled(d.enabled !== false);
				return;
			}
			if (d.type === "hiagent:inspect:lock") {
				// 上行：子层锁定/解锁 → 本层抑制/恢复 hover，并广播其他子层 + 向上转发
				setSuppressed(!!d.locked);
				// 排除来源：它自己刚锁定，不能被 hold:true 误解除
				sendHoldToChildren(!!d.locked, e.source);
				if (window.parent !== window) {
					try {
						window.parent.postMessage(
							{ type: "hiagent:inspect:lock", locked: !!d.locked },
							"*",
						);
					} catch {
						/* 忽略 */
					}
				}
				return;
			}
			if (d.type === "hiagent:inspect:hover") {
				// 上行：子层获得 hover（用户方案：选中即全局广播）→
				// ①清除本层 hover 残留（锁定态不清）；②通知其他子层清残留；
				// ③记 hoverOwner（本层恢复 hover 时回发 hover-clear）；④向上转发
				if (!pinned && current) {
					current = null;
					render();
				}
				sendHoverClearToChildren(e.source);
				hoverOwner = e.source;
				if (window.parent !== window) {
					try {
						window.parent.postMessage(d, "*");
					} catch {
						/* 忽略 */
					}
				}
				return;
			}
			if (d.type === "hiagent:element-picked") {
				// 已在顶层（无 App 外壳，如直接开预览 URL）：parent 是自己，转发会自发自收
				if (window.parent === window) return;
				try {
					window.parent.postMessage(d, "*");
				} catch {
					/* 忽略 */
				}
			}
		});
		// 主动查询父：读取当前持久化的开关状态（关闭则本次预览直接禁用）
		try {
			window.parent.postMessage({ type: "hiagent:inspect:query" }, "*");
		} catch {
			/* 忽略 */
		}
		// 锁定元素时用 rAF 循环持续跟随：元素移动/伸缩/被移除都能让高亮框及时更新，
		// 不卡死（停在旧位置）也不悬空（元素没了仍显示）。元素脱离文档由 render 的
		// isConnected 检测负责隐藏并解除锁定，tick 下一帧即自停。
		var rafId = null;
		var followFrame = 0;
		function startFollow() {
			if (rafId) return;
			var tick = () => {
				if (disabled !== false || !pinned) {
					rafId = null;
					return;
				}
				perf.rAF++;
				// 节流：每 3 帧（≈20fps）才真正 render 一次——复杂页面每帧
				// getBoundingClientRect 强制布局全页，是锁定后卡顿/交互迟钝的主因
				followFrame++;
				if (followFrame % 3 === 0) render();
				rafId = requestAnimationFrame(tick);
			};
			rafId = requestAnimationFrame(tick);
		}

		function onBtn(e) {
			e.preventDefault();
			e.stopPropagation();
		}
		btnLock.addEventListener("mousedown", onBtn);
		btnParent.addEventListener("mousedown", onBtn);
		btnSend.addEventListener("mousedown", onBtn);

		btnParent.addEventListener("click", (e) => {
			onBtn(e);
			if (current && current.parentElement && current.parentElement.tagName) {
				current = current.parentElement;
				// html 包含一切元素，锁定会让 hover 永久失效，不锁；
				// body 可锁：移到页边空白（命中 html）即解锁
				locked = current.tagName !== "HTML";
				// 锁定中换选目标：selector 快照同步更新（节点重建接替才不会接错）
				if (pinned) lockedSelector = buildSelector(current);
				render();
			}
		});
		btnSend.addEventListener("click", (e) => {
			onBtn(e);
			if (!current) return;
			// srcPath：本页对应的磁盘路径。嵌套 iframe 时主应用只有外层页路径，
			// 靠它把选中元素定位到实际所在文件（/api/preview-locate 行号查询也用它）
			window.parent.postMessage(
				{
					type: "hiagent:element-picked",
					selector: buildSelector(current),
					tagName: current.tagName.toLowerCase(),
					elLabel: elLabel(current),
					srcPath: selfPreviewPath(),
				},
				"*",
			);
			// 发送到聊天后解除高亮锁定（高亮恢复 hover 跟随）
			pinned = false;
			lockedSelector = null;
			render();
			broadcastLock();
		});
		var lastLockTap = 0;
		btnLock.addEventListener("click", (e) => {
			onBtn(e);
			// 节流防连点：锁头是「单击切换」语义，用户习惯性快速连点两下会
			// 翻转两次回到原状态（解锁→立即又锁定），感知为「锁头不生效」。
			// 400ms 内只响应第一次点击。
			var now = performance.now();
			if (now - lastLockTap < 400) return;
			lastLockTap = now;
			if (pinned) {
				// 已锁定（闭锁图标）：解除高亮锁定
				pinned = false;
				lockedSelector = null;
				render();
				broadcastLock();
				return;
			}
			// 未锁定（开锁图标）：锁定当前 hover 元素 —— 不点击元素本身，
			// 页面零扰动（可交互元素点击会触发页面自身行为/重渲染，无法稳定锁定）
			if (!current || !current.tagName) return;
			pinned = true;
			lockedSelector = buildSelector(current);
			suppressed = false;
			render();
			startFollow();
			broadcastLock();
		});

		// srcdoc/about:blank 型子 iframe 由父页代注入（不发 HTTP 请求，kernel 无从注入）。
		// 三个触发时机：init（子 iframe 可能已就绪）/ iframe load / DOM 动态新增。
		// 已初始化的子文档由 __hiagentInspect 防重入，重复调用无害。
		function createChildScript(doc) {
			var s = doc.createElement("script");
			s.src = "/preview-inspect.js";
			doc.documentElement.appendChild(s);
			return true;
		}
		function injectChildren() {
			injectInspectIntoFrames(
				document.querySelectorAll("iframe"),
				createChildScript,
			);
		}
		try {
			injectChildren();
			// iframe 加载完成（srcdoc 内容就绪）后再试一次；捕获阶段监听所有子 iframe 的 load
			document.addEventListener(
				"load",
				(e) => {
					if (e && e.target && e.target.tagName === "IFRAME") injectChildren();
				},
				true,
			);
			// 页面动态新增 iframe（原型面板初始化时才创建等）也能被覆盖
			if (typeof MutationObserver !== "undefined") {
				new MutationObserver(injectChildren).observe(document.documentElement, {
					childList: true,
					subtree: true,
				});
			}
		} catch {
			/* 静默降级：子 iframe 注入失败不影响父页自身选中能力 */
		}
	}
})();
