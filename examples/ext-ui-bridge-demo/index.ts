import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/**
 * ext-ui-bridge-demo —— WaPi UI 桥接测试桩。
 *
 * 覆盖四类 fire-and-forget 扩展 UI 请求（kernel rpc-client 桥接为 sdk:event）：
 *   notify    → extension_notify  → 前端 toast（永久保留 + ANSI 颜色解析）
 *   setStatus → extension_status  → 聊天列底部状态栏（ANSI 颜色解析）
 *   setWidget → extension_widget  → Composer 上/下方可折叠文本块（ANSI 颜色解析）
 *   setTitle  → extension_title   → 聊天窗顶部状态条（ANSI 颜色解析）
 *
 * 另覆盖请求-应答类子协议（kernel extension_dialog 广播 + 前端应答）：
 *   select/confirm/input/editor → 前端 ExtensionDialog 弹窗
 *   setEditorText               → extension_editor_text → Composer 注入
 *
 * 仅使用 import type，运行时不依赖任何 node_modules，可直接作为本地扩展加载。
 */

type AnyCtx = ExtensionContext | ExtensionCommandContext;

/**
 * 长正文 select 的提示文本：**逐字复刻 pi-goal-x 的 buildDraftConfirmationText**
 * （goal-draft.ts:34 的 formatPrefixedLines：空行整行丢掉、其余每行加 `│   ` 前缀；
 * formatSection 输出 ["", "─── X ───", "", ...body]）。目标正文里带 markdown 表格，
 * 用来验证「被前缀挡住 + 空行被丢掉」之后表格仍能渲染成真 <table>。
 */
function longDraftPrompt(): string {
	const objective = [
		"【目标概述】本次目标为「测试任务」综合功能演示项目，核心目的是对桌面助手的任务管理（todo）与目标管理（goal）两大工具链进行一次系统、完整、可追溯的端到端验证。",
		"",
		"【成功标准】",
		"",
		"| 阶段 | 产出 | 验证方式 |",
		"| --- | --- | --- |",
		"| 一 | 验证报告 | 报告文件存在且内容完整 |",
		"| 二 | 执行记忆 | 归档记录可查、可回溯 |",
		"",
		"**边界范围**：仅限演示流程，不改生产代码。**硬性约束**：每一步都要可回看、可复现。",
	];
	// pi-goal-x formatPrefixedLines：空行丢掉，其余加 `│   ` 前缀
	const prefixed = objective
		.filter((l) => l.trim())
		.map((l) => (l.trim().startsWith("│") ? l : `│   ${l}`));
	// formatSection：前后各留一个空行
	const section = (title: string, body: string[]) => ["", `─── ${title} ───`, "", ...body];
	return [
		"● Goal draft ready for confirmation.",
		"",
		"─── Draft Details ───",
		"│   Mode: Normal goal",
		"│   Auto-continue: yes",
		...section("Original Topic", []),
		...section("Proposed Goal", prefixed),
		"",
		"┌─ TASKS ──────────────────────────────┐",
		"│ [ ] task-1：确认 goal 契约            │",
		"│ [ ] task-2：执行任务流并记录状态流转  │",
		"└──────────────────────────────────────┘",
	].join("\n");
}

/** 一次触发全部四类 UI 请求。 */
function fireAll(ctx: AnyCtx) {
	ctx.ui.notify("ext-ui-bridge-demo: notify 测试消息", "info");
	ctx.ui.setStatus("ui-demo", "ui-demo 状态条 · 运行中");
	ctx.ui.setWidget("ui-demo-above", [
		"── UI Bridge Demo ──",
		"setWidget(aboveEditor) 第 2 行",
		"setWidget(aboveEditor) 第 3 行（多行用于验证折叠摘要）",
	]);
	ctx.ui.setWidget("ui-demo-below", ["setWidget(belowEditor) 单行"], {
		placement: "belowEditor",
	});
	ctx.ui.setTitle("UI Demo 标题");
}

