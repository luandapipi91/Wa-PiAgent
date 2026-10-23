import { useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { BranchMenu } from "./BranchMenu";

interface Props {
	/** 当前分支名 */
	current: string;
	branches: string[];
	onSwitch: (branch: string) => void;
	onCreateBranch: () => void;
	onOpenGraph: () => void;
	/** 拉取中（透传给菜单做禁用） */
	pulling: boolean;
	onPull: () => void;
	onRefresh: () => void;
}

/**
 * 分支 chip：pill 按钮（分支图标 + 当前分支名 + ▾），点击展开 BranchMenu。
 * 纯展示受控组件：数据与动作全部由 GitToolbar 注入。
 */
export function BranchChip({
	current,
	branches,
	onSwitch,
	onCreateBranch,
	onOpenGraph,
	pulling,
	onPull,
	onRefresh,
}: Props) {
	const [open, setOpen] = useState(false);
	const pillRef = useRef<HTMLButtonElement>(null);

	return (
		<div className="relative min-w-0 max-w-full">
			<button
				type="button"
				ref={pillRef}
				data-testid="branch-chip"
				onClick={() => setOpen((o) => !o)}
				className="min-w-0 flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-[calc(12px*var(--font-scale))] cursor-pointer transition-colors bg-surface-elevated text-secondary border-hairline hover:text-primary"
			>
				<Icon name="branch" size={12} className="flex-none" />
				<span className="max-w-[180px] truncate">{current}</span>
				<span
					className="flex-none"
					style={{ fontSize: "calc(10px * var(--font-scale))" }}
				>
					▾
				</span>
			</button>
			{open && (
				<BranchMenu
					current={current}
					branches={branches}
					onSwitch={onSwitch}
					onCreateBranch={onCreateBranch}
					onOpenGraph={onOpenGraph}
					pulling={pulling}
					onPull={onPull}
					onRefresh={onRefresh}
					anchorRef={pillRef}
					onClose={() => setOpen(false)}
				/>
			)}
		</div>
	);
}
