// 「Ctrl/Meta 单按松开」判定状态机。
//
// 背景（2026-10-10）：预览「选择元素」的 Cmd/Ctrl 快捷键原在预览 iframe 内注入脚本
// 与主应用 window 双通道 DOM 监听并存（冲突覆盖风险），收敛为 Electron 主进程
// before-input-event 单点监听。本模块把原始按键流判成「修饰键单按」事件：
//   - Ctrl / Meta 按下后松开，且期间没有按过其他任何键 → 触发一次（返回 true）
//   - 组合键（⌘C/⌘V/Ctrl+Tab 等，期间出现其他键）→ 不触发
//   - autoRepeat（按住不松的连发）→ 不建立待翻转，松开不触发
//   - 150ms 去抖：部分键盘/驱动会双发 Meta keydown(非 repeat)+keyup 配对，
//     窗口内的第二配对忽略，避免一次按键切换两次（开了又关）
// 语义与原两处 DOM 监听逐行为对齐（含去抖阈值），仅监听点收敛为一。

/** @param {{ now?: () => number, cooldownMs?: number }} opts 测试可注入时钟与窗口 */
function createModKeyTracker(opts = {}) {
	const now = opts.now ?? (() => Date.now());
	const cooldownMs = opts.cooldownMs ?? 150;
	let pending = null; // 待配对的修饰键（"Control" | "Meta" | null）
	let lastToggleAt = -Infinity;

	/**
	 * @param {{ type: "keyDown"|"keyUp", key: string, isAutoRepeat?: boolean }} input
	 *        Electron before-input-event 的 input 对象
	 * @returns {boolean} 是否构成一次「单按松开」
	 */
	function feed(input) {
		if (input.type === "keyDown") {
			if (input.key === "Control" || input.key === "Meta") {
				if (!input.isAutoRepeat) pending = input.key;
			} else {
				pending = null; // 组合键：取消待翻转
			}
			return false;
		}
		// keyUp：只认与待翻转键配对的那次
		if (
			(input.key !== "Control" && input.key !== "Meta") ||
			pending !== input.key
		) {
			return false;
		}
		pending = null;
		const t = now();
		if (t - lastToggleAt < cooldownMs) return false; // 双发配对去抖
		lastToggleAt = t;
		return true;
	}

	return { feed };
}

module.exports = { createModKeyTracker };
