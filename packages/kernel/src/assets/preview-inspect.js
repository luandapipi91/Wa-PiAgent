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
		btnLock.title = "解除高亮锁定";
		btnLock.style.cssText = btnStyle + ";display:none;";
		btnLock.innerHTML =
			'<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="display:block;margin:auto;vertical-align:-0.125em" aria-hidden="true"><rect x="5" y="10.5" width="14" height="9.5" rx="2"></rect><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"></path></svg>';
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
		// 选择父级后的锁定：鼠标在锁定元素内部移动（含其子元素）不切换选中，移出才解锁。
		// 否则选完父级后随便动一下鼠标，hover 又把选中抢回子元素。
		var locked = false;
		// 点击锁定（pinned）：点击元素后高亮固定在该元素、不再跟鼠标走，浮窗显示锁图标。
		// 解除：再次点击当前元素 / 点锁图标 / 点「发送到聊天」。
		var pinned = false;
		// Ctrl/Cmd 关闭/打开高亮选择功能（开关），状态经主应用持久化（本地预览 iframe 为
		// 不透明源、无法自用 localStorage，故由主应用存取并在 iframe 加载时下发）。
		var disabled = false;
		function applyInspectState() {
			if (disabled) {
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
						{ type: "hiagent:inspect:set", enabled: enabled },
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
			// 已关闭高亮选择：任何触发（含 scroll/resize）都不再绘制，保持隐藏
			if (disabled) {
				hl.style.display = "none";
				bar.style.display = "none";
				tip.style.display = "none";
				return;
			}
			if (!current || !current.isConnected || !current.getBoundingClientRect) {
				// 锁定元素已脱离文档：解除锁定并隐藏高亮（不卡死/悬空）
				if (pinned && current && !current.isConnected) {
					pinned = false;
					current = null;
				}
				hl.style.display = "none";
				bar.style.display = "none";
				tip.style.display = "none";
				btnLock.style.display = "none";
				return;
			}
			var r = current.getBoundingClientRect();
			// 元素完全移出视口或被祖先裁剪容器裁剪时，高亮框随之隐藏（与元素一起消失）
			if (isFullyOutOfViewport(r) || isClippedByAncestor(current)) {
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
			// 锁图标：锁定态显示，否则隐藏
			btnLock.style.display = pinned ? "inline-block" : "none";
		}

		document.addEventListener(
			"mousemove",
			(e) => {
				if (disabled) return;
				var t = e.target;
				if (!t || t === hl || t === bar || bar.contains(t)) return;
				if (!t.tagName) return;
				// 点击锁定中：hover 不再切换选中，高亮固定在锁定元素
				if (pinned) return;
				// 粘性区：元素上缘到工具条之间的通道（含工具条），鼠标经过时保持当前选中。
				// 否则从元素移向工具条会穿过间隙命中其他元素，选中被切走，永远点不到按钮。
				if (current && bar.style.display !== "none") {
					var r = current.getBoundingClientRect();
					var br = bar.getBoundingClientRect();
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
				current = t;
				render();
			},
			true,
		);
		// 点击锁定 / 再点解除（capture：先于页面自身逻辑；浮窗内的点击交由按钮 handler 处理）
		document.addEventListener(
			"click",
			(e) => {
				if (disabled) return;
				var t = e.target;
				if (!t || t === hl || t === bar || bar.contains(t)) return;
				if (pinned) {
					// 锁定中：点锁定元素（或其子元素）本身才解锁；点任何其他元素保持锁定
					if (t !== current && !current.contains(t)) return;
					pinned = false;
					render();
					e.preventDefault();
				} else {
					// 首次点击：锁定该元素（高亮固定 + 浮窗显示锁图标）
					if (!t.tagName) return;
					pinned = true;
					current = t;
					render();
					startFollow();
					e.preventDefault();
				}
			},
			true,
		);
		window.addEventListener("scroll", render, true);
		window.addEventListener("resize", render);

		// Ctrl / Cmd 关闭或打开高亮选择功能（按键即切换开关）
		document.addEventListener(
			"keydown",
			(e) => {
				if (e.key === "Control" || e.key === "Meta") toggleInspect();
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
				if (d.type !== "hiagent:inspect:set") return;
				disabled = !d.enabled;
				applyInspectState();
				sendSetToChildren(!d.enabled);
				return;
			}
			if (!isChildPreviewWindow(e.source)) return;
			if (d.type === "hiagent:inspect:query") {
				try {
					e.source.postMessage(
						{ type: "hiagent:inspect:set", enabled: !disabled },
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
		function startFollow() {
			if (rafId) return;
			var tick = () => {
				if (disabled || !pinned) {
					rafId = null;
					return;
				}
				render();
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
			render();
		});
		btnLock.addEventListener("click", (e) => {
			onBtn(e);
			// 点锁图标：解除高亮锁定
			pinned = false;
			render();
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
