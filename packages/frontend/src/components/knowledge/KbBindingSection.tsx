// KbBindingSection — 智能体编辑页的知识库绑定勾选列表（任务 B5）。
//
// 纯展示组件：props 注入 kbs/selected/onToggle/restricted，不直接读写 store
//（清单获取与保存过滤由 AgentConfig 接线，便于内嵌任意 tab）。
//   · 勾选行 = 复选框（data-testid="kb-bind-check-{id}"）+ 名称 + 描述单行截断 + 状态摘要
//   · 索引中（scanning/indexing）的库标注「索引完成后可检索」，但仍可勾选（绑定在先、索引完成后生效）
//   · 受限模式（tools 白名单非空）显示「绑定知识库将自动启用搜索工具」提示：
//     kernel 侧在受限模式下绑定后会自动把 knowledge_search 并入白名单，前端只需明示该行为
//   · selected 中的失效 id（库已删除）不产生任何行；保存侧由 AgentConfig 再过滤一次
import type { KbInfo } from "@wa-pi/shared";
import { useTranslation } from "../../i18n/useTranslation";

interface Props {
	kbs: KbInfo[];
	selected: string[];
	onToggle: (id: string) => void;
	/** tools 白名单非空即为受限模式（kernel 自动并入搜索工具） */
	restricted?: boolean;
}

/** 状态摘要：未完成索引的库标注「索引完成后可检索」，就绪/失败复用知识库页徽章文案 */
function statusHint(kb: KbInfo, t: (k: string) => string): string {
	if (kb.status === "ready") return t("kb.statusReady");
	if (kb.status === "error") return t("kb.statusInterrupted");
	// scanning / indexing：索引未完成，可绑定但暂不可检索
	return t("kb.bindAfterIndex");
}

export function KbBindingSection({
	kbs,
	selected,
	onToggle,
	restricted,
}: Props) {
	const { t } = useTranslation();
	const selectedSet = new Set(selected);
	return (
		<div data-testid="kb-binding-section">
			{restricted && (
				<p
					className="text-[calc(11px*var(--font-scale))] text-tertiary mb-2"
					data-testid="kb-bind-restricted-hint"
				>
					{t("kb.bindRestrictedHint")}
				</p>
			)}
			{kbs.length === 0 && (
				<p className="text-sm text-tertiary py-1">{t("kb.bindEmpty")}</p>
			)}
			<div className="flex flex-col">
				{kbs.map((kb) => (
					<label
						key={kb.id}
						className="flex items-center gap-2 py-1 cursor-pointer"
					>
						<input
							type="checkbox"
							data-testid={`kb-bind-check-${kb.id}`}
							checked={selectedSet.has(kb.id)}
							onChange={() => onToggle(kb.id)}
						/>
						<span className="text-sm text-primary whitespace-nowrap shrink-0">
							{kb.name}
						</span>
						{/* 描述单行截断：block + truncate（inline 上 text-overflow 不生效，同 SkillDescBubble） */}
						<span className="block min-w-0 flex-1 truncate text-[calc(11px*var(--font-scale))] text-tertiary">
							{kb.description}
						</span>
						<span className="text-[calc(10px*var(--font-scale))] text-tertiary whitespace-nowrap shrink-0">
							{statusHint(kb, t)}
						</span>
					</label>
				))}
			</div>
		</div>
	);
}
