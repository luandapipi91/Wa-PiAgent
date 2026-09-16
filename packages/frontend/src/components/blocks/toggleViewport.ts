/**
 * 折叠/展开切换时的视口位置保持。
 *
 * 背景：消息列表是 Virtuoso 虚拟滚动，长思考/工具卡的 body 为条件渲染（无高度动画），
 * 折叠时行高瞬时阶跃、列表总高度骤减。当用户位置距列表底部小于折叠量时（流式中查看
 * 长过程卡的典型位置），浏览器把 scrollTop 强制 clamp 到新的最大值；随后 Virtuoso 在
 * 内部布局数据收敛期间还可能把视口直接重置到列表头（scrollTop≈0，e2e 实测复现）——
 * 用户正在查看的内容瞬间消失，视口「跳顶」。CSS scroll anchoring 对虚拟列表不生效，
 * 因此需要手动保持：以卡片头部按钮为锚点（点击折叠时它必然可见），把视口恢复到
 * 锚点所在的相对位置。
 *
 * 关键事实（e2e 实测）：
 *  - 锚点的文档绝对位置在折叠前后不变（它上方的内容不动），因此「折叠前记录文档
 *    位置」即可在锚点 DOM 被虚拟化移除后仍能恢复视口；
 *  - 折叠后的短暂窗口内从外部改 scrollTop，Virtuoso 会以内部尚未收敛的高度数据做
 *    可视区间计算，反而把视口打到列表头；而布局收敛后（items 全量渲染、总高与
 *    scrollHeight 一致）的滚动是安全的。
 *
 * 因此补偿分两段：
 *  - 阶段 1（delayMs 后）：布局已收敛，做一次锚点回位；
 *  - 阶段 2（监听窗口 2s）：若 Virtuoso 随后把视口重置到列表头，按折叠前记录的
 *    锚点文档位置恢复一次。恢复必须抢在 Virtuoso 异步重算可视区间之前（同步监听），
 *    否则目标行会被虚拟化 unmount/remount，行内展开状态全部丢失。
 *
 * 与 MessageList 的协作：clamp 瞬间「假贴底检测」会把 stickBottom 纠正为 false
 * （见 handleScrollerScroll），贴底回拉不会与这里的恢复竞争。
 *
 * @param anchor 卡片头部按钮元素（切换时在视口内）
 * @param apply 实际执行状态切换的函数
 * @param delayMs 阶段 1 补偿延迟（默认 250ms；测试注入 0）
 */
export function togglePreservingViewport(
	anchor: HTMLElement,
	apply: () => void,
	delayMs = 250,
): void {
	const scroller = anchor.closest<HTMLElement>("[data-virtuoso-scroller]");
	if (!scroller) {
		// 非虚拟列表环境（组件测试/其他容器）：无 scroller 可补偿，直接切换
		apply();
		return;
	}
	const distanceToBottom =
		scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
	if (distanceToBottom < 40) {
		// 贴底：交给 MessageList 贴底跟随逻辑
		apply();
		return;
	}
	const beforeTop = anchor.getBoundingClientRect().top;
	const beforeDocTop = beforeTop + scroller.scrollTop;
	apply();
	// 阶段 2 同步启动：归零紧跟 clamp 发生，恢复必须抢在 Virtuoso 异步重算可视
	// 区间之前，否则目标行被虚拟化 unmount/remount，行内展开状态全部丢失
	const cleanup = watchViewportReset(scroller, beforeTop, beforeDocTop);
	setTimeout(() => {
		restoreAfterToggle(scroller, anchor, beforeTop);
	}, delayMs);
	// 阶段 3：贴底解除。折叠后视口往往被 clamp 到物理贴底位置（剩余不足一屏），
	// Virtuoso 内建 bottom-pinning 会在后续内容增长（流式输出）时把视口拽到新底部。
	// 布局收敛后拉离贴底阈值（与 atBottomThreshold=20 同量级）即可解除跟随；
	// 假贴底检测已把 stickBottom 压住，MessageList 的回拉逻辑不会与之竞争。
	setTimeout(() => {
		const distToBottom =
			scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
		if (distToBottom < 20)
			scroller.scrollTop = Math.max(0, scroller.scrollTop - (30 - distToBottom));
	}, 500);
	setTimeout(cleanup, 2000);
}

/**
 * 阶段 2：监听视口被重置到列表头（st≈0）的情况，按折叠前锚点的文档位置恢复一次。
 * 返回拆除监听的 cleanup。
 */
function watchViewportReset(
	scroller: HTMLElement,
	beforeTop: number,
	beforeDocTop: number,
): () => void {
	const restore = () => {
		const maxNow = scroller.scrollHeight - scroller.clientHeight;
		// st≈0 且内容显著超过一屏 → 视口被重置；锚点不在首屏才有恢复意义。
		// 恢复本身不阻断后续检测：阶段 3 的贴底解除写入若再次触发重置可再次恢复，
		// 恢复后的 st ≥ 阈值不会自循环。
		if (
			scroller.scrollTop < 10 &&
			maxNow > scroller.clientHeight &&
			beforeDocTop > scroller.clientHeight
		) {
			scroller.scrollTop = Math.max(0, Math.min(beforeDocTop - beforeTop, maxNow));
			return true;
		}
		return false;
	};
	let restored = false;
	const onScroll = () => {
		if (!restored && restore()) restored = true;
	};
	const cleanup = () => scroller.removeEventListener("scroll", onScroll);
	scroller.addEventListener("scroll", onScroll);
	// 归零可能已发生在监听安装之前（紧跟 clamp 同步发生）——立即检查一次
	onScroll();
	return cleanup;
}

/** 阶段 1（见 togglePreservingViewport 注释）：布局收敛后的锚点回位。 */
function restoreAfterToggle(
	scroller: HTMLElement,
	anchor: HTMLElement,
	beforeTop: number,
): void {
	const max = scroller.scrollHeight - scroller.clientHeight;
	// 阶段 1：锚点回位（补偿 clamp 造成的视口偏移）
	if (anchor.isConnected) {
		const delta = anchor.getBoundingClientRect().top - beforeTop;
		if (Math.abs(delta) > 0.5) {
			scroller.scrollTop = Math.max(0, Math.min(scroller.scrollTop + delta, max));
		}
	}
}
