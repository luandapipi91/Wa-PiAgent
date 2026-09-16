import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/**
 * ext-error-spam-demo —— 扩展错误测试桩。
 *
 * 目的：一次性向「系统设置 > 诊断」的扩展错误列表（内存态，最近 50 条）灌满 50 条
 * extension_error，用于回归 DiagnosticsSection 的满列表渲染、截断、清空、滚动表现。
 *
 * 机制约束（kernel 现状，决定了本桩的形态）：
 *   - 扩展在事件 handler 中抛错，kernel runner 会 try/catch 并 emitError 一条
 *     （runner.js:emitInput 对同一事件的多个 handler 逐个独立捕获）。
 *   - 命令 handler 抛错只算 1 条（agent-session.js:_tryExecuteExtensionCommand
 *     整体 try/catch），故「单命令凑 50 条」无法靠命令自身抛错实现。
 *   - 扩展无法主动 emit 事件 / 注销 handler，只能靠状态开关 + 一次性标志位控制。
 *
 * 形态：注册 50 个 input handler（用户每发一条消息都会触发 emitInput）。
 *   /exterr fire  → 装填（armed=true，全部 fired=false），notify 提示发任意消息触发
 *   发任意一条消息 → 50 个 handler 各抛一条带编号的错 → 列表正好 +50 条
 *   /exterr off   → 卸装（armed=false），handler 遍历空转
 *   /exterr reset → 重新装填（清空 fired 标志，配合 fire 再来一轮）
 *
 * 区分度：error 文案 50 种编号（#01..#50）+ 场景描述；event 字段 kernel 固定为 "input"。
 *
 * 仅使用 import type，运行时不依赖任何 node_modules，可直接作为本地扩展加载。
 */

type AnyCtx = ExtensionContext | ExtensionCommandContext;

/** 装填开关：true 时已 fire，等待/响应下一条用户消息。 */
let armed = false;

/** 每个 handler 的一次性标志：抛过一次即停，保证一条消息正好产生 50 条。 */
const firedFlags: boolean[] = new Array(50).fill(false);

/** 50 个错误场景文案（编号 + 场景，供渲染区分度验证）。 */
const SCENARIOS: readonly string[] = [
	"空指针解引用",
	"越界访问 list[50]",
	"JSON 解析失败",
	"网络连接超时",
	"认证 token 过期",
	"文件不存在",
	"权限被拒绝",
	"磁盘空间不足",
	"内存分配失败",
	"类型断言失败",
	"正则回溯爆炸",
	"死锁等待锁",
	"信号量耗尽",
	"配置项缺失",
	"环境变量未定义",
	"端口已被占用",
	"进程已退出",
	"管道破裂",
	"校验和 mismatch",
	"版本不兼容",
	"重复键冲突",
	"外键约束失败",
	"事务回滚",
	"死循环检测",
	"栈溢出",
	"整数溢出",
	"浮点精度丢失",
	"编码转换错误",
	"乱码 UTF-8 序列",
	"压缩解压失败",
	"证书校验失败",
	"TLS 握手中断",
	"DNS 解析失败",
	"代理转发异常",
	"限流触发 429",
	"服务端 500",
	"网关 502",
	"熔断器打开",
	"重试次数耗尽",
	"请求体过大",
	"响应被截断",
	"WebSocket 断开",
	"SSE 流中断",
	"心跳超时",
	"会话已失效",
	"并发竞态",
	"资源已释放",
	"状态机非法迁移",
	"不变量被破坏",
	"未知致命错误",
];

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

export default function (pi: ExtensionAPI) {
	// 注册 50 个 input handler：armed 且未 fired 时抛带编号的错。
	// handler 抛错被 runner 独立 try/catch → 50 条 extension_error。
	for (let i = 0; i < 50; i++) {
		const idx = i;
		pi.on("input", () => {
			if (!armed || firedFlags[idx]) return;
			firedFlags[idx] = true;
			throw new Error(
				`模拟扩展错误 #${pad2(idx + 1)}/50: ${SCENARIOS[idx]}`,
			);
		});
	}

	pi.registerCommand("exterr", {
		description:
			"扩展错误测试桩：/exterr fire|off|reset|status|one",
		getArgumentCompletions: (prefix) =>
			["fire", "off", "reset", "status", "one"]
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s })),
		handler: async (args, ctx: AnyCtx) => {
			switch (args.trim()) {
				case "fire":
					armed = true;
					firedFlags.fill(false);
					ctx.ui.notify(
						"ext-error-spam-demo: 已装填 50 条错误，发任意一条消息触发（一轮正好 50 条）",
						"info",
					);
					break;
				case "off":
					armed = false;
					ctx.ui.notify("ext-error-spam-demo: 已卸装，不再产生错误", "info");
					break;
				case "reset":
					firedFlags.fill(false);
					ctx.ui.notify(
						armed
							? "ext-error-spam-demo: 已重新装填，发任意消息触发"
							: "ext-error-spam-demo: fired 标志已清空（armed=false，需先 /exterr fire）",
						"info",
					);
					break;
				case "status":
					{
						const left = firedFlags.filter((f) => !f).length;
						ctx.ui.notify(
							`ext-error-spam-demo: armed=${armed}，本轮剩余 ${left}/50`,
							"info",
						);
					}
					break;
				// 命令级错误：handler 直接 throw，pi 的 _tryExecuteExtensionCommand
				// 整体 try/catch 捕获为 1 条 extension_error（event:"command"，
				// extensionPath:"command:exterr"），与 input handler 路径（event:"input"）区分。
				case "one":
					throw new Error("模拟命令级扩展错误（/exterr one）");
				default:
					ctx.ui.notify(
						"ext-error-spam-demo: 用法 /exterr fire|off|reset|status|one",
						"warning",
					);
					break;
			}
		},
	});
}
