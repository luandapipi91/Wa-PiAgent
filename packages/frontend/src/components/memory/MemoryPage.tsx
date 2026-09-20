// MemoryPage.tsx — 记忆管理页主容器
import {
	useEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
} from "react";
import { useMemoryStore, type MemoryPageParams } from "../../store/memory";
import { useProjectsStore } from "../../store/projects";
import { useTranslation } from "../../i18n/useTranslation";
import { MemoryCard } from "./MemoryCard";
import { InstructionItem } from "./InstructionItem";
import { MemoryEmpty } from "./MemoryEmpty";
import { DatePickerButton } from "./DatePickerButton";
import { KIND_I18N_KEY, MEMORY_KINDS } from "./kind-label";

export function MemoryPage() {
	const { t } = useTranslation();
	const {
		pageEntries,
		pageHasMore,
		pageCounts,
		pageLoading,
		loadingMore,
		dateFrom,
		dateTo,
		instructions,
		config,
		activeTab,
		scopeFilter,
		kindFilter,
		memoryScope,
		selectedProjectId,
		searchQuery,
		searchResults,
		searchTotalMatched,
		searching,
		searchHasMore,
		searchLoadingMore,
		searchParams,
		load,
		loadInstructions,
		setInstructions,
		setConfig,
		update,
		archive,
		restore,
		purge,
		add,
		setConfigValue,
		setTab,
		setScopeFilter,
		setKindFilter,
		setMemoryScope,
		setSelectedProjectId,
		setSearchQuery,
		search,
		searchMore,
		clearSearch,
		loadPage,
		loadMore,
		setDateRange,
	} = useMemoryStore();

	const currentProjectId = useProjectsStore((s) => s.currentProjectId);
	const projects = useProjectsStore((s) => s.projects);

	// 手动添加记忆表单
	const [showAddForm, setShowAddForm] = useState(false);
	const [newMemoryText, setNewMemoryText] = useState("");

	// 当前查看的项目：优先用户手选（持久 store），回退当前打开项目
	const activeProjectId = selectedProjectId ?? currentProjectId;

	// 首次进入记忆页：若 store 里尚未选过项目且当前有打开的项目，初始化为该项目。
	// 关闭重开设置弹窗时 selectedProjectId 已在 store 中保留，不会被覆盖。
	const initGuard = useRef(false);
	useEffect(() => {
		if (!initGuard.current && selectedProjectId === null && currentProjectId) {
			initGuard.current = true;
			setSelectedProjectId(currentProjectId);
		}
	}, [selectedProjectId, currentProjectId, setSelectedProjectId]);

	// 挂载时拉一次记忆配置（开关状态）；列表改由下方 listParams effect 驱动 loadPage 分页拉取
	useEffect(() => {
		load();
	}, [load]);

	// 指令文件 Tab：进入该 Tab 或切换项目/作用域时加载。
	// 即使 activeProjectId 为 null（无项目上下文），也调用 loadInstructions，
	// 后端 listInstructions 不依赖 projectId 扫描全局指令文件。
	useEffect(() => {
		if (activeTab === "instructions") {
			loadInstructions(activeProjectId ?? "");
		}
	}, [activeProjectId, activeTab, loadInstructions]);

	// 检索态：只要搜索词非空就走服务端结果（含防抖等待与请求在途两段窗口，
	// 那两段 searchResults 仍是上一轮的结果，由 searchPending 显示「检索中」，
	// 不闪旧结果、也不闪本地列表）
	const isSearchActive = searchQuery.trim().length > 0;
	const searchPending =
		searching ||
		searchResults === null ||
		!searchParams ||
		searchParams.query !== searchQuery ||
		searchParams.scope !== memoryScope ||
		searchParams.projectId !== (activeProjectId ?? null) ||
		searchParams.kind !== kindFilter ||
		searchParams.archivedOnly !== (activeTab === "archived") ||
		searchParams.dateFrom !== dateFrom ||
		searchParams.dateTo !== dateTo;

	// 搜索词/作用域/层/Tab/日期窗变化 → 防抖 250ms 后下推服务端 FTS+BM25 检索
	useEffect(() => {
		if (!searchQuery.trim()) {
			clearSearch();
			return;
		}
		const timer = setTimeout(() => {
			search({
				query: searchQuery,
				scope: memoryScope,
				projectId: activeProjectId ?? null,
				kind: kindFilter,
				archivedOnly: activeTab === "archived",
				dateFrom,
				dateTo,
			});
		}, 250);
		return () => clearTimeout(timer);
	}, [
		searchQuery,
		memoryScope,
		activeProjectId,
		kindFilter,
		activeTab,
		dateFrom,
		dateTo,
		search,
		clearSearch,
	]);

	// 非检索态列表参数：scope/tab/kind/日期窗全部下推服务端
	const listParams = useMemo<MemoryPageParams>(
		() => ({
			scope: memoryScope,
			projectId: activeProjectId ?? null,
			tab: activeTab === "archived" ? "archived" : "active",
			kind: kindFilter,
			dateFrom,
			dateTo,
		}),
		[memoryScope, activeProjectId, activeTab, kindFilter, dateFrom, dateTo],
	);

	// 分页拉取：参数（作用域/Tab/层级/日期）变化即重拉第一页；指令文件 Tab 与检索态不拉
	useEffect(() => {
		if (activeTab === "instructions" || isSearchActive) return;
		loadPage(listParams);
	}, [activeTab, isSearchActive, listParams, loadPage]);

	// 滚动加载：哨兵进入视口（预加载余量 120px）且还有下一页时追加。
	// loadingMore/pageEntries 变化时重挂 observer，保证连续翻页能继续触发
	const sentinelRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (activeTab === "instructions" || isSearchActive || !pageHasMore) return;
		const el = sentinelRef.current;
		if (!el) return;
		const ob = new IntersectionObserver(
			(entries) => {
				if (entries[0].isIntersecting) loadMore();
			},
			{ rootMargin: "120px" },
		);
		ob.observe(el);
		return () => ob.disconnect();
	}, [
		activeTab,
		isSearchActive,
		pageHasMore,
		loadingMore,
		pageEntries.length,
		loadMore,
	]);

	// 检索态滚动加载：与列表哨兵同型（内核打分全集物化上限 2000，翻到没有为止）
	const searchSentinelRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (!isSearchActive || searchPending || !searchHasMore) return;
		const el = searchSentinelRef.current;
		if (!el) return;
		const ob = new IntersectionObserver(
			(entries) => {
				if (entries[0].isIntersecting) searchMore();
			},
			{ rootMargin: "120px" },
		);
		ob.observe(el);
		return () => ob.disconnect();
	}, [
		isSearchActive,
		searchPending,
		searchHasMore,
		searchLoadingMore,
		searchResults?.length,
		searchMore,
	]);

	const filteredInstructions = instructions.filter(
		(i) => scopeFilter === "all" || i.scope === scopeFilter,
	);

	// 服务端检索结果块（三态：检索中 / 空态 / 统计行 + 卡片）
	const renderSearchResults = () => (
		<div data-testid="memory-search-results">
			{searchPending ? (
				<div data-testid="memory-search-status">
					<MemoryEmpty type="searching" query={searchQuery.trim()} />
				</div>
			) : searchResults.length > 0 ? (
				<>
					<div
						className="text-[calc(11px*var(--font-scale))] text-tertiary mb-2"
						data-testid="memory-search-total"
					>
						{searchResults.length < searchTotalMatched
							? t("memory.searchTotal", {
									total: searchTotalMatched,
									shown: searchResults.length,
								})
							: t("memory.searchTotalAll", { total: searchTotalMatched })}
					</div>
					{searchResults.map((hit) => (
						<MemoryCard
							key={hit.id}
							entry={{
								id: hit.id,
								text: hit.snippet,
								scope: hit.scope,
								kind: hit.kind,
								createdAt: hit.updatedAt,
								updatedAt: hit.updatedAt,
								projectId: hit.projectId,
							}}
							readOnly
							archivedBadge={hit.archived}
							mode={hit.archived ? "archived" : "active"}
							onArchive={() => archive(activeProjectId ?? "", hit.id)}
							onRestore={() => restore(activeProjectId ?? "", hit.id)}
							onPurge={() => purge(activeProjectId ?? "", hit.id)}
						/>
					))}
					{/* 检索态滚动加载哨兵：searchHasMore 时滚到底部自动 searchMore 追加，
					    「命中 N 条，显示前 M 条」的 N/M 随追加联动更新 */}
					<div ref={searchSentinelRef} data-testid="memory-search-sentinel">
						{searchLoadingMore && (
							<div
								className="text-center py-3 text-[calc(11px*var(--font-scale))] text-tertiary"
								data-testid="memory-search-loading-more"
							>
								{t("memory.loadMoreHint")}
							</div>
						)}
					</div>
				</>
			) : (
				<MemoryEmpty type="search" />
			)}
		</div>
	);

	// 当前筛选下的指令文件数（tab 徽标用，与列表同口径）
	const scopeInstructionsCount = instructions.filter(
		(i) => scopeFilter === "all" || i.scope === scopeFilter,
	).length;

	return (
		<div
			className="flex-1 flex flex-col overflow-hidden"
			data-testid="memory-page"
		>
			{/* 标题栏 + 内联开关 */}
			<div
				className="flex items-center justify-between px-5 py-3.5"
				style={{
					background: "var(--surface)",
					borderBottom: "1px solid var(--hairline)",
				}}
			>
				<h2 className="text-base font-extrabold text-primary m-0">
					{t("memory.pageTitle")}
				</h2>
				<div className="flex items-center gap-4">
					<label
						className="flex items-center gap-2 cursor-pointer"
						data-testid="toggle-review"
					>
						<span className="text-[calc(11.5px*var(--font-scale))] text-secondary">
							{t("memory.toggleReview")}
						</span>
						<ToggleSwitch
							on={config?.reviewEnabled ?? true}
							onChange={(v) => setConfigValue({ reviewEnabled: v })}
						/>
					</label>
					<label
						className="flex items-center gap-2 cursor-pointer"
						data-testid="toggle-inject"
					>
						<span className="text-[calc(11.5px*var(--font-scale))] text-secondary">
							{t("memory.toggleInject")}
						</span>
						<ToggleSwitch
							on={config?.memoryPolicyStyle !== "none"}
							onChange={(v) =>
								setConfigValue({ memoryPolicyStyle: v ? "full" : "none" })
							}
						/>
					</label>
				</div>
			</div>

			{/* Tab 栏 */}
			<div
				className="flex px-5"
				style={{
					background: "var(--surface)",
					borderBottom: "1px solid var(--hairline)",
				}}
			>
				<TabButton
					active={activeTab === "saved"}
					onClick={() => setTab("saved")}
					label={t("memory.tabSaved")}
					count={pageCounts.active}
				/>
				<TabButton
					active={activeTab === "archived"}
					onClick={() => setTab("archived")}
					label={t("memory.tabArchived")}
					count={pageCounts.archived}
				/>
				<TabButton
					active={activeTab === "instructions"}
					onClick={() => setTab("instructions")}
					label={t("memory.tabInstructions")}
					count={scopeInstructionsCount}
				/>
			</div>

			{/* 工具栏 */}
			<div
				className="flex items-center gap-2.5 px-5 py-2.5"
				style={{
					background: "var(--surface)",
					borderBottom: "1px solid var(--hairline)",
				}}
			>
				{activeTab === "instructions" ? (
					// 指令文件筛选：左侧 scope chips，右侧项目选择器
					<>
						<div className="flex gap-1.5">
							{(["all", "project", "global"] as const).map((f) => (
								<FilterChip
									key={f}
									active={scopeFilter === f}
									onClick={() => setScopeFilter(f)}
									label={
										f === "all"
											? t("memory.filterAll")
											: f === "project"
												? t("memory.filterProject")
												: t("memory.filterGlobal")
									}
								/>
							))}
						</div>
						<div className="flex-1" />
						<select
							className="text-[calc(11.5px*var(--font-scale))] px-2.5 py-1 rounded-md"
							style={{
								background: "var(--surface)",
								border: "1px solid var(--hairline)",
								color: "var(--text-primary)",
							}}
							value={selectedProjectId ?? ""}
							onChange={(e) => setSelectedProjectId(e.target.value)}
							data-testid="instruction-project-select"
						>
							{projects.map((p) => (
								<option key={p.id} value={p.id}>
									{p.name}
								</option>
							))}
						</select>
					</>
				) : (
					// 记忆筛选：作用域下拉（默认全局记忆，展开含「全局记忆」+ 项目列表）→ 搜索 → 日期范围 → 层级 → 添加
					<>
						<MemoryScopeDropdown
							memoryScope={memoryScope}
							selectedProjectId={selectedProjectId}
							projects={projects}
							onSelect={(scope, projectId) => {
								setMemoryScope(scope);
								if (projectId) setSelectedProjectId(projectId);
							}}
						/>

						<input
							className="flex-1 text-[calc(12px*var(--font-scale))] px-3 py-1.5 rounded-lg min-w-0"
							style={{
								background: "var(--canvas)",
								border: "1px solid var(--hairline)",
								color: "var(--text-primary)",
							}}
							placeholder={t("memory.searchPlaceholder")}
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							data-testid="memory-search"
						/>
						{/* 日期范围筛选（放在搜索框之后、层级 tab 之前）：from/to 持久在 store（listParams 一并下推服务端），确定/清除时 onChange 上报 */}
						<DatePickerButton
							from={dateFrom}
							to={dateTo}
							onChange={(f, t) => setDateRange(f, t)}
						/>
						{/* 层级筛选（L1 画像 / L2 知识 / L3 执行）：无选中即全部，点已选中的层可取消回全部 */}
						<div className="flex gap-1.5 shrink-0" data-testid="memory-kind-filter">
							{MEMORY_KINDS.map((k) => (
								<FilterChip
									key={k}
									active={kindFilter === k}
									onClick={() => setKindFilter(kindFilter === k ? null : k)}
									label={t(KIND_I18N_KEY[k])}
								/>
							))}
						</div>
						{activeTab === "saved" && (
							<button
								onClick={() => setShowAddForm((v) => !v)}
								className="text-[calc(11px*var(--font-scale))] font-semibold px-3 py-1.5 rounded-md text-white shrink-0"
								style={{ background: "var(--accent)", border: "none" }}
								data-testid="memory-add-button"
							>
								{t("memory.addButton")}
							</button>
						)}
					</>
				)}
			</div>

			{/* 手动添加记忆表单（仅「已保存」Tab 展开时） */}
			{showAddForm && activeTab === "saved" && (
				<div
					className="px-5 py-3"
					style={{
						background: "var(--surface)",
						borderBottom: "1px solid var(--hairline)",
					}}
				>
					<textarea
						className="w-full text-[calc(12px*var(--font-scale))] p-2.5 rounded-lg resize-none"
						style={{
							background: "var(--canvas)",
							border: "1px solid var(--hairline)",
							color: "var(--text-primary)",
							minHeight: 72,
						}}
						placeholder={
							memoryScope === "global"
								? t("memory.addPlaceholderGlobal")
								: t("memory.addPlaceholderProject")
						}
						value={newMemoryText}
						onChange={(e) => setNewMemoryText(e.target.value)}
						data-testid="memory-add-textarea"
					/>
					<div className="flex justify-end gap-2 mt-2">
						<button
							onClick={() => {
								setShowAddForm(false);
								setNewMemoryText("");
							}}
							className="text-[calc(11px*var(--font-scale))] px-3 py-1 rounded-md"
							style={{
								border: "1px solid var(--hairline)",
								color: "var(--text-secondary)",
							}}
						>
							{t("memory.addCancel")}
						</button>
						<button
							onClick={() => {
								const text = newMemoryText.trim();
								if (!text) return;
								add(
									memoryScope,
									text,
									memoryScope === "project" ? (activeProjectId ?? undefined) : undefined,
								);
								setNewMemoryText("");
								setShowAddForm(false);
							}}
							className="text-[calc(11px*var(--font-scale))] font-semibold px-3 py-1 rounded-md text-white"
							style={{ background: "var(--accent)", border: "none" }}
							data-testid="memory-add-save"
						>
							{t("memory.addSave")}
						</button>
					</div>
				</div>
			)}

			{/* 列表内容 */}
			<div className="flex-1 overflow-y-auto px-5 py-3.5">
				{/* 两个记忆 tab 共用同一分页数据源（tab 切换由 listParams 驱动重新拉取） */}
				{activeTab === "saved" &&
					(isSearchActive ? (
						renderSearchResults()
					) : (
						pageEntries.map((m) => (
							<MemoryCard
								key={m.id}
								entry={m}
								onEdit={(text) => update(activeProjectId ?? "", m.id, text)}
								onArchive={() => archive(activeProjectId ?? "", m.id)}
							/>
						))
					))}
				{activeTab === "archived" &&
					(isSearchActive ? (
						renderSearchResults()
					) : (
						pageEntries.map((m) => (
							<MemoryCard
								key={m.id}
								entry={m}
								mode="archived"
								onRestore={() => restore(activeProjectId ?? "", m.id)}
								onPurge={() => purge(activeProjectId ?? "", m.id)}
							/>
						))
					))}
				{activeTab === "instructions" &&
					(filteredInstructions.length === 0 ? (
						<MemoryEmpty type="instructions" />
					) : (
						filteredInstructions.map((inst) => (
							<InstructionItem key={inst.path} instruction={inst} />
						))
					))}
				{/* 非检索态列表底部：滚动哨兵 + 加载中/已加载完/空态 三态 */}
				{!isSearchActive && activeTab !== "instructions" && (
					<div ref={sentinelRef} data-testid="memory-list-sentinel">
						{loadingMore && (
							<div
								data-testid="memory-loading-more"
								className="text-center py-3 text-[calc(11px*var(--font-scale))] text-tertiary"
							>
								{t("memory.loadMoreHint")}
							</div>
						)}
						{!pageHasMore && pageEntries.length > 0 && (
							<div
								data-testid="memory-list-end"
								className="text-center py-3 text-[calc(11px*var(--font-scale))] text-tertiary"
							>
								{t("memory.listEnd", { count: pageEntries.length })}
							</div>
						)}
						{!pageLoading && pageEntries.length === 0 && (
							<MemoryEmpty type="memory" />
						)}
					</div>
				)}
			</div>
		</div>
	);
}

