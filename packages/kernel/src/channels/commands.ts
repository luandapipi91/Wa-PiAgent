/** IM 侧斜杠指令解析：命中即在 ChannelManager 层拦截，不进智能体 */

export interface CommandContext {
	projects: { id: string; name: string }[];
	currentProjectId: string;
}

export interface CommandResult {
	handled: boolean;
	reply?: string;
	switchProjectId?: string;
	resetSession?: boolean;
}

const HELP =
	"可用指令：\n/new 开始新会话\n/projects 列出可用工作区\n/use <工作区名> 切换工作区\n/help 查看帮助";

export function parseCommand(text: string, ctx: CommandContext): CommandResult {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return { handled: false };
	const [cmd, ...rest] = trimmed.split(/\s+/);
	const arg = rest.join(" ").trim();
	const projectList = ctx.projects
		.map((p) => `${p.id === ctx.currentProjectId ? "（当前）" : ""}${p.name}`)
		.join("\n");

	switch (cmd) {
		case "/new":
			return { handled: true, resetSession: true, reply: "已开始新会话。" };
		case "/projects":
			return { handled: true, reply: `可用工作区：\n${projectList}` };
		case "/use": {
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
			return { handled: true, reply: HELP };
		default:
			return { handled: true, reply: `未知指令 ${cmd}。\n${HELP}` };
	}
}
