/** IM 侧斜杠指令解析：命中即在 ChannelManager 层拦截，不进智能体 */

export interface CommandContext {
	projects: { id: string; name: string }[];
	currentProjectId: string;
	/** 是否允许切换工作目录（来自 channel.allowProjectSwitch）；false 时 /use、/projects 被禁用 */
	allowSwitch: boolean;
}

export interface CommandResult {
	handled: boolean;
	reply?: string;
	switchProjectId?: string;
	resetSession?: boolean;
}

const HELP_FULL =
	"可用指令：\n/new 开始新会话\n/projects 列出可用工作区\n/use <工作区名> 切换工作区\n/help 查看帮助";
const HELP_NO_SWITCH =
	"可用指令：\n/new 开始新会话\n/help 查看帮助";
const REJECT_SWITCH = "该机器人不支持切换工作目录。";

export function parseCommand(text: string, ctx: CommandContext): CommandResult {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return { handled: false };
	const [cmd, ...rest] = trimmed.split(/\s+/);
	const arg = rest.join(" ").trim();
	const help = ctx.allowSwitch ? HELP_FULL : HELP_NO_SWITCH;
	const projectList = ctx.projects
		.map((p) => `${p.id === ctx.currentProjectId ? "（当前）" : ""}${p.name}`)
		.join("\n");

	switch (cmd) {
		case "/new":
			return { handled: true, resetSession: true, reply: "已开始新会话。" };
		case "/projects":
			if (!ctx.allowSwitch) return { handled: true, reply: REJECT_SWITCH };
			return { handled: true, reply: `可用工作区：\n${projectList}` };
		case "/use": {
			if (!ctx.allowSwitch) return { handled: true, reply: REJECT_SWITCH };
			const hit = ctx.projects.find((p) => p.name === arg);
			if (!hit) {
				return {
					handled: true,
					reply: `未找到工作区「${arg}」。可用工作区：\n${projectList}`,
				};
			}
			return {
				handled: true,
				switchProjectId: hit.id,
				reply: `已切换到工作区：${hit.name}`,
			};
		}
		case "/help":
			return { handled: true, reply: help };
		default:
			return { handled: true, reply: `未知指令 ${cmd}。\n${help}` };
	}
}
