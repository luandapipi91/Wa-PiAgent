/**
 * hiagent 预览 inspect 脚本（由 kernel 注入本地 html 预览）：
 * - hover 元素高亮 overlay（pointer-events:none，不干扰页面交互）
 * - 浮动工具条：选择父级 / 发送到聊天（postMessage 给父页面）
 * 脚本整体防御：任何异常静默降级，绝不影响被预览页面。
 * selector 段规则与 kernel preview-locate.ts 严格一致：
 *   有 id → tag#id；否则 tag:nth-of-type(n)；根 <html> → 裸 tag。
 */
(function () {
	"use strict";

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
		bar.appendChild(label);
		bar.appendChild(btnParent);
		bar.appendChild(btnSend);
		document.documentElement.appendChild(hl);
		document.documentElement.appendChild(bar);

		var current = null;

		function render() {
			if (!current || !current.getBoundingClientRect) {
				hl.style.display = "none";
				bar.style.display = "none";
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
			label.textContent = displayLabel(current);
		}

		document.addEventListener(
			"mousemove",
			function (e) {
				var t = e.target;
				if (!t || t === hl || t === bar || bar.contains(t)) return;
				if (!t.tagName) return;
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
				current = t;
				render();
			},
			true,
		);
		window.addEventListener("scroll", render, true);
		window.addEventListener("resize", render);

		function onBtn(e) {
			e.preventDefault();
			e.stopPropagation();
		}
		btnParent.addEventListener("mousedown", onBtn);
		btnSend.addEventListener("mousedown", onBtn);

		btnParent.addEventListener("click", function (e) {
			onBtn(e);
			if (current && current.parentElement && current.parentElement.tagName) {
				current = current.parentElement;
				render();
			}
		});
		btnSend.addEventListener("click", function (e) {
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
		});
	}
})();
