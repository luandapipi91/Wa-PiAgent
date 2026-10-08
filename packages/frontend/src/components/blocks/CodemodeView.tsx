// CodemodeView — codemode 工具调用的专属渲染。
// 脚本复用 CodeBlockCard（Prism javascript 高亮/行号/复制/折叠）；
// 结果按 pi codemode 输出协议解析：==> text N/M <== 为分隔行不渲染、
// <console_output> 块独立小节、image 块渲染为 <img>（通用路径会丢弃它）。
import type { ToolResultMessage } from "@wa-pi/shared";
import { CodeBlockCard } from "./CodeBlockCard";
import { useTranslation } from "../../i18n/useTranslation";

const CONSOLE_BLOCK_RE = /<console_output>\n?([\s\S]*?)<\/console_output>/;
const STATUS_LINE_RE = /^(Script (?:completed|failed)[^\n]*)\n?/;

/** 提取结果头部状态行（Script completed/failed + 耗时）；无则 null */
export function parseScriptStatus(output: string): string | null {
	const m = output.match(STATUS_LINE_RE);
	return m ? m[1] : null;
}

/** 拆分输出文本项：先剥头部状态行，==> text N/M <== 为分隔行（不渲染）；console 块已先剥离 */
export function splitOutputItems(output: string): string[] {
	const withoutConsole = output.replace(CONSOLE_BLOCK_RE, "").trim();
	if (!withoutConsole) return [];
	const withoutStatus = withoutConsole.replace(STATUS_LINE_RE, "").trim();
	if (!withoutStatus) return [];
	return withoutStatus
		.split(/^==> text \d+\/\d+ <==$/m)
		.map((s) => s.trim())
		.filter(Boolean);
}

/** 提取 <console_output> 块正文；无块返回 null */
export function extractConsole(output: string): string | null {
	const m = output.match(CONSOLE_BLOCK_RE);
	return m ? m[1].trim() : null;
}

/** 脚本参数：复用 CodeBlockCard（高亮/行号/复制/折叠） */
export function CodemodeScriptView({ code }: { code: string }) {
	const { t } = useTranslation();
	return (
		<div className="mt-1">
			<div className="text-xs text-tertiary mb-0.5">
				{t("blocks.toolCall.codemode.script", {
					lines: code === "" ? 0 : code.split("\n").length,
				})}
			</div>
			<CodeBlockCard language="javascript" code={code} />
		</div>
	);
}

/** 结果：文本项顺序渲染 + image 块 <img> + console 独立小节。成功/失败色调由
 *  ToolCallCard 的结果容器（border-t + text-success/danger）承载，此处不重复包边框。 */
export function CodemodeResultView({
	result,
	failed,
}: {
	result: ToolResultMessage;
	failed: boolean;
}) {
	const { t } = useTranslation();
	void failed; // 色调由容器承载；保留参数与 ToolCallCard 分支签名对齐
	// 每个文本项独立成块：pi 1.0.0 会把状态头与脚本输出拆成多个 text 项下发，
	// join 后渲染会把它们糊成一坨（嵌套工具卡「两段内容分别成块」契约）
	const textItems = result.content
		.filter((c) => c.type === "text")
		.map((c) => (c as { text: string }).text);
	const output = textItems.join("\n");
	const status = parseScriptStatus(output);
	const items = textItems.flatMap((t) => splitOutputItems(t));
	const consoleOut = extractConsole(output);
	const images = result.content.filter((c) => c.type === "image") as {
		data: string;
		mimeType: string;
	}[];
	return (
		<div>
			{status && (
				<div className="text-xs text-tertiary font-mono" data-testid="codemode-status">
					{status}
				</div>
			)}
			{items.map((item, i) => (
				<div key={i} className="whitespace-pre-wrap break-words">
					{item}
				</div>
			))}
			{images.map((img, i) => (
				<img
					key={i}
					src={`data:${img.mimeType};base64,${img.data}`}
					alt={`codemode-image-${i + 1}`}
					className="max-w-full rounded border border-hairline mt-1"
				/>
			))}
			{consoleOut && (
				<div className="mt-1" data-testid="codemode-console">
					<div className="text-xs text-tertiary">
						{t("blocks.toolCall.codemode.console")}
					</div>
					<pre className="text-xs text-tertiary whitespace-pre-wrap break-words max-h-[180px] overflow-auto font-mono">
						{consoleOut}
					</pre>
				</div>
			)}
		</div>
	);
}
