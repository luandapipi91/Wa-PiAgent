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
	 * 回显型面板：把每次 handleInput 收到的 data 原样追加成一行帧，回车结束。
	 *
	 * 用途：验证「输入真的送到面板并被插件消费」——尤其是输入法上屏的中文整串，
	 * 上屏后应作为一条 data 进来、并在帧上原样可见（E2E 断言帧里出现该中文）。
	 */
	pi.registerCommand("tui-demo-echo", {
		description: "回显型面板测试桩（输入逐条回显，回车结束）",
		handler: async (_args, ctx) => {
			const received: string[] = [];
			const picked = await ctx.ui.custom<string>(
				(_tui, _theme, _keybindings, done) => ({
					render: () => [
						" Echo Panel（输入回显；回车结束）",
						"",
						...received.map((d) => `echo: ${d}`),
					],
					invalidate: () => {},
					handleInput: (data: string) => {
						if (data === "\r") {
							done("echo-done");
							return;
						}
						received.push(data);
					},
				}),
			);
			ctx.ui.notify(`tui-demo-echo 结束：${String(picked)}`, "info");
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

	/**
	 * 真实输入框桩：一个可编辑的单行输入框（不是「按键回显」）。
	 *
	 * 用于验证输入法在真实编辑语义下是否正常：组词中的拼音不得进入输入框的值、
	 * 选词后整串落进值、退格/左右键能编辑、**光标跟随**（候选框贴真实输入位置）。
	 *
	 * 光标：在渲染行里插入 pi-tui 的 CURSOR_MARKER（APC 序列 `ESC _ pi:c BEL`），
	 * TUI 把它抽成帧光标（kernel 侧见 packages/kernel/src/tui-host/frame.ts），
	 * 图形界面下前端据此把 IME 落点与候选框定位到真实输入位置。
	 * 这里硬编码该常量，免得桩在运行期依赖 node_modules（本桩只用 import type）。
	 */
	pi.registerCommand("tui-demo-input", {
		description: "真实输入框桩（编辑 / 退格 / ←→ / Enter 提交）",
		handler: async (_args, ctx) => {
			const CURSOR_MARKER = "\u001b_pi:c\u0007";
			const seg = new Intl.Segmenter("zh", { granularity: "grapheme" });
			const split = (s: string) => [...seg.segment(s)].map((g) => g.segment);
			let value = "";
			let cursor = 0; // 光标在 value 里的 grapheme 下标
			const picked = await ctx.ui.custom<string>(
				(_tui, _theme, _keybindings, done) => ({
					render: () => {
						const gs = split(value);
						return [
							" Input Demo（真实输入框：←→ 移光标 / 退格 / Enter 提交 / Esc 取消）",
							"",
							` 输入：${gs.slice(0, cursor).join("")}${CURSOR_MARKER}${gs.slice(cursor).join("")}`,
							"",
							" 打中文：组词中的拼音不进入输入框，选词后整串落进值（中文占 2 列）",
						];
					},
					invalidate: () => {},
					handleInput: (data: string) => {
						if (data === "\u001b") {
							done("");
							return;
						}
						if (data === "\r") {
							done(value);
							return;
						}
						if (data === "\u007f") {
							if (cursor > 0) {
								const gs = split(value);
								gs.splice(cursor - 1, 1);
								value = gs.join("");
								cursor -= 1;
							}
							return;
						}
						if (data === "\u001b[D") {
							cursor = Math.max(0, cursor - 1);
							return;
						}
						if (data === "\u001b[C") {
							cursor = Math.min(split(value).length, cursor + 1);
							return;
						}
						if (data === "\u001b[H") {
							cursor = 0;
							return;
						}
						if (data === "\u001b[F") {
							cursor = split(value).length;
							return;
						}
						// 未识别的转义序列与控制字符（Tab 等）不进值
						if (data.includes("\u001b")) return;
						if ([...data].some((c) => c.charCodeAt(0) < 32)) return;
						// 其余整串插到光标处：IME 上屏的中文、粘贴的文本都走这里
						const ins = split(data);
						const gs = split(value);
						gs.splice(cursor, 0, ...ins);
						value = gs.join("");
						cursor += ins.length;
					},
				}),
			);
			ctx.ui.notify(`tui-demo-input 提交：${String(picked) || "（空）"}`, "info");
		},
	});
}
