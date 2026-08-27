/** 端口解析：合法正整数用之，否则用默认。 */
export function resolvePort(envVal: string | undefined, def: number): number {
	const n = Number(envVal);
	return Number.isFinite(n) && n > 0 ? n : def;
}

// 兼容浏览器（vite import.meta.env / 无 process 全局）与 Node/Bun（process.env）
// 浏览器 bundle 里 process 是 undefined；vite 通过 vite.config.ts 的 define 把
// process.env.WA_PI_DIR 等静态替换为构建时值（E2E 隔离目录用）。
// 但 typeof process 判断在替换前已求值为 "undefined"，所以这里双源读取兜底。
const nodeEnv = typeof process === "undefined" ? {} : process.env;
// import.meta.env 浏览器（vite）才有；Node/Bun 下 import.meta.env 为 undefined，由 && 兜底
const browserEnv =
	typeof import.meta !== "undefined" && (import.meta as any).env
		? (import.meta as any).env
		: {};
const env = { ...nodeEnv, ...browserEnv };
const HOME = env.HOME || env.USERPROFILE || ".";
/** kernel HTTP 端口（原 WS 端口，去 WS 化后仅用于 HTTP + SSE）；可通过 WA_PI_WS_PORT 覆盖 */
export const WS_PORT = resolvePort(env.WA_PI_WS_PORT, 9776);
export const PREVIEW_PORT = resolvePort(env.WA_PI_PREVIEW_PORT, 9777);
/** 前端 dev 端口（Vite）；desktop 不用（走同源 9776）。 */
export const FRONTEND_PORT = resolvePort(env.WA_PI_WEB_PORT, 5180);
/** wa-pi 数据目录（默认复用 Pi 框架自带 ~/.pi/agent），可用 WA_PI_DIR 环境变量覆盖。 */
export const WA_PI_DIR = env.WA_PI_DIR || `${HOME}/.pi/agent`;
export const PROJECTS_FILE = `${WA_PI_DIR}/projects.json`;
export const PI_AGENTS_DIR = `${WA_PI_DIR}/agents`;
export const PROVIDERS_FILE = `${WA_PI_DIR}/providers.json`;
export const PROMPTS_FILE = `${WA_PI_DIR}/prompts.json`; // 系统提示词段落配置（顺序+内容），启动时若无则初始化默认值
export const SUBAGENT_OVERRIDES_FILE = `${WA_PI_DIR}/subagent-overrides.json`; // 内置 subagent 的 model/thinking 覆盖
export const GENERATED_DIR = `${WA_PI_DIR}/.generated`; // 自动生成的 Pi extension 文件目录
export const BUILTIN_SKILLS_DIR = `${WA_PI_DIR}/skills`; // 内置技能目录，kernel 启动时创建，不可删
export const CHANNELS_FILE = `${WA_PI_DIR}/channels.json`; // IM 渠道机器人配置
export const CHANNEL_SESSIONS_FILE = `${WA_PI_DIR}/channel-sessions.json`; // IM 会话→hiagent 会话映射
export const CHANNEL_TMP_DIR = `${WA_PI_DIR}/tmp/channels`; // 渠道图片等临时文件
// 以下两个旧 JSON 常量仅迁移读取用（migrateLegacySchedulerFiles 一次性迁移后归档 .migrated）；
// 新数据全部全局存于 WA_PI_DIR/scheduled-tasks/（任务定义 + CLI + 执行记录）
export const SCHEDULED_TASKS_FILE = `${WA_PI_DIR}/scheduled-tasks.json`; // 定时任务配置（仅迁移读取用）
export const EXECUTION_RECORDS_FILE = `${WA_PI_DIR}/execution-records.json`; // 定时任务执行记录（仅迁移读取用）

// 定时任务资产文件名/目录名常量（供 system-prompt 文案、scheduler-assets 分发引用，避免魔法字符串漂移）
export const SCHEDULED_TASKS_DIR_NAME = "scheduled-tasks"; // 全局存放根目录名（WA_PI_DIR/<此名>/）
export const CRON_CLI_FILE = "cron-task.ts"; // 定时任务 CLI 文件名
export const SCHEDULED_TASKS_README_FILE = "README.md"; // 定时任务说明文件名
export const SCHEDULED_TASKS_TASKS_DIR = "tasks"; // 任务定义子目录名
export const SCHEDULED_TASKS_LOGS_DIR = "logs"; // 执行日志子目录名
export const KERNEL_INFO_FILE = `${WA_PI_DIR}/kernel.json`; // kernel 端口/pid 信息，CLI 发现 kernel 用
export const CONTACTS_FILE = `${WA_PI_DIR}/contacts.json`; // 企微机器人通讯录（对话过的人/群）

