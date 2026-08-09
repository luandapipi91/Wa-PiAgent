// 文件树面板：移植自 cocode 的 explorer.tsx，适配 WaPi 的 fs-client（HTTP REST）。
// 特性：扁平数组懒加载、5s 轮询、展开状态 ref 保持、右键复制路径/在访达显示、双击文件预览。
// WaPi 的 listDir 返回 DirEntry{name,isDir}（无 path），前端按父目录拼接绝对路径。
import { useCallback, useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { listDir, revealFile } from "../fs-client";
import { copyToClipboard } from "../util/clipboard";
import { openInFileManagerLabel } from "../util/platform";
import { useToastStore } from "../store/toast";
import { useTranslation } from "../i18n/useTranslation";
import { Icon } from "./ui/Icon";

type Entry = { name: string; path: string; isDir: boolean };

type FlatNode = {
	key: string;
	entry: Entry;
	depth: number;
	expanded: boolean;
	hasChildren: boolean | null;
};

function joinPath(parent: string, name: string): string {
	return parent.endsWith("/") || parent === ""
		? parent + name
		: parent + "/" + name;
}

/** 右键菜单 */
function ExplorerContextMenu({
	x,
	y,
	entry,
	onClose,
	onReveal,
	t,
}: {
	x: number;
	y: number;
	entry: Entry;
	onClose: () => void;
	onReveal: (path: string) => void;
	t: TFunction;
}) {
	useEffect(() => {
		const close = (e: MouseEvent) => {
			if (e.target instanceof Element && e.target.closest("[data-ctx-menu]"))
				return;
			onClose();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("click", close, { capture: true });
		window.addEventListener("keydown", onKey, { capture: true });
		return () => {
			window.removeEventListener("click", close, { capture: true });
			window.removeEventListener("keydown", onKey, { capture: true });
		};
	}, [onClose]);

	return (
		<div className="ep-ctx-menu" data-ctx-menu="" style={{ left: x, top: y }}>
			<button
				className="ep-ctx-item"
				onClick={() => {
					void copyToClipboard(entry.path);
					onClose();
				}}
			>
				{t("explorer.ctxCopyPath")}
			</button>
			<button
				className="ep-ctx-item"
				onClick={() => {
					onReveal(entry.path);
					onClose();
				}}
			>
				{openInFileManagerLabel({
					mac: t("common.openInFinder"),
					windows: t("common.openInExplorer"),
					linux: t("common.openInFileManager"),
				})}
			</button>
		</div>
	);
}

export function ExplorerPanel({
	workspaceDir,
	onOpenFile,
}: {
	workspaceDir: string;
	onOpenFile: (path: string) => void;
}) {
	const { t } = useTranslation();
	const [flatList, setFlatList] = useState<FlatNode[]>([]);
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [ctxMenu, setCtxMenu] = useState<{
		x: number;
		y: number;
		entry: Entry;
	} | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const expandedRef = useRef<Set<string>>(new Set());
	const togglingRef = useRef(false);
	const addToast = useToastStore((s) => s.add);

	// 加载单层目录：WaPi 的 listDir 返回 DirEntry{name,isDir}，前端补 path
	// showHidden=true：显示 .git/.env 等点开头隐藏文件/目录（kernel 默认过滤 dotfile）
	const loadDir = useCallback(async (dir: string): Promise<Entry[]> => {
		try {
			const entries = await listDir(dir, true);
			return (
				entries
					.map((e) => ({
						name: e.name,
						path: joinPath(dir, e.name),
						isDir: e.isDir,
					}))
					// 排序：文件夹在前、文件在后；同类按名称（大小写不敏感、数字自然序）
					.sort((a, b) => {
						if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
						return a.name.localeCompare(b.name, undefined, {
							sensitivity: "base",
							numeric: true,
						});
					})
			);
		} catch (err) {
			console.error("[ExplorerPanel] listDir failed", err);
			return [];
		}
	}, []);

	// 轮询时按 expandedRef 递归重建所有已展开子树，保证轮询不折叠
	const rebuildExpanded = useCallback(
		async (nodes: FlatNode[]): Promise<FlatNode[]> => {
			const result: FlatNode[] = [];
			const expandedSet = expandedRef.current;
			for (const node of nodes) {
				result.push(node);
				if (node.entry.isDir && expandedSet.has(node.entry.path)) {
					const children = await loadDir(node.entry.path);
					const childNodes: FlatNode[] = children.map((e) => ({
						key: joinPath(node.entry.path, e.name),
						entry: e,
						depth: node.depth + 1,
						expanded: expandedSet.has(e.path),
						hasChildren: e.isDir
							? expandedSet.has(e.path)
								? true
								: null
							: null,
					}));
					result[result.length - 1] = {
						...result[result.length - 1]!,
						expanded: true,
						hasChildren: children.length > 0,
					};
					const expandedChildren = await rebuildExpanded(childNodes);
					result.push(...expandedChildren);
				}
			}
			return result;
		},
		[loadDir],
	);

	// 初始加载 + 5s 轮询
	useEffect(() => {
		if (!workspaceDir) return;
		let cancelled = false;

		const refresh = async () => {
			if (togglingRef.current) return; // 手动展开进行中，跳过本周期
			try {
				setError(null);
				setLoading(true);
				const entries = await loadDir(workspaceDir);
				if (cancelled) return;
				const expandedSet = expandedRef.current;
				const rootNodes: FlatNode[] = entries.map((e) => ({
					key: e.path,
					entry: e,
					depth: 0,
					expanded: expandedSet.has(e.path),
					hasChildren: e.isDir ? (expandedSet.has(e.path) ? true : null) : null,
				}));
				const fullTree = await rebuildExpanded(rootNodes);
				if (cancelled) return;
				setFlatList(fullTree);
				setLoading(false);
			} catch (err) {
				if (!cancelled) {
					setError(String(err instanceof Error ? err.message : err));
					setLoading(false);
				}
			}
		};

		refresh();
		const interval = setInterval(refresh, 5000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [workspaceDir, loadDir, rebuildExpanded]);

	// 展开/折叠目录（路径查找，避免 stale idx 污染）
	const toggleDir = useCallback(
		async (node: FlatNode) => {
			if (!node.entry.isDir) return;
			const dirPath = node.entry.path;

			if (node.expanded) {
				// 折叠：同步
				expandedRef.current.delete(dirPath);
				setFlatList((prev) => {
					const idx = prev.findIndex((n) => n.entry.path === dirPath);
					if (idx === -1) return prev;
					const next = [...prev];
					const depth = next[idx]!.depth;
					next[idx] = { ...next[idx]!, expanded: false };
					let i = idx + 1;
					while (i < next.length && next[i]!.depth > depth) i++;
					next.splice(idx + 1, i - idx - 1);
					return next;
				});
				return;
			}

			// 展开：异步 + 竞态守卫
			if (togglingRef.current) return;
			togglingRef.current = true;
			expandedRef.current.add(dirPath);
			try {
				const children = await loadDir(dirPath);
				setFlatList((prev) => {
					const idx = prev.findIndex((n) => n.entry.path === dirPath);
					if (idx === -1) return prev;
					const currentNode = prev[idx]!;
					if (currentNode.expanded) return prev; // 轮询已先展开
					const childNodes: FlatNode[] = children.map((e) => ({
						key: joinPath(dirPath, e.name),
						entry: e,
						depth: currentNode.depth + 1,
						expanded: false,
						hasChildren: null,
					}));
					const next = [...prev];
					next[idx] = {
						...currentNode,
						expanded: true,
						hasChildren: children.length > 0,
					};
					next.splice(idx + 1, 0, ...childNodes);
					return next;
				});
			} finally {
				togglingRef.current = false;
			}
		},
		[loadDir],
	);

	const handleClick = useCallback(
		(node: FlatNode) => {
			if (node.entry.isDir) toggleDir(node);
			else setSelectedPath(node.entry.path);
		},
		[toggleDir],
	);

	const handleDoubleClick = useCallback(
		(node: FlatNode) => {
			if (!node.entry.isDir) onOpenFile(node.entry.path);
		},
		[onOpenFile],
	);

	const handleContextMenu = useCallback(
		(e: React.MouseEvent, node: FlatNode) => {
			e.preventDefault();
			e.stopPropagation();
			if (!node.entry.isDir) setSelectedPath(node.entry.path);
			setCtxMenu({ x: e.clientX, y: e.clientY, entry: node.entry });
		},
		[],
	);

	const handleReveal = useCallback(
		async (path: string) => {
			try {
				await revealFile(path);
			} catch {
				addToast(t("explorer.revealFailed"), "error");
			}
		},
		[addToast, t],
	);

	// 拖拽到输入框生成 @提及：dispatch 自定义事件，由 Composer 监听并插入
	const startDrag = useCallback((e: React.PointerEvent, node: FlatNode) => {
		if (e.button !== 0) return;
		e.preventDefault();
		const el = e.currentTarget as HTMLElement;
		el.setPointerCapture(e.pointerId);
		const fpath = node.entry.path,
			fname = node.entry.name;
		let dragging = false;
		let ghost: HTMLElement | null = null;

		const onMove = (ev: PointerEvent) => {
			if (
				!dragging &&
				Math.abs(ev.clientX - e.clientX) < 5 &&
				Math.abs(ev.clientY - e.clientY) < 5
			)
				return;
			if (!dragging) {
				dragging = true;
				ghost = document.createElement("div");
				ghost.className = "ep-drag-ghost";
				ghost.textContent = fname;
				document.body.appendChild(ghost);
			}
			if (ghost) {
				ghost.style.left = ev.clientX + "px";
				ghost.style.top = ev.clientY + "px";
			}
		};

		const onUp = (upEv: PointerEvent) => {
			el.releasePointerCapture(upEv.pointerId);
			el.removeEventListener("pointermove", onMove);
			el.removeEventListener("pointerup", onUp);
			const ghostEl = ghost;
			ghost = null;
			if (ghostEl) ghostEl.remove();
			if (!dragging) return;
			const target = document.elementFromPoint(upEv.clientX, upEv.clientY);
			// 命中输入框：textarea（原生）或 contentEditable 编辑器（[role=textbox]）
			const editor = target?.closest(
				"textarea, [contenteditable], [role='textbox']",
			);
			if (editor instanceof HTMLElement) {
				// 通过自定义事件通知 Composer 插入 @提及；Composer 监听后在编辑器光标处插入
				window.dispatchEvent(
					new CustomEvent("wa-pi:insert-mention", {
						detail: { text: `@${fpath} `, editor },
					}),
				);
			}
		};

		el.addEventListener("pointermove", onMove);
		el.addEventListener("pointerup", onUp);
	}, []);

	if (!workspaceDir) {
		return <div className="ep-empty">{t("explorer.emptyNoWorkspace")}</div>;
	}
	if (error) {
		return (
			<div className="ep-empty">{t("explorer.loadFailed", { error })}</div>
		);
	}
	if (loading && flatList.length === 0) {
		return <div className="ep-empty">{t("common.loading")}</div>;
	}

	return (
		<div
			className="ep-tree"
			style={{ overflow: "auto" }}
			data-testid="explorer-panel"
		>
			{flatList.map((node) => {
				const isSelected = node.entry.path === selectedPath;
				return (
					<div
						key={node.key}
						className="ep-node"
						data-kind={node.entry.isDir ? "dir" : "file"}
						data-selected={isSelected ? "true" : "false"}
						style={{ paddingLeft: 8 + node.depth * 16 }}
						onPointerDown={(e) => startDrag(e, node)}
						onClick={() => handleClick(node)}
						onDoubleClick={() => handleDoubleClick(node)}
						onContextMenu={(e) => handleContextMenu(e, node)}
					>
						<span className="ep-arrow">
							{node.entry.isDir ? (
								<Icon
									name={node.expanded ? "chevron-down" : "chevron-right"}
									size={10}
								/>
							) : null}
						</span>
						<span className="ep-icon inline-flex">
							<Icon name={node.entry.isDir ? "folder" : "file"} size={13} />
						</span>
						<span className="ep-name">{node.entry.name}</span>
					</div>
				);
			})}
			{ctxMenu && (
				<ExplorerContextMenu
					x={ctxMenu.x}
					y={ctxMenu.y}
					entry={ctxMenu.entry}
					onClose={() => setCtxMenu(null)}
					onReveal={handleReveal}
					t={t}
				/>
			)}
		</div>
	);
}
