// 通知队列管理器：通知卡片的数据与状态操作。纯逻辑模块，零 Electron 依赖，
// 不碰 window / timer（倒计时归上层包装），因此可直接单测。
//
// 同会话合并语义（规格 docs/superpowers/specs/2026-10-26-notice-system-notification-design.md「交互规格（批准稿）」）：
// - 同一会话的多轮完成只保留一条：再次入队同 sessionId 时仅刷新该条 title/body/action，队列位置与条数均不变；
// - 不同会话各自成条，新会话追加到队尾；
// - 条数（count）只统计不同会话——合并语义天然保证每会话至多一条；
// - 无 sessionId 的通知没有合并标识，每次各自成条。

/**
 * 创建通知队列管理器。
 * @returns {{
 *   items: Array<{title: string, body: string, action?: object, sessionId?: string}>,
 *   index: number,
 *   count: number,
 *   enqueue: (n: {title: string, body: string, action?: object, sessionId?: string}) => void,
 *   removeCurrent: () => boolean,
 *   next: () => void,
 *   prev: () => void,
 *   clear: () => void,
 * }}
 */
function createNoticeQueue() {
	/** 当前队列；直接暴露引用，clear() 用原地清空保证外部看到的也是空的。 */
	const items = [];
	/** 当前索引；空队列为 -1。 */
	let index = -1;

	return {
		items,
		get index() {
			return index;
		},
		get count() {
			return items.length;
		},

		/**
		 * 入队一条通知。
		 * - 同 sessionId 已存在：仅刷新该条 title/body/action，位置不变、条数不变（同会话合并）；
		 * - 其余（新 sessionId / 无 sessionId）：追加到队尾，index 指向新条。
		 * action 载荷原样透传，不解析不变形。
		 */
		enqueue({ title, body, action, sessionId }) {
			const existing =
				sessionId != null ? items.find((it) => it.sessionId === sessionId) : undefined;
			if (existing) {
				existing.title = title;
				existing.body = body;
				existing.action = action;
				return;
			}
			items.push({ title, body, action, sessionId });
			index = items.length - 1;
		},

		/**
		 * 移除当前条。index 指向下一条件目；移除的是末条则回退到前一条。
		 * @returns {boolean} 队列已空（应关闭卡片窗口）时为 true。
		 */
		removeCurrent() {
			if (items.length === 0) return true;
			items.splice(index, 1);
			if (items.length === 0) {
				index = -1;
				return true;
			}
			if (index >= items.length) index = items.length - 1; // 移除的是末条 → 回退
			// 否则 index 保持：原下一条已滑入当前位置
			return false;
		},

		/** 循环下一条：末条 next → 首条。空队列为 no-op。 */
		next() {
			if (items.length === 0) return;
			index = (index + 1) % items.length;
		},

		/** 循环上一条：首条 prev → 末条。空队列为 no-op。 */
		prev() {
			if (items.length === 0) return;
			index = (index - 1 + items.length) % items.length;
		},

		/** 清空队列，index 重置为 -1。 */
		clear() {
			items.length = 0;
			index = -1;
		},
	};
}

module.exports = { createNoticeQueue };