// ===== 默认工作区（虚拟系统项目）=====
// 一个常驻、不可删除/改名的虚拟项目，作为"没有具体工程目录时的默认聊天空间"。
// 该项目下的每个会话有独立 cwd（~/.pi/agent/workdir/<session.createdAt>/），
// 详见 resolveSessionCwd 纯函数（pure.ts）。
export const SYSTEM_PROJECT_ID = "__system__";
export const SYSTEM_PROJECT_NAME = "默认工作区";
export const SYSTEM_PROJECT_CWD = `${WA_PI_DIR}/workdir`;
// 默认工作区会话被删除后，对应的 <createdAt>/ 子目录保留天数；超时后由 workdir-cleaner 清理
export const WORKDIR_TTL_DAYS = 7;

// ===== 内置 subagent 类型（pi-subagents 自带，不可删除/编辑）=====
// LLM 可在 delegate 工具的 agent 参数中传这些类型名，调起匿名 subagent。
// spawn 走 svc.spawn(type, prompt)：type 由 pi-subagents registry 解析为内置 agent 配置。
// - general-purpose：继承调用者全部工具（builtinToolNames 未设置）
// - Explore：read-only 探索（builtinToolNames = ["read","bash","grep","find","ls"]）
// - Plan：read-only 规划（代码架构师，探索并设计实施方案）
export interface SubagentTypeDef {
	/** 类型名（传给 svc.spawn 的第一个参数，大小写敏感） */
	name: string;
	/** 显示名（前端卡片展示 + @ token 插入 + delegate 接受的别名） */
	displayName: string;
	/** 简介（前端卡片展示） */
	description: string;
	/** emoji 图标 */
	emoji: string;
	/** 头像渐变色 */
	gradient: [string, string];
	/** 是否只读（true = 只能探索不能改文件） */
	readOnly: boolean;
}

export const SUBAGENT_TYPES: SubagentTypeDef[] = [
	{
		name: "general-purpose",
		displayName: "通用子智能体",
		description: "继承调用者的全部工具，执行复杂多步任务。",
		emoji: "🤖",
		gradient: ["#4b5563", "#6b7280"],
		readOnly: false,
	},
	{
		name: "Explore",
		displayName: "探索子智能体",
		description: "只读代码探索，快速搜索和理解代码库结构。",
		emoji: "🔍",
		gradient: ["#0891b2", "#06b6d4"],
		readOnly: true,
	},
	{
		name: "Plan",
		displayName: "规划子智能体",
		description: "只读代码架构师，探索代码库并设计实施方案。",
		emoji: "📐",
		gradient: ["#7c3aed", "#a78bfa"],
		readOnly: true,
	},
];

/**
 * 判断 name 是否是内置 subagent 类型名（用于 delegate allowlist 放行 + 前端差异化渲染）。
 * 同时识别英文 name（"general-purpose"）和中文 displayName（"通用子智能体"），大小写敏感。
 */
export function isSubagentType(name: string): boolean {
	return SUBAGENT_TYPES.some((t) => t.name === name || t.displayName === name);
}

/**
 * 将内置 subagent 的别名（中文 displayName）归一化为英文 name。
 * 用于 delegate / fleet 调用 svc.spawn 前把 LLM 传入的中文别名转换为 pi-subagents registry 认的 type 名。
 * 若 name 不是内置类型别名，原样返回（普通智能体实名透传）。
 */
export function normalizeSubagentType(name: string): string {
	const found = SUBAGENT_TYPES.find(
		(t) => t.name === name || t.displayName === name,
	);
	return found ? found.name : name;
}

export interface AgentDef {
	emoji: string;
	gradient: [string, string];
}

