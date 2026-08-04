import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/**
 * ext-ui-bridge-demo —— WaPi UI 桥接测试桩。
 *
 * 覆盖四类 fire-and-forget 扩展 UI 请求（kernel rpc-client 桥接为 sdk:event）：
 *   notify    → extension_notify  → 前端 toast
 *   setStatus → extension_status  → 聊天列底部状态栏
 *   setWidget → extension_widget  → Composer 上/下方可折叠文本块
 *   setTitle  → extension_title   → 聊天窗顶部状态条
 *
 * 仅使用 import type，运行时不依赖任何 node_modules，可直接作为本地扩展加载。
 */

type AnyCtx = ExtensionContext | ExtensionCommandContext;

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
}

export default function (pi: ExtensionAPI) {
	// 每个会话启动时自动触发一次，打开会话即可看到四类 UI 效果
	pi.on("session_start", (_event, ctx) => {
		fireAll(ctx);
	});

	// 手动触发命令（需在「扩展 → 命令」里开启后才能用 /uidemo 调用）
	pi.registerCommand("uidemo", {
		description: "UI 桥接测试桩：/uidemo all|notify|status|widget|title|clear",
		getArgumentCompletions: (prefix) =>
			["all", "notify", "status", "widget", "title", "clear"]
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
				case "clear":
					clearAll(ctx);
					ctx.ui.notify("ext-ui-bridge-demo: 已清除 status/widget", "info");
					break;
				case "all":
				default:
					fireAll(ctx);
					break;
			}
		},
	});
}
