/**
 * hiagent 预览 inspect 脚本（由 kernel 注入本地 html 预览）：
 * - hover 元素高亮 overlay（pointer-events:none，不干扰页面交互）
 * - 浮动工具条：选择父级 / 发送到聊天（postMessage 给父页面）
 * 脚本整体防御：任何异常静默降级，绝不影响被预览页面。
 * selector 段规则与 kernel preview-locate.ts 严格一致：
 *   有 id → tag#id；否则 tag:nth-of-type(n)；根 <html> → 裸 tag。
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
			if (cur.id) {
				segs.unshift(tag + "#" + cur.id);
			} else {
				var nth = 0;
				for (var i = 0; i < parent.children.length; i++) {
					var s = parent.children[i];
					if (s.tagName && s.tagName.toLowerCase() === tag) nth++;
					if (s === cur) break;
				}
				segs.unshift(tag + ":nth-of-type(" + nth + ")");
			}
			cur = parent;
		}
		return segs.join(" > ");
	}

	function elLabel(el) {
		var tag = el.tagName.toLowerCase();
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

	// node/bun 单测环境：仅导出纯函数，不触碰 DOM
	if (typeof module !== "undefined" && module.exports) {
		module.exports = {
			buildSelector: buildSelector,
			displayLabel: displayLabel,
			elLabel: elLabel,
		};
		return;
	}
	if (typeof window === "undefined" || window.__hiagentInspect) return;
	window.__hiagentInspect = true;

	try {
		init();
	} catch (e) {
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
		function setDisabled(v) {
			disabled = v;
			applyInspectState();
			try {
				window.parent.postMessage(
					{ type: "hiagent:inspect:changed", enabled: !v },
					"*",
				);
			} catch (e) {
				/* 忽略 */
			}
		}
		function toggleInspect() {
			setDisabled(!disabled);
		}

		function render() {
			if (!current || !current.getBoundingClientRect) {
				hl.style.display = "none";
				bar.style.display = "none";
				tip.style.display = "none";
				return;
			}
			var r = current.getBoundingClientRect();
			var x = r.left + window.scrollX;
			var y = r.top + window.scrollY;
			hl.style.display = "block";
			hl.style.left = x + "px";
			hl.style.top = y + "px";
			hl.style.width = r.width + "px";
			hl.style.height = r.height + "px";
			bar.style.display = "flex";
			bar.style.left = x + "px";
			bar.style.top = Math.max(0, y - 28) + "px";
			// 提示小字：显示在高亮框左下方、边框外
			tip.style.display = "flex";
			tip.style.left = x + "px";
			tip.style.top = y + r.height + 6 + "px";
			label.textContent = displayLabel(current);
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
					// 锁定中再点一次：解除锁定；点到的元素成为 hover 目标
					pinned = false;
					if (t.tagName) current = t;
					render();
					e.preventDefault();
				} else {
					// 首次点击：锁定该元素（高亮固定 + 浮窗显示锁图标）
					if (!t.tagName) return;
					pinned = true;
					current = t;
					render();
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
		// 主应用下发持久化的开关状态
		window.addEventListener("message", (e) => {
			if (e.source !== window.parent) return;
			var d = e.data;
			if (!d || d.type !== "hiagent:inspect:set") return;
			disabled = !d.enabled;
			applyInspectState();
		});
		// 主动查询父：读取当前持久化的开关状态（关闭则本次预览直接禁用）
		try {
			window.parent.postMessage({ type: "hiagent:inspect:query" }, "*");
		} catch (e) {
			/* 忽略 */
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
			window.parent.postMessage(
				{
					type: "hiagent:element-picked",
					selector: buildSelector(current),
					tagName: current.tagName.toLowerCase(),
					elLabel: elLabel(current),
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
	}
})();
