// 启动时间线（纯函数）：定位「启动到首帧」各阶段耗时。
//
// 为什么需要：启动链路的埋点盲区正好是用户抱怨的那一段——「内核就绪 → 主窗口首次出帧」
// 完全没有日志（只有「Electron main 就绪」「kernel 就绪」等文本行，没有耗时）。两个平台
// 都报过「启动页空白/进度条卡住/很久才出界面」，没有这段数据就只能猜。
//
// 用法：main.cjs 顶部 createStartupTimeline()，在各阶段 mark(name)，最后 log 一行 summary。
function createStartupTimeline(now = Date.now) {
	const t0 = now();
	const entries = [];
	return {
		/** 记录一个阶段，返回相对进程起点的毫秒数 */
		mark(name) {
			const delta = now() - t0;
			entries.push([name, delta]);
			return delta;
		},
		/** "start=+0ms ready=+120ms ..."，无记录时为空串 */
		summary() {
			return entries.map(([name, delta]) => `${name}=+${delta}ms`).join(" ");
		},
		/** 内部记录副本（重试/多次 mark 同名阶段都会保留） */
		marks() {
			return entries.map(([name, delta]) => [name, delta]);
		},
	};
}

module.exports = { createStartupTimeline };
