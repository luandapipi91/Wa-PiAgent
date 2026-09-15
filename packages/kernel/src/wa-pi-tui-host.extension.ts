// wa-pi-tui-host.extension.ts —— WaPi 图形界面下的扩展 TUI 宿主（规格 §4）
//
// RPC 模式下接管 ctx.ui.custom / setWidget / onTerminalInput：把 pi-tui 面板渲染成
// 整帧文本行经 kernel 送给图形界面，并把前端输入按 panelId 路由回面板。
// 本文件由 deployTuiHostExtension() 连同 tui-host/ 目录复制到 GENERATED_DIR，
// 经 -e 注入 pi 进程（与 wa-pi-bridge 并行）。
import type { ExtensionAPI, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { getKeybindings, setCapabilities } from "@earendil-works/pi-tui";
import {
	connectInputChannel,
	createFrameSink,
	createPanelBridge,
	patchUiForTuiHost,
	type PanelBridge,
} from "./tui-host/host.ts";

/** 帧流断开后的重连间隔 */
const FRAME_RETRY_MS = 1000;

export default function (pi: ExtensionAPI): void {
	const bridgeUrl = process.env.WA_PI_BRIDGE_URL ?? "";
	const token = process.env.WA_PI_BRIDGE_TOKEN ?? "";
	const sessionId = process.env.WA_PI_SESSION_ID ?? "";
	if (!bridgeUrl || !token || !sessionId) return; // 子代理/无宿主环境：不接管

	const sink = createFrameSink();

	// 帧流（规格 §5.1）：长连接把 NDJSON 帧写给 kernel。响应要等本连接结束才回来，
	// 所以只 await 连接本身。断线后按固定间隔重连（本地回环，失败通常只是 kernel 重启
	// 或会话刚起步，不需要指数退避）；断线期间的帧留在 sink 队列里（规格 §8）。
	const startFrameStream = async (): Promise<void> => {
		const encoder = new TextEncoder();
		let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
				// 首行鉴权：kernel 读到 token/sessionId 后才把后续行当帧处理
				c.enqueue(encoder.encode(`${JSON.stringify({ token, sessionId })}\n`));
			},
		});
		sink.attach((line) => {
			try {
				controller?.enqueue(encoder.encode(`${line}\n`));
			} catch {
				// 连接已关：本帧丢弃，重连后 attach 会补发随后入队的帧
			}
		});
		try {
			const res = await fetch(`${bridgeUrl}/bridge/tui-host/frames`, {
				method: "POST",
				// 流式请求体（Bun 1.4.2 实测可用）；duplex 是流式 body 的规范要求，DOM 类型里尚未收录
				duplex: "half",
				headers: { "content-type": "application/x-ndjson" },
				body,
			} as RequestInit);
			// 非 2xx（如 token 过期）要读掉响应体释放连接，之后仍然走重连
			if (!res.ok) await res.text().catch(() => "");
		} catch {
			// 连接失败：交给下面的重连
		}
		sink.detach();
		setTimeout(() => void startFrameStream(), FRAME_RETRY_MS);
	};
	void startFrameStream();

	// 输入订阅流（规格 §5.2）：kernel 把按键/粘贴/鼠标/尺寸/取消推回来，按 panelId 路由
	let bridge: PanelBridge | null = null;
	connectInputChannel({
		bridgeUrl,
		token,
		sessionId,
		onEvent: (event) => bridge?.handleInput(event),
	}).start();

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "rpc") return;
		const ui = ctx.ui as unknown as Record<string, unknown> | undefined;
		if (!ui || typeof ui.custom !== "function") return;
		// 能力上报（规格 §4.2）：images:null 让依赖图片的组件走自身的文本占位降级，
		// trueColor / hyperlinks 对应前端 AnsiText 的 truecolor 与 OSC 8 链接解析。
		// 只在 rpc（图形界面）模式覆盖，别动真实终端下的自动探测结果。
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		bridge ??= createPanelBridge({
			sink,
			theme: ctx.ui.theme,
			// pi-tui 的 getKeybindings() 拿的是 pi 启动时 setKeybindings() 注入的实例
			// （interactive-mode 用 pi-coding-agent 的 KeybindingsManager 子类创建），
			// 但 pi-tui 只声明了基类类型，只能按 pi 的形参类型断言（panel.ts 同款处理）。
			keybindings: getKeybindings() as unknown as KeybindingsManager,
		});
		patchUiForTuiHost(ui, bridge);
	});

	// 会话 teardown：结算所有排队/在开的面板并在 kernel 侧收尾（规格 §4.8）。
	// 不结算就会留下挂起的 await custom()——历史上正是这类挂死让命令一直「思考中」。
	pi.on("session_shutdown", () => {
		bridge?.disposeAll();
		bridge = null;
	});
}