// 按 displayName 索引（displayName 既是展示名也是唯一标识符）
export const AGENT_DEFS: Record<string, AgentDef> = {
	前端开发者: { emoji: "🖥️", gradient: ["#0EA5E9", "#38BDF8"] },
	后端架构师: { emoji: "🏗️", gradient: ["#6366F1", "#818CF8"] },
	产品经理: { emoji: "🧭", gradient: ["#F59E0B", "#FBBF24"] },
	测试结果分析师: { emoji: "🔬", gradient: ["#059669", "#10B981"] },
	数据分析师: { emoji: "📈", gradient: ["#EC4899", "#F472B6"] },
	代码审查员: { emoji: "🧐", gradient: ["#64748B", "#94A3B8"] },
	UX设计师: { emoji: "🎨", gradient: ["#F43F5E", "#FB7185"] },
	高级项目经理: { emoji: "📋", gradient: ["#D97706", "#F59E0B"] },
	会议纪要专家: { emoji: "📝", gradient: ["#6366F1", "#818CF8"] },
};

/** 所有内置智能体的 displayName 列表，用于 seedDefaults 批量生成 */
export const ALL_AGENT_NAMES: string[] = [
	"前端开发者",
	"后端架构师",
	"产品经理",
	"测试结果分析师",
	"数据分析师",
	"代码审查员",
	"UX设计师",
	"高级项目经理",
	"会议纪要专家",
];

/** Agent 未显式配置 tools 时的默认工具集。
 *  含 Pi 内置工具、pi-web-access 网络工具、amaster memory 记忆工具。
 *  注意：createAgentSession 的 tools 参数会被 SDK 当作 allowlist 使用，
 *  customTools（memory_add/replace/remove/read）同样要过这道 allowlist，
 *  未列出的工具会被过滤掉，因此必须在这里显式放行。 */
export const DEFAULT_AGENT_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"web_search",
	"fetch_content",
	"get_search_content",
	// pi-web-access 网络工具族：来源核查（多引擎检索 + passage 级引用评估）
	"source_check",
	// amaster memory 记忆工具（host-controlled，经 customTools 注入，须显式放行）
	"memory_add",
	"memory_replace",
	"memory_remove",
	"memory_read",
	"ask_user_question",
	// delegate：宿主关系网调起工具（customTools 注入）
	"delegate",
	// browser_*：Bun.WebView 浏览器自动化工具族
	"browser_navigate",
	"browser_evaluate",
	"browser_screenshot",
	"browser_close",
	// mcp：pi-mcp-adapter 内置代理工具（未开启 directTools 的服务器统一入口）
	"mcp",
];

/**
 * 合并工具 allowlist：baseTools + harvestedTools（MCP direct 工具名）。
 *
 * pi 不给宿主提供「查询会话已注册工具」的接口（RPC 无列工具命令、package.json 无
 * tools 声明字段），第三方扩展运行时注册的工具名无法被 wa-pi 采集。因此工具 allowlist
 * 只合并两源：agent 显式配置的 baseTools，以及 kernel 侧按 mcp.json 计算出的 MCP direct
 * 工具名（harvestedTools）。扩展工具的放行靠默认 agent 的排除式路径（excludeTools）——
 * 凡是 pi 进程加载扩展后注册的工具，默认 agent（不配 tools 白名单）一律放行。
 *
 * @param baseTools 基础工具列表（agent 配置的 tools）
 * @param harvestedTools 动态发现的工具名（MCP direct tools，由 kernel 按启用态计算）
 */
export function resolveAgentTools(
	baseTools: string[],
	harvestedTools: Iterable<string> = [],
): string[] {
	// 扩展原生 subagent 工具永不放行：LLM 只能走宿主 delegate 工具（allowlist 强制）
	const BLOCKED = new Set(["subagent"]);
	const seen = new Set(baseTools);
	const result = [...baseTools];
	for (const t of harvestedTools) {
		if (!seen.has(t)) {
			seen.add(t);
			result.push(t);
		}
	}
	return result.filter((t) => !BLOCKED.has(t));
}

/** 按 displayName 取 AgentDef（emoji/gradient 视觉样式），未知 displayName 回退默认灰色 🤖 */
export function agentDefOf(displayName: string): AgentDef {
	return (
		AGENT_DEFS[displayName] ?? { emoji: "🤖", gradient: ["#4b5563", "#6b7280"] }
	);
}