// —— 内联子组件 ——

function TabButton({
	active,
	onClick,
	label,
	count,
}: {
	active: boolean;
	onClick: () => void;
	label: string;
	count: number;
}) {
	return (
		<button
			onClick={onClick}
			className="text-[calc(12px*var(--font-scale))] font-semibold py-1.5 px-3.5"
			style={{
				color: active ? "var(--brand)" : "var(--text-secondary)",
				borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
				marginBottom: -1,
			}}
			data-testid={`tab-${label}`}
		>
			{label}
			<span className="text-[calc(10px*var(--font-scale))] text-tertiary ml-1">
				{count}
			</span>
		</button>
	);
}

function FilterChip({
	active,
	onClick,
	label,
}: {
	active: boolean;
	onClick: () => void;
	label: string;
}) {
	return (
		<button
			onClick={onClick}
			className="text-[calc(11px*var(--font-scale))] font-semibold px-2.5 py-1 rounded-full"
			style={{
				background: active ? "var(--accent-soft)" : "var(--surface)",
				color: active ? "var(--accent)" : "var(--text-secondary)",
				border: active ? "none" : "1px solid var(--hairline)",
			}}
		>
			{label}
		</button>
	);
}

function MemoryScopeDropdown({
	memoryScope,
	selectedProjectId,
	projects,
	onSelect,
}: {
	memoryScope: "global" | "project";
	selectedProjectId: string | null;
	projects: { id: string; name: string }[];
	onSelect: (scope: "global" | "project", projectId?: string) => void;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const label =
		memoryScope === "global"
			? t("memory.scopeGlobalBtn")
			: (projects.find((p) => p.id === selectedProjectId)?.name ??
				t("memory.scopeProjectBtn"));

	const itemStyle = (active: boolean): CSSProperties => ({
		color: active ? "var(--accent)" : "var(--text-primary)",
		background: active ? "var(--accent-soft)" : "transparent",
	});

	return (
		<div className="relative shrink-0">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				className="flex items-center gap-1 text-[calc(11.5px*var(--font-scale))] px-2.5 py-1.5 rounded-md"
				style={{
					background: "var(--surface)",
					border: "1px solid var(--hairline)",
					color: "var(--text-primary)",
				}}
				data-testid="memory-scope-select"
			>
				{label}
				<span className="text-[calc(9px*var(--font-scale))] opacity-70">▾</span>
			</button>
			{open && (
				<>
					{/* 透明遮罩：点击外部关闭菜单 */}
					<div
						className="fixed inset-0 z-10"
						data-testid="memory-scope-backdrop"
						onClick={() => setOpen(false)}
					/>
					<div
						className="absolute left-0 z-20 mt-1 py-1 rounded-md min-w-[148px] max-h-80 overflow-y-auto shadow-lg"
						style={{
							background: "var(--surface)",
							border: "1px solid var(--hairline)",
						}}
						data-testid="memory-scope-menu"
					>
						<button
							type="button"
							onClick={() => {
								onSelect("global");
								setOpen(false);
							}}
							className="block w-full text-left text-[calc(11.5px*var(--font-scale))] px-3 py-1.5"
							style={itemStyle(memoryScope === "global")}
							data-testid="memory-scope-option-global"
						>
							{t("memory.globalOption")}
						</button>
						{projects.length > 0 && (
							<div
								className="my-1"
								style={{ borderTop: "1px solid var(--hairline)" }}
							/>
						)}
						{projects.map((p) => (
							<button
								key={p.id}
								type="button"
								onClick={() => {
									onSelect("project", p.id);
									setOpen(false);
								}}
								className="block w-full text-left text-[calc(11.5px*var(--font-scale))] px-3 py-1.5 truncate"
								style={itemStyle(
									memoryScope === "project" && selectedProjectId === p.id,
								)}
								data-testid={`memory-scope-option-project-${p.id}`}
								title={p.name}
							>
								{t("memory.projectOption", { name: p.name })}
							</button>
						))}
					</div>
				</>
			)}
		</div>
	);
}

function ToggleSwitch({
	on,
	onChange,
}: {
	on: boolean;
	onChange: (v: boolean) => void;
}) {
	return (
		<div
			onClick={() => onChange(!on)}
			className="relative cursor-pointer"
			style={{
				width: 36,
				height: 20,
				borderRadius: 9999,
				background: on ? "var(--accent)" : "var(--hairline-strong)",
				transition: "background 0.2s",
			}}
			data-testid={`toggle-${on ? "on" : "off"}`}
		>
			<div
				className="absolute top-0.5 rounded-full bg-white"
				style={{
					width: 16,
					height: 16,
					left: on ? 18 : 2,
					transition: "left 0.2s",
					boxShadow: "0 1px 3px rgba(0,0,0,.15)",
				}}
			/>
		</div>
	);
}
