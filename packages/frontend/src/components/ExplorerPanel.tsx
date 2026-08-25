// 文件树面板：移植自 cocode 的 explorer.tsx，适配 WaPi 的 fs-client（HTTP REST）。
// 特性：扁平数组懒加载、5s 轮询、展开状态 ref 保持、右键复制路径/在访达显示、双击文件预览。
// WaPi 的 listDir 返回 DirEntry{name,isDir}（无 path），前端按父目录拼接绝对路径。
import { useCallback, useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { listDir, revealFile, openFileWithDefaultApp } from "../fs-client";
import { copyToClipboard } from "../util/clipboard";
import { openInFileManagerLabel } from "../util/platform";
import { useToastStore } from "../store/toast";
import { useTranslation } from "../i18n/useTranslation";
import { Icon } from "./ui/Icon";
import { ShareResultModal } from "./ui/ShareButton";

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

/** 右键菜单：多选（sel.length > 1）时只显示「分享所选」，单选时显示原菜单 + 「分享」 */
function ExplorerContextMenu({
	x,
	y,
	entry,
	sel,
	onClose,
	onReveal,
	onShare,
	t,
}: {
	x: number;
	y: number;
	entry: Entry;
	sel: string[];
	onClose: () => void;
	onReveal: (path: string) => void;
	onShare: (paths: string[]) => void;
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

	// 多选（>1）：复制路径/默认应用打开/在访达显示对多个条目无意义，只保留「分享所选」
	if (sel.length > 1) {
		return (
			<div className="ep-ctx-menu" data-ctx-menu="" style={{ left: x, top: y }}>
				<button
					className="ep-ctx-item"
					data-testid="ep-ctx-share-multi"
					onClick={() => {
						onShare(sel);
						onClose();
					}}
				>
					{t("explorer.ctxShareMulti")}
				</button>
			</div>
		);
	}
	return (
		<div className="ep-ctx-menu" data-ctx-menu="" style={{ left: x, top: y }}>
			<button
				className="ep-ctx-item"
				data-testid="ep-ctx-share"
				onClick={() => {
					onShare([entry.path]);
					onClose();
				}}
			>
				{t("explorer.ctxShare")}
			</button>
			<button
				className="ep-ctx-item"
				onClick={() => {
					void copyToClipboard(entry.path);
					onClose();
				}}
			>
				{t("explorer.ctxCopyPath")}
			</button>
			{!entry.isDir && (
				<button
					className="ep-ctx-item"
					onClick={() => {
						void openFileWithDefaultApp(entry.path);
						onClose();
					}}
				>
					{t("common.openWithDefaultApp")}
				</button>
			)}
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
	projectName,
}: {
	workspaceDir: string;
	onOpenFile: (path: string) => void;
	/** 项目名称：分享名称默认值（右键分享入口无 sessionId，由父组件传入） */
	projectName?: string;
}) {
	const { t } = useTranslation();
	const [flatList, setFlatList] = useState<FlatNode[]>([]);
	// 多选：Ctrl/Cmd+点击 toggle、Shift+点击区间连选；单选时集合只含一个 path
	const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
	const [ctxMenu, setCtxMenu] = useState<{
		x: number;
		y: number;
		entry: Entry;
		sel: string[];
	} | null>(null);
	// 分享弹层挂载：右键「分享 / 分享所选」置位后渲染 ShareResultModal
	const [sharePaths, setSharePaths] = useState<string[] | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const expandedRef = useRef<Set<string>>(new Set());
	const togglingRef = useRef(false);
	// Shift 连选锚点：最近一次单选/Ctrl 点击的节点 path
	const lastSelectedRef = useRef<string | null>(null);
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
						hasChildren: e.isDir ? (expandedSet.has(e.path) ? true : null) : null,
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

	// workspaceDir 切换：重置选中集与 Shift 连选锚点
	useEffect(() => {
		setSelectedPaths(new Set());
		lastSelectedRef.current = null;
	}, [workspaceDir]);

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
		(node: FlatNode, e: React.MouseEvent) => {
			// Ctrl/Cmd+点击：toggle 进出选中集（目录不展开，避免与多选冲突）
			if (e.metaKey || e.ctrlKey) {
				setSelectedPaths((prev) => {
					const next = new Set(prev);
					if (next.has(node.entry.path)) next.delete(node.entry.path);
					else next.add(node.entry.path);
					return next;
				});
				lastSelectedRef.current = node.entry.path;
				return;
			}
			// Shift+点击：从锚点到当前节点按 flatList 索引区间连选
			if (e.shiftKey) {
				const anchor = lastSelectedRef.current;
				const startIdx = anchor
					? flatList.findIndex((n) => n.entry.path === anchor)
					: flatList.findIndex((n) => n.entry.path === node.entry.path);
				const endIdx = flatList.findIndex((n) => n.entry.path === node.entry.path);
				if (startIdx !== -1 && endIdx !== -1) {
					const [lo, hi] =
						startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
					setSelectedPaths(
						new Set(flatList.slice(lo, hi + 1).map((n) => n.entry.path)),
					);
				}
				return;
			}
			// 无修饰键：清除多选、单选当前节点；目录同时展开/折叠（保留文件树展开语义）
			setSelectedPaths(new Set([node.entry.path]));
			lastSelectedRef.current = node.entry.path;
			if (node.entry.isDir) toggleDir(node);
		},
		[toggleDir, flatList],
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
			// 右键节点在选中集内且 >1 项：分享所选；
			// 否则（含右键未选中节点）：按文件树惯例单选该节点并弹单文件菜单
			if (selectedPaths.size > 1 && selectedPaths.has(node.entry.path)) {
				setCtxMenu({
					x: e.clientX,
					y: e.clientY,
					entry: node.entry,
					sel: [...selectedPaths],
				});
				return;
			}
			setSelectedPaths(new Set([node.entry.path]));
			lastSelectedRef.current = node.entry.path;
			setCtxMenu({
				x: e.clientX,
				y: e.clientY,
				entry: node.entry,
				sel: [node.entry.path],
			});
		},
		[selectedPaths],
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

	// 拖拽到输入框生成 path: 引用：dispatch 自定义事件，由 Composer 监听并插入
	const startDrag = useCallback((e: React.PointerEvent, node: FlatNode) => {
		if (e.button !== 0) return;
		e.preventDefault();
		const el = e.currentTarget as HTMLElement;
		el.setPointerCapture(e.pointerId);
		const fpath = node.entry.path,
			fname = node.entry.name;
		// 与 kernel buildPromptContent 一致：绝对路径全正斜杠（Windows 盘符/拼接处归一），
		// 避免 joinPath 在 Windows 产出 C:\proj/name 这类混合分隔符。
		const ref = fpath.replace(/\\/g, "/");
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
				// 通过自定义事件通知 Composer 插入 path: 引用；Composer 监听后在编辑器光标处插入
				window.dispatchEvent(
					new CustomEvent("wa-pi:insert-mention", {
						detail: { text: `path:${ref} `, editor },
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
		return <div className="ep-empty">{t("explorer.loadFailed", { error })}</div>;
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
				const isSelected = selectedPaths.has(node.entry.path);
				return (
					<div
						key={node.key}
						className="ep-node"
						data-kind={node.entry.isDir ? "dir" : "file"}
						data-selected={isSelected ? "true" : "false"}
						style={{ paddingLeft: 8 + node.depth * 16 }}
						onPointerDown={(e) => startDrag(e, node)}
						onClick={(e) => handleClick(node, e)}
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
					sel={ctxMenu.sel}
					onClose={() => setCtxMenu(null)}
					onReveal={handleReveal}
					onShare={(paths) => setSharePaths(paths)}
					t={t}
				/>
			)}
			{sharePaths && (
				<ShareResultModal
					paths={sharePaths}
					projectName={projectName}
					onClose={() => setSharePaths(null)}
				/>
			)}
		</div>
	);
}
