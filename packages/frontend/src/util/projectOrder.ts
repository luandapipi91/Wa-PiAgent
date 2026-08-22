import type { SessionEntity } from "@wa-pi/shared";

/**
 * 计算项目内会话的显示顺序（纯函数，便于测试）。
 *
 * - `shouldReorder` 为真，或 `lastOrder` 为空（首次）：按 `lastActivity` 倒序重排；
 * - 否则保持 `lastOrder` 的相对顺序（稳定顺序），新会话（不在 lastOrder 中）按
 *   `lastActivity` 倒序插入到正确位置，已删除的会话（不在 list 中）被剔除。
 */
export function orderSessions(
	list: SessionEntity[],
	lastOrder: string[] | null,
	shouldReorder: boolean,
): SessionEntity[] {
	if (shouldReorder || !lastOrder) {
		return [...list].sort((a, b) => b.lastActivity - a.lastActivity);
	}

	const byId = new Map(list.map((s) => [s.id, s]));
	const ordered: SessionEntity[] = [];
	for (const id of lastOrder) {
		const s = byId.get(id);
		if (s) ordered.push(s);
	}

	const known = new Set(lastOrder);
	const newcomers = list
		.filter((s) => !known.has(s.id))
		.sort((a, b) => b.lastActivity - a.lastActivity);
	for (const n of newcomers) {
		const idx = ordered.findIndex((s) => s.lastActivity < n.lastActivity);
		if (idx === -1) ordered.push(n);
		else ordered.splice(idx, 0, n);
	}
	return ordered;
}
