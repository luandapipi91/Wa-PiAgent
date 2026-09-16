/** agency-agents-zh 预设智能体库的类型与部门映射（生成脚本 / kernel / 前端共用） */

/** 完整预设（含正文人格提示词），仅存 kernel 侧 JSON */
export interface AgencyPreset {
	/** 文件名去 .md，如 "engineering-frontend-developer" */
	id: string;
	/** 角色中文名，如 "前端开发者" */
	name: string;
	description: string;
	emoji: string;
	color: string;
	/** 中文部门名，如 "工程部" */
	department: string;
	/** 正文人格提示词 */
	body: string;
}

/** 浏览列表用的元数据（不含 body，控制体积） */
export type AgencyPresetMeta = Omit<AgencyPreset, "body">;

/** 目录名 → 中文部门名（19 个，与 agency-agents-zh 目录一一对应） */
export const AGENCY_DEPARTMENTS: Record<string, string> = {
	academic: "学术部",
	design: "设计部",
	engineering: "工程部",
	finance: "金融部",
	"game-development": "游戏开发部",
	gis: "GIS 部",
	hr: "人力资源部",
	legal: "法务部",
	marketing: "营销部",
	"paid-media": "付费媒体部",
	product: "产品部",
	"project-management": "项目管理部",
	sales: "销售部",
	security: "安全部",
	"spatial-computing": "空间计算部",
	specialized: "专项部",
	"supply-chain": "供应链部",
	support: "支持部",
	testing: "测试部",
};
