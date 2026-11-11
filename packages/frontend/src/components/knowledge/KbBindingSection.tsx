// KbBindingSection — 智能体编辑页的知识库绑定（任务 B5，多选下拉形态）。
//
// 纯展示组件：props 注入 kbs/selected/onToggle/restricted/ready/error，不直接读写 store
//（清单获取与保存过滤由 AgentConfig 接线，便于内嵌任意 tab）。
//   · 收起态单行摘要：已绑定库名用「、」拼接，超出省略号（悬停 title 看全量），
//     不再用一长排复选框把表单撑开
//   · 展开面板：每行=复选框（data-testid="kb-bind-check-{id}"）+ 名称 + 描述单行截断 + 状态摘要
//   · 索引中（scanning/indexing）的库标注「索引完成后可检索」，但仍可勾选（绑定在先、索引完成后生效）
//   · 受限模式（tools 白名单非空）在面板顶部提示「绑定知识库将自动启用搜索工具」：
//     kernel 侧在受限模式下绑定后会自动把 knowledge_search 并入白名单，前端只需明示该行为
//   · selected 中的失效 id（库已删除）不产生任何行、也不进摘要；保存侧由 AgentConfig 再过滤一次
import type { KbInfo } from "@wa-pi/shared";
import { useTranslation } from "../../i18n/useTranslation";
import { MultiSelect, type MultiSelectOption } from "../ui/MultiSelect";

interface Props {
	kbs: KbInfo[];
	selected: string[];
	onToggle: (id: string) => void;
	/** tools 白名单非空即为受限模式（kernel 自动并入搜索工具） */
	restricted?: boolean;
	/**
	 * 清单是否已成功加载过（store.loaded），缺省 true。
	 * false = 清单未知（拉取中/拉取失败）：空清单不得说成「暂无知识库」，
	 * 否则 kernel 未启动时用户会以为库没了、跑去重复登记。
	 */
	ready?: boolean;
	/** 清单拉取失败原因（store.error）；仅在 ready=false 且空清单时展示 */
	error?: string | null;
}

/** 空清单提示：已知为空 → 引导去建库；未知态 → 区分加载中/加载失败 */
function emptyHint(
	ready: boolean,
	failed: boolean,
	t: (k: string) => string,
): string {
	if (ready) return t("kb.bindEmpty");
	return failed ? t("kb.bindLoadFailed") : t("kb.bindLoading");
}

/** 状态摘要：未完成索引的库标注「索引完成后可检索」，error 库明示暂不可检索；就绪复用知识库页徽章文案 */
function statusHint(kb: KbInfo, t: (k: string) => string): string {
	if (kb.status === "ready") return t("kb.statusReady");
	if (kb.status === "error") return t("kb.bindInterrupted");
	// scanning / indexing：索引未完成，可绑定但暂不可检索
	return t("kb.bindAfterIndex");
}

export function KbBindingSection({
	kbs,
	selected,
	onToggle,
	restricted,
	ready = true,
	error = null,
}: Props) {
	const { t } = useTranslation();
	const options: MultiSelectOption[] = kbs.map((kb) => ({
		value: kb.id,
		label: kb.name,
		description: kb.description,
		meta: statusHint(kb, t),
	}));
	const empty = emptyHint(ready, !!error, t);

	return (
		<div data-testid="kb-binding-section" className="flex flex-col gap-1.5">
			<MultiSelect
				testId="kb-bind"
				ariaLabel={t("agentConfig.secKb")}
				options={options}
				selected={selected}
				onToggle={onToggle}
				placeholder={t("kb.bindPlaceholder")}
				/* 无库可绑时提示误导（勾不出任何东西），只在有候选库时提示 */
				hint={restricted && kbs.length > 0 ? t("kb.bindRestrictedHint") : undefined}
			/>
			{/* 空清单/未知态在触发器下方明说原因：失败详情挂 title，不占行 */}
			{kbs.length === 0 && (
				<p
					className="text-[calc(11px*var(--font-scale))] text-tertiary"
					data-testid="kb-bind-status"
					title={!ready && error ? error : undefined}
				>
					{empty}
				</p>
			)}
		</div>
	);
}
