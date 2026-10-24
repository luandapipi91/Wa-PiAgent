import { Icon } from "../ui/Icon";

/**
 * 执行记录行尾的「详情 ›」入口：无底色文字按钮 + 右箭头。
 * 静态透明无边框，只有 hover 才给浅底与箭头位移。
 * 执行记录页与任务详情页「最近执行」共用，避免两处样式再次分叉。
 */
export function RecordDetailLink({ onClick }: { onClick: () => void }) {
	return (
		<button
			onClick={(e) => {
				e.stopPropagation();
				onClick();
			}}
			className="group inline-flex h-6 shrink-0 self-center items-center gap-0.5 rounded-md px-1.5 cursor-pointer text-[calc(11px*var(--font-scale))] text-secondary transition-colors hover:bg-surface-hover hover:text-primary"
		>
			详情
			<Icon
				name="chevron-right"
				size={12}
				className="transition-transform duration-150 group-hover:translate-x-0.5"
			/>
		</button>
	);
}
