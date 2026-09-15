// wa-pi-tui-host.extension.ts —— WaPi 图形界面下的扩展 TUI 宿主（规格 §4）
//
// RPC 模式下接管 ctx.ui.custom / setWidget / onTerminalInput：把 pi-tui 面板渲染成
// 整帧文本行经 kernel 送给图形界面，并把前端输入按 panelId 路由回面板。
// 本文件由 deployTuiHostExtension() 连同 tui-host/ 目录复制到 GENERATED_DIR，
// 经 -e 注入 pi 进程（与 wa-pi-bridge 并行）。
import type {
	ExtensionAPI,
	KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, setCapabilities } from "@earendil-works/pi-tui";
import {
	connectInputChannel,
	createFrameSink,
	createFrameStream,
	createPanelBridge,
	patchUiForTuiHost,
	type PanelBridge,
} from "./tui-host/host.ts";

export default function (pi: ExtensionAPI): void {
	const bridgeUrl = process.env.WA_PI_BRIDGE_URL ?? "";
	const token = process.env.WA_PI_BRIDGE_TOKEN ?? "";
	const sessionId = process.env.WA_PI_SESSION_ID ?? "";
	if (!bridgeUrl || !token || !sessionId) return; // 子代理/无宿主环境：不接管

	// 帧出口是进程级的：断线/会话切换期间的帧先排队，重连或下一个会话 attach 时按序补发（规格 §8）。
	const sink = createFrameSink();
	// 当前会话的面板桥。可变引用：输入订阅流的回调每次都取当前 bridge，
	// 会话重建后输入才会路由到新 bridge（旧 bridge 已 disposeAll，不可逆）。
	let bridge: PanelBridge | null = null;

	// 帧流（规格 §5.1）：长连接把 NDJSON 帧写给 kernel。响应要等本连接结束才回来，
	// 所以实现里只 await 连接本身；断线按基准间隔重连，连续失败按指数退避（上限 5s）。
	const frameStream = createFrameStream({ bridgeUrl, token, sessionId, sink });
	// 输入订阅流（规格 §5.2）：kernel 把按键/粘贴/鼠标/尺寸/取消推回来，按 panelId 路由
	const inputChannel = connectInputChannel({
		bridgeUrl,
		token,
		sessionId,
		onEvent: (event) => bridge?.handleInput(event),
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "rpc") return;
		// SAFETY: ctx.ui 运行时就是 pi 的 ExtensionUIContext（具名方法集合），断言成 Record 只为写
		// patchUiForTuiHost 的形参类型；后者只重写 custom/setWidget/onTerminalInput 这几个它在
		// 运行期确实拥有的成员，不按任意键取值，所以这个断言丢的是成员类型信息而非真实约束。
		const ui = ctx.ui as unknown as Record<string, unknown> | undefined;
		if (!ui || typeof ui.custom !== "function") return;
		// 能力上报（规格 §4.2）：images:null 让依赖图片的组件走自身的文本占位降级，
		// trueColor / hyperlinks 对应前端 AnsiText 的 truecolor 与 OSC 8 链接解析。
		// 只在 rpc（图形界面）模式覆盖，别动真实终端下的自动探测结果。
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		// 两个流都跟着会话起停：session_shutdown（quit/new/fork/resume/reload）是扩展唯一
		// 的收尾时机，不停掉就会留下空转的重连定时器（start 可重入，不会建第二条连接）。
		frameStream.start();
		inputChannel.start();
		// 每个会话一个 bridge：disposeAll 不可逆（teardown 后它只会静默 resolve(undefined)），
		// 所以换会话/reload 后必须换新的。patchUiForTuiHost 按 bridge 实例判定幂等，
		// 因此能重新接管 pi reload 时复用的同一个 uiContext 对象（旧的已废 bridge 换掉）。
		bridge = createPanelBridge({
			sink,
			theme: ctx.ui.theme,
			// pi-tui 的 getKeybindings() 拿的是 pi 启动时 setKeybindings() 注入的实例
			// （interactive-mode 用 pi-coding-agent 的 KeybindingsManager 子类创建），
			// 但 pi-tui 只声明了基类类型，只能按 pi 的形参类型断言（panel.ts 同款处理）。
			// SAFETY: 运行期拿到的是 pi-tui KeybindingsManager 的子类实例，子类拥有基类的全部
			// 公开成员，差异只在基类/子类的私有字段；面板只调 matches/getKeys，故不会掩盖缺口。
			keybindings: getKeybindings() as unknown as KeybindingsManager,
		});
		patchUiForTuiHost(ui, bridge);
	});

	// 会话 teardown：结算所有排队/在开的面板，并停掉帧流/订阅流（规格 §4.8）。
	// 不结算就会留下挂起的 await custom()——历史上正是这类挂死让命令一直「思考中」。
	pi.on("session_shutdown", () => {
		bridge?.disposeAll();
		bridge = null;
		frameStream.stop();
		inputChannel.stop();
	});
}
