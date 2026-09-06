import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "../../i18n/useTranslation";
import { Icon } from "../ui/Icon";

interface Props {
	current: string;
	branches: string[];
	onSwitch: (branch: string) => void;
	onCreateBranch: () => void;
	onOpenGraph: () => void;
	/** 由 BranchChip 传入的 pill 锚点（定位用） */
	anchorRef: React.RefObject<HTMLButtonElement | null>;
	onClose: () => void;
}

/**
 * 分支下拉菜单（portal 到 body）：搜索框 + 「分支」分组 + 列表（当前打勾）
 * + 底部「创建并检出新分支…」「Git 图谱」入口。
 * 定位/翻转/外部点击/滚动关闭逻辑仿照 AgentDropdown。
 */
export function BranchMenu({
	current,
	branches,
	onSwitch,
	onCreateBranch,
	onOpenGraph,
	anchorRef,
	onClose,
}: Props) {
	const { t } = useTranslation();
	const [query, setQuery] = useState("");
	const menuRef = useRef<HTMLDivElement>(null);

	// 定位：按 pill 矩形 fixed 定位，底部溢出向上翻转 + 水平钳制（测试环境零尺寸不定位）
	useLayoutEffect(() => {
		if (!menuRef.current || !anchorRef.current) return;
		const m = menuRef.current;
		const pr = anchorRef.current.getBoundingClientRect();
		if (pr.width === 0 && pr.height === 0) return;
		m.style.left = `${pr.left}px`;
		m.style.top = `${pr.bottom + 4}px`;
		const r = m.getBoundingClientRect();
		if (r.width === 0 && r.height === 0) return;
		if (pr.bottom + 4 + r.height > window.innerHeight - 8) {
			m.style.top = `${Math.max(8, pr.top - r.height - 4)}px`;
		}
		if (pr.left + r.width > window.innerWidth - 8) {
			m.style.left = `${Math.max(8, window.innerWidth - 8 - r.width)}px`;
		}
	});

	// 点击菜单外部关闭（锚点 pill 的点击由 BranchChip 自身 toggle 处理，不算外部）
	useEffect(() => {
		const onDown = (ev: MouseEvent) => {
			const target = ev.target as Node;
			if (menuRef.current?.contains(target)) return;
			if (anchorRef.current?.contains(target)) return;
			onClose();
		};
		window.addEventListener("mousedown", onDown);
		return () => window.removeEventListener("mousedown", onDown);
	}, [onClose, anchorRef]);

	// 外部滚动关闭（菜单内部滚动不关闭），同 AgentDropdown
	useEffect(() => {
		const onScroll = (ev: Event) => {
			const target = ev.target as Node | null;
			if (target instanceof Node && menuRef.current?.contains(target)) return;
			onClose();
		};
		window.addEventListener("scroll", onScroll, true);
		return () => window.removeEventListener("scroll", onScroll, true);
	}, [onClose]);

	const filtered = branches.filter((b) =>
		b.toLowerCase().includes(query.trim().toLowerCase()),
	);

	const pick = (branch: string) => {
		// 点当前分支只关闭，不重复切换
		if (branch !== current) onSwitch(branch);
		onClose();
	};

	return createPortal(
		<div
			ref={menuRef}
			data-testid="branch-menu"
			// 初始藏屏外，布局 effect 按 pill 定位（防闪烁）
			style={{ left: -9999, top: -9999 }}
			className="fixed z-50 min-w-[240px] max-w-[calc(100vw-16px)] overflow-x-hidden bg-surface-elevated border border-hairline rounded-md shadow-lg p-1"
		>
			{/* 搜索框 */}
			<div className="flex items-center gap-1.5 bg-surface border border-hairline rounded-sm px-2 py-1.5 mx-0.5 mb-1 text-tertiary">
				<Icon name="search" size={12} />
				<input
					data-testid="branch-search"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder={t("git.searchBranch")}
					className="flex-1 bg-transparent border-0 outline-none text-[calc(12px*var(--font-scale))] text-primary"
				/>
			</div>
			{/* 「分支」分组标题 */}
			<div className="px-2.5 pt-1 pb-0.5 text-[calc(11px*var(--font-scale))] text-tertiary">
				{t("git.branches")}
			</div>
			<div className="max-h-[280px] overflow-y-auto">
				{filtered.map((b) => (
					<div
						key={b}
						data-testid={`branch-item-${b}`}
						onClick={() => pick(b)}
						className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-sm cursor-pointer text-left transition-colors text-secondary ${
							b === current ? "bg-surface-hover" : "hover:bg-surface-hover"
						}`}
					>
						<span className="min-w-0 flex-1 text-[calc(12px*var(--font-scale))] text-primary truncate">
							{b}
						</span>
						{b === current && <span className="ml-auto text-accent">✓</span>}
					</div>
				))}
			</div>
			{/* 底部入口 */}
			<div className="border-t border-hairline mt-1 pt-1">
				<div
					data-testid="btn-create-branch"
					onClick={() => {
						onCreateBranch();
						onClose();
					}}
					className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-sm cursor-pointer text-left transition-colors text-secondary hover:bg-surface-hover text-[calc(12px*var(--font-scale))]"
				>
					<Icon name="plus" size={12} />
					<span className="truncate">{t("git.createBranch")}</span>
				</div>
				<div
					data-testid="btn-git-graph"
					onClick={() => {
						onOpenGraph();
						onClose();
					}}
					className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-sm cursor-pointer text-left transition-colors text-secondary hover:bg-surface-hover text-[calc(12px*var(--font-scale))]"
				>
					<Icon name="gitGraph" size={12} />
					<span className="truncate">{t("git.graph")}</span>
				</div>
			</div>
		</div>,
		document.body,
	);
}
