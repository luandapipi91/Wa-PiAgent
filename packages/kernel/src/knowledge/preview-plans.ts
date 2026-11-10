// 预览计划令牌（任务 9，S13）：预览与创建之间目录可能被改动（用户在两段式里
// 停留、外部程序写文件），创建时要能告诉用户「你看到的预览已过期」。
//
// 做法：预览时把可索引清单（相对路径集合）连同一个随机 planId 记进 kernel 进程内存，
// 创建时按 planId 找回并比对当前清单。**不阻断创建**——只报告差异，索引按最新内容走。
//
// 约束（控制者裁决）：
//   - 仅进程内有效，不落盘、不跨 kernel 重启
//   - TTL 10 分钟（超时即视为未命中，避免旧令牌长期占位）
//   - 最多 32 条，超出淘汰最久未使用的一条（Map 插入序 = LRU 序）
import { randomUUID } from "node:crypto";

/** 令牌有效期：10 分钟 */
export const PREVIEW_PLAN_TTL_MS = 10 * 60 * 1000;

/** 令牌表容量上限（超出淘汰最旧一条） */
export const PREVIEW_PLAN_MAX = 32;

interface PreviewPlan {
	/** 归一化后的库根绝对路径：令牌只对该目录有效 */
	folderPath: string;
	/** 预览时的可索引文件相对路径集合 */
	indexable: Set<string>;
	/** 创建时间（毫秒时间戳），判 TTL 用 */
	createdAt: number;
}

/** planId → 计划；Map 迭代序为插入序，读取命中时重插以实现 LRU */
const plans = new Map<string, PreviewPlan>();

/** 清掉已过期的计划（每次读写前顺带做，量级 ≤32 条，无需定时器） */
function purgeExpired(now: number): void {
	for (const [id, plan] of plans) {
		if (now - plan.createdAt > PREVIEW_PLAN_TTL_MS) plans.delete(id);
	}
}

/**
 * 记住一次预览结果，返回 planToken。
 * folderPath 必须是归一化后的绝对路径（调用方用 resolve，与创建侧一致）。
 */
export function rememberPreview(
	folderPath: string,
	indexable: readonly string[],
	opts?: { now?: number },
): string {
	const now = opts?.now ?? Date.now();
	purgeExpired(now);
	const planId = randomUUID();
	plans.set(planId, {
		folderPath,
		indexable: new Set(indexable),
		createdAt: now,
	});
	// 超容量：淘汰最旧一条（Map 头部即最早插入/最久未读）
	while (plans.size > PREVIEW_PLAN_MAX) {
		const oldest = plans.keys().next();
		if (oldest.done) break;
		plans.delete(oldest.value);
	}
	return planId;
}

/**
 * 比对 token 对应的预览清单与「当前」清单。
 * 未命中（不存在/过期/目录不符）→ { hit: false }，调用方不得报告差异；
 * 命中且无差异 → { hit: true, changed: false, token }；
 * 命中且有差异 → 另附 added/removed（字典序，便于展示与断言稳定）。
 */
export function evaluatePreviewPlan(
	planId: string,
	folderPath: string,
	indexableNow: readonly string[],
	opts?: { now?: number },
): {
	hit: boolean;
	changed?: boolean;
	added?: string[];
	removed?: string[];
	token?: string;
} {
	const now = opts?.now ?? Date.now();
	purgeExpired(now);
	const plan = plans.get(planId);
	if (!plan) return { hit: false };
	// 目录不符：令牌与目录绑定，换目录不能拿旧清单做对比（否则全是假差异）
	if (plan.folderPath !== folderPath) return { hit: false };
	// LRU 触碰：删后重插，移到队尾
	plans.delete(planId);
	plans.set(planId, plan);

	const current = new Set(indexableNow);
	const added = [...current].filter((p) => !plan.indexable.has(p)).sort();
	const removed = [...plan.indexable].filter((p) => !current.has(p)).sort();
	if (added.length === 0 && removed.length === 0) {
		return { hit: true, changed: false, token: planId };
	}
	return { hit: true, changed: true, added, removed, token: planId };
}
