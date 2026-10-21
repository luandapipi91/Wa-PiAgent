// embedding 模型评测基准：中英双语、三档相关性的语料-查询对。
// 设计原则（task-3 契约）：可复跑、多模型同口径、评分可解释。
//
// 语料风格取自 Wa-Pi 项目真实记忆（技术笔记 / 用户偏好 / 执行记录 / 日常干扰），
// 查询按「agent 真实会怎么问」构造，每条标注正例语料（relevant=false 的负例查询
// 用于测区分度：理想结果是「没有任何条目该得高分」）。

export interface BenchCorpusEntry {
	id: string;
	lang: "zh" | "en";
	text: string;
	/** 干扰档位标记（仅报告用，评分不看它——相关性由查询的 expectedId 决定） */
	tier: "tech" | "pref" | "log" | "noise";
}

export interface BenchQuery {
	id: string;
	lang: "zh" | "en";
	text: string;
	/** 正例语料 id */
	expectedId: string;
	/** false = 负例查询：库里没有该命中的条目，只用于测「无关查询不该得高分」 */
	relevant: boolean;
}

export const CORPUS: BenchCorpusEntry[] = [
	// ── 中文·技术 ──
	{ id: "zh-t1", lang: "zh", tier: "tech", text: "Wa-Pi 的 MCP 面板超时上限是 70 秒，单台慢 server 不再拖垮整页" },
	{ id: "zh-t2", lang: "zh", tier: "tech", text: "kernel 服务启动时监听 9778 端口，桌面端通过 bridge 转发工具调用" },
	{ id: "zh-t3", lang: "zh", tier: "tech", text: "记忆库 schema 升到 v3，embedding 列存 512 维向量，量化索引需要显式刷新" },
	{ id: "zh-t4", lang: "zh", tier: "tech", text: "git 推送必须禁用 osxkeychain 凭据助手，否则会卡死在钥匙串访问" },
	{ id: "zh-t5", lang: "zh", tier: "tech", text: "拖动窗口的流畅性修复用了三处改动，回弹语义是溜达关闭时的跳回问题" },
	{ id: "zh-t6", lang: "zh", tier: "tech", text: "发版前要跑四层测试：单元、组件、接口和浏览器端到端，缺一不可" },
	// ── 中文·用户偏好 ──
	{ id: "zh-p1", lang: "zh", tier: "pref", text: "用户偏好中文沟通，回答要聚焦所问问题，结论放在回复最后" },
	{ id: "zh-p2", lang: "zh", tier: "pref", text: "代码改动必须走 TDD：先写失败测试看它红，再写实现跑绿" },
	{ id: "zh-p3", lang: "zh", tier: "pref", text: "用户自称 co，不要用真名张智称呼" },
	// ── 中文·执行记录 ──
	{ id: "zh-l1", lang: "zh", tier: "log", text: "今天把 memory-semantic-search 分支合并进了 main，解决了两处冲突" },
	{ id: "zh-l2", lang: "zh", tier: "log", text: "编译了 vanilla SQLite dylib 让语义检索在 Intel Mac 上可用" },
	// ── 中文·干扰（无关） ──
	{ id: "zh-n1", lang: "zh", tier: "noise", text: "今天中午吃了红烧牛肉面，加了香菜" },
	{ id: "zh-n2", lang: "zh", tier: "noise", text: "周末计划去爬山，带上新买的登山杖" },
	{ id: "zh-n3", lang: "zh", tier: "noise", text: "股票账户今天绿了，白酒板块跌得厉害" },
	{ id: "zh-n4", lang: "zh", tier: "noise", text: "红烧肉的做法：五花肉焯水后加冰糖炒糖色" },
	// ── 英文·技术 ──
	{ id: "en-t1", lang: "en", tier: "tech", text: "The deployment pipeline runs unit tests before releasing to production" },
	{ id: "en-t2", lang: "en", tier: "tech", text: "Use bcrypt with a per-user salt for password hashing" },
	{ id: "en-t3", lang: "en", tier: "tech", text: "The websocket client reconnects with exponential backoff after a dropped connection" },
	{ id: "en-t4", lang: "en", tier: "tech", text: "SQLite extension loading must be enabled before opening the database connection" },
	// ── 英文·干扰 ──
	{ id: "en-n1", lang: "en", tier: "noise", text: "Made pasta carbonara for dinner with pancetta and pecorino" },
	{ id: "en-n2", lang: "en", tier: "noise", text: "The hiking trail near the lake is beautiful in autumn" },
];

export const QUERIES: BenchQuery[] = [
	// ── 中文查询 → 中文语料 ──
	{ id: "q1", lang: "zh", text: "上线前要做什么质量检查", expectedId: "zh-t6", relevant: true },
	{ id: "q2", lang: "zh", text: "MCP 服务器连接超时怎么配", expectedId: "zh-t1", relevant: true },
	{ id: "q3", lang: "zh", text: "git push 卡住不动是什么原因", expectedId: "zh-t4", relevant: true },
	{ id: "q4", lang: "zh", text: "写代码前要不要先写测试", expectedId: "zh-p2", relevant: true },
	{ id: "q5", lang: "zh", text: "怎么称呼这位用户", expectedId: "zh-p3", relevant: true },
	{ id: "q6", lang: "zh", text: "记忆库的表结构现在是什么版本", expectedId: "zh-t3", relevant: true },
	// ── 中文查询 → 英文语料（跨语言） ──
	{ id: "q7", lang: "zh", text: "密码应该怎么加密存储", expectedId: "en-t2", relevant: true },
	{ id: "q8", lang: "zh", text: "网络断开后如何自动重连", expectedId: "en-t3", relevant: true },
	// ── 英文查询 → 英文语料 ──
	{ id: "q9", lang: "en", text: "What should I check before releasing to production?", expectedId: "en-t1", relevant: true },
	{ id: "q10", lang: "en", text: "How to store passwords securely?", expectedId: "en-t2", relevant: true },
	{ id: "q11", lang: "en", text: "How should the user be addressed?", expectedId: "zh-p3", relevant: true },
	// ── 负例查询（库里没有对应条目，测区分度） ──
	{ id: "n1", lang: "zh", text: "红烧牛肉面怎么做", expectedId: "", relevant: false },
	{ id: "n2", lang: "en", text: "Best hiking trails in autumn", expectedId: "", relevant: false },
];
