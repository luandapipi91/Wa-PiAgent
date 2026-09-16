// file-snapshot.ts —— 文件快照采集纯逻辑（可单测）。
//
// 被 wa-pi-bridge.extension.ts 引用（运行时经 ensureBridgeExtension 复制到
// GENERATED_DIR 与扩展同目录），也被 kernel 单元测试直接 import。
// 不依赖 node:fs（文件读取经注入函数），保证纯函数可独立测试。

export const SNAPSHOT_SIZE_LIMIT = 512 * 1024; // 512KB
export const SNAPSHOT_LINE_LIMIT = 5000;

export type SnapshotReadResult =
	| { kind: "content"; content: string }
	| { kind: "missing" }
	| { kind: "error" };

export type FileSnapshotRecord = {
	before: string | null;
	after: string | null;
	oversized?: boolean;
	error?: boolean;
};

export function recordBefore(
	snapshots: Map<string, FileSnapshotRecord>,
	toolCallIdToPath: Map<string, string>,
	toolCallId: string,
	path: string,
	read: (p: string) => SnapshotReadResult,
): void {
	toolCallIdToPath.set(toolCallId, path);
	if (snapshots.has(path)) return;
	const r = read(path);
	if (r.kind === "content") snapshots.set(path, { before: r.content, after: null });
	else if (r.kind === "missing") snapshots.set(path, { before: null, after: null });
	else snapshots.set(path, { before: null, after: null, error: true });
}

export function recordAfter(
	snapshots: Map<string, FileSnapshotRecord>,
	toolCallIdToPath: Map<string, string>,
	toolCallId: string,
	read: (p: string) => SnapshotReadResult,
): void {
	const path = toolCallIdToPath.get(toolCallId);
	if (!path) return;
	const snap = snapshots.get(path);
	if (!snap) return;
	const r = read(path);
	if (r.kind === "content") snap.after = r.content;
	else if (r.kind === "error") snap.error = true;
}

function countLines(s: string | null): number {
	if (!s) return 0;
	let n = 1;
	for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
	return n;
}

export function applySizeLimit(snapshots: Map<string, FileSnapshotRecord>): void {
	for (const snap of snapshots.values()) {
		if (snap.error) continue;
		const total = (snap.before?.length ?? 0) + (snap.after?.length ?? 0);
		const lines = Math.max(countLines(snap.before), countLines(snap.after));
		if (total > SNAPSHOT_SIZE_LIMIT || lines > SNAPSHOT_LINE_LIMIT) {
			snap.oversized = true;
			snap.before = null;
			snap.after = null;
		}
	}
}

export function serializeSnapshots(
	snapshots: Map<string, FileSnapshotRecord>,
): Array<{ path: string; before: string | null; after: string | null; oversized?: boolean; error?: boolean }> {
	return [...snapshots.entries()].map(([path, s]) => ({
		path,
		before: s.before,
		after: s.after,
		...(s.oversized ? { oversized: true } : {}),
		...(s.error ? { error: true } : {}),
	}));
}