/** 清除 setStatus / setWidget（setTitle / notify 为一次性，无需清除）。 */
function clearAll(ctx: AnyCtx) {
	ctx.ui.setStatus("ui-demo", undefined);
	ctx.ui.setWidget("ui-demo-above", undefined);
	ctx.ui.setWidget("ui-demo-below", undefined);
	ctx.ui.setStatus("ui-demo-color", undefined);
	ctx.ui.setWidget("ui-demo-color-above", undefined);
}

export default function (pi: ExtensionAPI) {
	// 每个会话启动时自动触发一次，打开会话即可看到四类 UI 效果
	pi.on("session_start", (_event, ctx) => {
		fireAll(ctx);
	});

	// 手动触发命令（需在「扩展 → 命令」里开启后才能用 /uidemo 调用）
	pi.registerCommand("uidemo", {
		description: "UI 桥接测试桩：/uidemo all|notify|status|widget|title|color|clear|select|select-long|confirm|input|editor|seteditor",
		getArgumentCompletions: (prefix) =>
			["all", "notify", "status", "widget", "title", "color", "clear", "select", "select-long", "confirm", "input", "editor", "seteditor"]
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			switch (args.trim()) {
				case "notify":
					ctx.ui.notify("ext-ui-bridge-demo: 手动 notify（warning）", "warning");
					break;
				case "status":
					ctx.ui.setStatus(
						"ui-demo",
						`手动 setStatus · ${new Date().toLocaleTimeString()}`,
					);
					break;
				case "widget":
					ctx.ui.setWidget("ui-demo-above", [
						"手动 setWidget(aboveEditor)",
						`触发时间 ${new Date().toLocaleTimeString()}`,
					]);
					break;
				case "title":
					ctx.ui.setTitle("手动 setTitle");
					break;
				case "color":
					// 一键触发全部彩色 UI：验证 ANSI SGR 颜色码经 kernel 透传、前端 AnsiText 解析
					ctx.ui.notify("\x1b[38;5;214m橙色 notify\x1b[39m 普通文字", "warning");
					ctx.ui.setStatus("ui-demo-color", "\x1b[32m绿色状态\x1b[39m · \x1b[38;5;39m蓝色运行中\x1b[39m");
					ctx.ui.setWidget("ui-demo-color-above", [
						"\x1b[31m红色行\x1b[39m",
						"\x1b[32m绿色行\x1b[39m",
						"\x1b[33m黄色行\x1b[39m",
						"\x1b[34m蓝色行\x1b[39m",
						"\x1b[38;5;214m256色橙色行\x1b[39m",
					]);
					ctx.ui.setTitle("\x1b[38;5;39m彩色 UI Demo 标题\x1b[39m");
					break;
				case "clear":
					clearAll(ctx);
					ctx.ui.notify("ext-ui-bridge-demo: 已清除 status/widget", "info");
					break;
				case "select-long": {
					// 长正文 select：复刻 pi-goal-x 提案确认的正文体量（数十行），
					// 验证「正文再长，选项与按钮也得留在视野内」。
					const v = await ctx.ui.select(longDraftPrompt(), [
						"1. Confirm — create this goal now (Recommended)",
						"2. Continue chatting — keep refining",
						"3. Cancel — discard this draft",
					]);
					ctx.ui.notify(`select-long 结果: ${String(v)}`, "info");
					break;
				}
				case "select":
					{
						const v = await ctx.ui.select("demo select：选一个", ["甲", "乙", "丙"]);
						ctx.ui.notify(`select 结果: ${String(v)}`, "info");
					}
					break;
				case "confirm":
					{
						const ok = await ctx.ui.confirm("demo confirm", "确认继续吗？");
						ctx.ui.notify(`confirm 结果: ${ok}`, "info");
					}
					break;
				case "input":
					{
						const v = await ctx.ui.input("demo input", "随便输入点什么");
						ctx.ui.notify(`input 结果: ${String(v)}`, "info");
					}
					break;
				case "editor":
					{
						const v = await ctx.ui.editor("demo editor", "预填内容\n第二行");
						ctx.ui.notify(`editor 结果: ${String(v)}`, "info");
					}
					break;
				case "seteditor":
					ctx.ui.setEditorText("来自 set_editor_text 的文本");
					break;
				case "all":
				default:
					fireAll(ctx);
					break;
			}
		},
	});
}
