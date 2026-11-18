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
/**
 * 手动展开/收起补偿进行中（与 MessageList 的协作点）。
 * MessageList 的 handleAtBottomChange 会把「内容高度变化导致的被动离底」当成
 * 「用户意图贴底」并滚回底部；而手动切换时用户是在读当前位置，回底会把他正在看的内容
 * 顶出视区（用户反馈的问题）。补偿窗口内抑制这条回拉。
 */
let suppressRepinUntil = 0;
const REPIN_SUPPRESS_MS = 1200;

/** 是否处于手动展开/收起的视口补偿窗口内（MessageList 用它跳过贴底回拉）。 */
export function isViewportToggleInFlight(): boolean {
	return Date.now() < suppressRepinUntil;
}

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
	const maxScroll = scroller.scrollHeight - scroller.clientHeight;
	const contentFitsViewport = maxScroll <= 1;
	// 注：贴底时也必须走锚点回位。贴底策略保持的是「列表底部」不动，若在锚点上方插入
	// 内容（如展开过程输出卡片），正在阅读的那条正文会被顶出视区——用户反馈的问题。
	// 锚点回位保持的是阅读位置，展开后视口自然离开底部，由 MessageList 的假贴底检测接管。
	const beforeTop = anchor.getBoundingClientRect().top;
	const beforeDocTop = beforeTop + scroller.scrollTop;
	// 补偿窗口内置位：阻止 MessageList 把这次高度变化当成「被动离底→滚回底部」
	suppressRepinUntil = Date.now() + REPIN_SUPPRESS_MS;
	apply();
	// 阶段 2 同步启动：归零紧跟 clamp 发生，恢复必须抢在 Virtuoso 异步重算可视
	// 区间之前，否则目标行被虚拟化 unmount/remount，行内展开状态全部丢失
	const cleanup = watchViewportReset(scroller, beforeTop, beforeDocTop);
	// 阶段 1 重试：Virtuoso 的总高度是异步收敛的，首次写入 scrollTop 时若 scrollHeight
	// 仍是旧值会被 clamp 成 0（内容不足一屏的空列表尤其明显——用户点开凸起标签后
	// 正在读的正文被顶出视区）。收敛前每 50ms 重试，最多 1s。
	// 补偿窗口持续 1s：Virtuoso 的总高度经 ResizeObserver 异步收敛，且贴底跟随/timer
	// 可能把 scrollTop 拽回底部——单次写入不够，按固定节奏重试直到锚点归位。
	let tries = 0;
	const deadline = Date.now() + 1000;
	const tick = () => {
		suppressRepinUntil = Date.now() + 300;
		restoreAfterToggle(scroller, anchor, beforeTop);
		tries += 1;
		// 锚点位置精确对上，但容器已到滚动尽头（st === max）时仍可能被裁掉一部分：
		// 展开在锚点上方插入了内容，列表没有余量再往下滚。此时把视口整体上挪，让锚点
		// 完整可见——阅读位置优先于「保持贴底」（用户反馈：展开后正文被顶出视区）。
		if (anchor.isConnected) {
			const rect = anchor.getBoundingClientRect();
			const sRect = scroller.getBoundingClientRect();
			const overflowBottom = rect.bottom - sRect.bottom;
			const max = scroller.scrollHeight - scroller.clientHeight;
			if (overflowBottom > 1 && scroller.scrollTop >= max - 1) {
				scroller.scrollTop = Math.max(0, scroller.scrollTop + overflowBottom + 8);
				// 上挪后仍需保证顶部不越界
				if (anchor.getBoundingClientRect().top < sRect.top) {
					scroller.scrollTop = Math.max(
						0,
						scroller.scrollTop - (sRect.top - anchor.getBoundingClientRect().top) - 8,
					);
				}
			}
		}
		const settled =
			!anchor.isConnected ||
			Math.abs(anchor.getBoundingClientRect().top - beforeTop) <= 1;
		if (!settled && Date.now() < deadline) setTimeout(tick, 50);
	};
	// 首次补偿放在下一帧：同步执行时 DOM 尚未提交（scrollHeight 仍是旧值，写入会被
	// clamp 掉），等到 delayMs（250ms）又会先让用户看到一次跳动。rAF 后布局已更新，
	// 一次即可归位；后续再按节奏纠偏，直到锚点稳定。
	requestAnimationFrame(tick);
	if (delayMs > 0) setTimeout(tick, delayMs);
	// 阶段 3：贴底解除。折叠后视口可能被 clamp 到物理贴底位置，Virtuoso 内建
	// bottom-pinning 会在后续内容增长时把视口拽到新底部。布局收敛后拉离贴底阈值
	// （与 atBottomThreshold=20 同量级）即可解除跟随。
	// 注意：锚点已回位时**必须跳过**——展开场景下锚点回位才是用户想要的阅读位置，
	// 再拉一次会把他正在读的正文重新顶出视区（与阶段 1 来回拉锯）。
	setTimeout(() => {
		// 内容不足一屏时不涉及贴底跟随，且此处任何 scrollTop 写入都会被 clamp 掉
		if (contentFitsViewport) return;
		const settled =
			!anchor.isConnected ||
			Math.abs(anchor.getBoundingClientRect().top - beforeTop) <= 1;
		if (settled) return;
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
	if (!anchor.isConnected) return;
	// 目标：锚点在视口里的位置与切换前一致。
	// 当前偏差 = 现在的位置 - 切换前的位置；把 scrollTop 沿着这个偏差反方向修正。
	// 注意这是「相对视口」的量，与内容是否整体下移无关——这正是它与旧实现的关键区别：
	// 旧实现用同一量反复加减，内容下移被当成需要滚动，把锚点越推越远。
	const currentTop = anchor.getBoundingClientRect().top;
	const delta = currentTop - beforeTop;
	if (Math.abs(delta) <= 0.5) return;
	scroller.scrollTop = Math.max(0, Math.min(scroller.scrollTop + delta, max));
	return;
}
