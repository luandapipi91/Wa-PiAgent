import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * tui-host-demo —— 扩展 TUI 宿主（ctx.ui.custom 兼容）的测试桩。
 *
 * 注册 /tui-demo 命令：弹一个可用 ↑/↓ 选择、回车确认的面板，
 * 结束（回车）后把选择结果经 ctx.ui.notify 回显，便于 E2E 断言整条链路：
 * 面板出现 → 键盘选择 → 回车关闭 → 结果回显到聊天。
 *
 * 图形界面下 ctx.ui.custom 由 wa-pi-tui-host 扩展接管（真终端下走 pi 原生渲染），
 * 因此本桩只依赖 pi-tui 的 Component 契约（render / invalidate / handleInput）。
 * 只使用 import type，运行时不依赖任何 node_modules，可直接作为本地扩展加载。
 */
export default function (pi: ExtensionAPI) {
	pi.registerCommand("tui-demo", {
		description: "弹出 TUI 面板测试桩（方向键选择 + 回车）",
		handler: async (_args, ctx) => {
			const items = ["alpha", "beta", "gamma"];
			let index = 0;
			const picked = await ctx.ui.custom<string>(
				(_tui, _theme, _keybindings, done) => ({
					render: () => items.map((item, i) => `${i === index ? "▸" : " "} ${item}`),
					invalidate: () => {},
					handleInput: (data: string) => {
						// 方向键按 xterm 序列判定（与前端 lib/tui-keys.ts 的编码一致）
						if (data === "\u001b[B") index = Math.min(items.length - 1, index + 1);
						else if (data === "\u001b[A") index = Math.max(0, index - 1);
						else if (data === "\r") done(items[index]!);
					},
				}),
			);
			ctx.ui.notify(`tui-demo 选择：${String(picked)}`, "info");
		},
	});

	/**
	 * 键盘型编号选项对话框：与 pi-goal-x 的 goal-questionnaire（提案确认/问卷）同形——
	 * 编号选项 + 底部「Enter select」提示，**只实现 render/invalidate/handleInput**。
	 *
	 * 它没有 handleMouse，所以真终端里鼠标点击只会落到 pi-tui 的文本选择；
	 * 图形界面下由宿主（wa-pi-tui-host）把点击翻译成 ↑↓ + Enter（见
	 * packages/kernel/src/tui-host/click.ts）。上下文特意写成 30 行：帧高于面板视口，
	 * 断言 «滚到底后仍能点中选项行»（帧行 ≠ 可见行，行号必须带滚动偏移）。
	 */
	pi.registerCommand("tui-demo-options", {
		description: "弹出键盘型编号选项面板（验证点击 → 键盘回退）",
		handler: async (_args, ctx) => {
			const items = [
				"Confirm — create this goal now",
				"Continue chatting — keep refining",
				"Cancel — discard this draft",
			];
			const context = Array.from(
				{ length: 30 },
				(_, i) => ` context line ${i + 1}`,
			);
			let index = 0;
			const picked = await ctx.ui.custom<string>(
				(_tui, _theme, _keybindings, done) => ({
					render: () => [
						" Confirm Goal Draft",
						...context,
						"",
						...items.map(
							(it, i) => `${i === index ? "> " : "  "}${i + 1}. ${it}`,
						),
						"",
						" ↑↓ navigate • Enter select • Esc cancel",
					],
					invalidate: () => {},
					handleInput: (data: string) => {
						if (data === "\u001b[B") index = Math.min(items.length - 1, index + 1);
						else if (data === "\u001b[A") index = Math.max(0, index - 1);
						else if (data === "\r") done(`${index + 1} ${items[index] ?? ""}`);
					},
				}),
			);
			ctx.ui.notify(`tui-demo-options 选择：${String(picked)}`, "info");
		},
	});
}
