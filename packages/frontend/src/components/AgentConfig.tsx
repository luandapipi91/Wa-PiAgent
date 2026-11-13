import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AgentConfig, AgentName, AgentToolItem } from "@wa-pi/shared";
import { agentDefOf, resolveProviderSlug, isSubagentType } from "@wa-pi/shared";
import { useTranslation } from "../i18n/useTranslation";
import { useAgentsStore } from "../store/agents";
import {
	selectAvailableSkillsForProject,
	skillKeyOf,
	useSkillsStore,
} from "../store/skills";
import { useProjectsStore } from "../store/projects";
import { useProvidersStore } from "../store/providers";
import { useSubagentsStore } from "../store/subagents";
import { useKnowledgeStore } from "../store/knowledge";
import { useToastStore } from "../store/toast";
import { formatApiError } from "../util/kernel-error";
import { api } from "../api-client";
import {
	expandChecked,
	toggleNames,
} from "../agent-mcp-group-tools";
import { SwitchButton } from "./SwitchButton";
import { KbBindingSection } from "./knowledge/KbBindingSection";
import { onMessage } from "../events";
import type { SubagentOverride } from "@wa-pi/shared";
import { Modal } from "./ui/Modal";
import { AgentAvatar } from "./ui/AgentAvatar";
import { avatarBackground } from "./ui/AgentMenuItem";
import {
	AVATAR_ICON_GROUPS,
	AVATAR_ICON_LABELS,
	AVATAR_ICONS,
	type AvatarIconName,
} from "./ui/avatar-icons";
import { filterItems } from "../quick-invoke/trigger";
import { Icon } from "./ui/Icon";

interface Props {
	agentName: AgentName;
	onClose: () => void;
}

type Tab = "basic" | "tools" | "mcp" | "skills" | "partners";

const TABS: { key: Tab; labelKey: string }[] = [
	{ key: "basic", labelKey: "agentConfig.tabBasic" },
	{ key: "tools", labelKey: "agentConfig.tabTools" },
	// MCP 工具单独成 tab：数量多且按服务器分组，与内置/插件工具混排会淹没本地工具
	{ key: "mcp", labelKey: "agentConfig.tabMcp" },
	{ key: "skills", labelKey: "agentConfig.tabSkills" },
	{ key: "partners", labelKey: "agentConfig.tabPartners" },
];

const inp =
	"flex-1 px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none placeholder:text-tertiary";

/** 头像可选图标库（分组）；写入值为 `icon:名称`，存储/REST 格式不变 */

/**
 * 头像图标选择面板：分组标题 + 网格，点选即写入 draft.avatar = `icon:xxx`。
 * createPortal 遮罩层弹层（参照 AgentDropdown 的 portal 模式），点遮罩/图标后关闭。
 */
function AvatarPickerPanel({
	current,
	onPick,
	onClose,
}: {
	current?: string;
	onPick: (icon: AvatarIconName) => void;
	onClose: () => void;
}) {
	// Esc 关闭（capture + stopPropagation：不连带外层 Modal 的 Esc 行为）
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.stopPropagation();
			onClose();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [onClose]);
	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
			onClick={onClose}
			data-testid="cfg-avatar-panel"
		>
			<div
				className="w-[420px] max-w-[90vw] max-h-[70vh] overflow-y-auto bg-surface-elevated border border-hairline rounded-md shadow-lg p-3"
				onClick={(e) => e.stopPropagation()}
			>
				{AVATAR_ICON_GROUPS.map((g) => (
					<div key={g.label} className="mb-2">
						<div className="text-xs text-tertiary mb-1">{g.label}</div>
						<div className="grid grid-cols-6 gap-2">
							{g.icons.map((icon) => {
								const selected = current === `icon:${icon}`;
								return (
									<button
										key={icon}
										type="button"
										aria-pressed={selected}
										data-testid={`avatar-icon-${icon}`}
										title={AVATAR_ICON_LABELS[icon] ?? icon}
										onClick={() => onPick(icon)}
										className={`flex flex-col items-center gap-1 rounded-md py-2 cursor-pointer transition-colors ${selected ? "bg-accent-soft" : "hover:bg-surface-hover"}`}
									>
										<span
											className="inline-block leading-none [&>svg]:w-full [&>svg]:h-full"
											style={{ width: 30, height: 30 }}
											dangerouslySetInnerHTML={{ __html: AVATAR_ICONS[icon] }}
										/>
										<span
											className={`text-[10px] leading-none truncate w-full text-center ${selected ? "text-accent" : "text-tertiary"}`}
										>
											{AVATAR_ICON_LABELS[icon] ?? icon}
										</span>
									</button>
								);
							})}
						</div>
					</div>
				))}
			</div>
		</div>,
		document.body,
	);
}

interface TabProps {
	draft: AgentConfig;
	onChange: (c: AgentConfig) => void;
	/** 内置 subagent（BasicTab 只读展示，知识库绑定除外）：受限提示对其不成立 */
	isBuiltin?: boolean;
}

export function AgentConfig({ agentName, onClose }: Props) {
	const { t } = useTranslation();
	const [tab, setTab] = useState<Tab>("basic");
	const [draft, setDraft] = useState<AgentConfig | null>(null);
	// 用户编辑在途标记：mount 后异步回包（GET config / agent:config 广播）不得覆盖在途编辑，
	// 否则快网手快的用户（E2E）刚做的修改会被晚到的回包静默回滚（E2E 冒烟发现的真实竞态）
	const draftDirtyRef = useRef(false);
	const [tools, setTools] = useState<AgentToolItem[]>([]);
	const config = useAgentsStore((s) => s.configs[agentName]);
	// model 有效性校验：磁盘残留的裸 ID（如 glm-4.6）不匹配 select option（slug/id 格式），视为无效
	const providers = useProvidersStore((s) => s.providers);
	const modelIds = useMemo(() => {
		const slugs: string[] = [];
		const ids = new Set<string>();
		for (const p of providers) {
			const slug = resolveProviderSlug(p, slugs);
			slugs.push(slug);
			for (const m of p.models) ids.add(`${slug}/${m.id}`);
		}
		return ids;
	}, [providers]);

	// 内置 subagent（general-purpose / Explore / Plan）：不在 agents store 里，
	// 用 useSubagentsStore 获取真实 systemPrompt + builtinToolNames（来自 pi-subagents）。
	const isBuiltin = isSubagentType(agentName);
	const builtinInfo = useSubagentsStore((s) =>
		s.subagents.find((i) => i.name === agentName),
	);
	const builtinDraft: AgentConfig | null = useMemo(() => {
		if (!builtinInfo) return null;
		return {
			displayName: builtinInfo.displayName,
			avatar: builtinInfo.emoji,
			avatarColor: `${builtinInfo.gradient[0]}-${builtinInfo.gradient[1]}`,
			description: builtinInfo.description,
			// model/thinking 来自用户 override（无 override 时 null = 跟随主智能体）
			model: builtinInfo.override?.model ?? null,
			thinking: builtinInfo.override?.thinking ?? null,
			// 工具：内置 subagent 的真实 builtinToolNames，只读展示
			tools: builtinInfo.builtinToolNames ?? [],
			skills: [],
			mcpServers: [],
			partners: { askTo: [] },
			delegationHints: builtinInfo.delegationHints,
			// 真实 systemPrompt（来自 pi-subagents），只读展示
			systemPromptBody: builtinInfo.systemPrompt,
			// 知识库绑定来自用户 override（无 override 时空列表），可编辑（保存走 saveOverride）
			knowledgeBaseIds: builtinInfo.override?.knowledgeBaseIds ?? [],
		};
	}, [builtinInfo]);

	// 切换目标智能体（弹窗重开）时复位在途编辑标记。
	// 必须独立成 effect：下方 effect 还会因 builtinDraft（subagent:list 广播导致的 store 重算）重跑，
	// 在那里复位会把在途编辑标记冲掉 —— 广播带来的旧 override 于是盖掉用户未保存的编辑（I-3）
	useEffect(() => {
		draftDirtyRef.current = false;
	}, [agentName]);

	useEffect(() => {
		// 工具列表：内置与命名智能体都需要（工具 tab 展示系统工具全集 + 勾选态）
		api.get("/api/agents/tools").then((data: any) => {
			if (data?.tools) setTools(data.tools);
		});
		// 知识库清单：绑定区展示与保存时失效 id 过滤的依据（B5）
		useKnowledgeStore.getState().listKbs();
		// 内置 subagent 不走 WS 加载，直接用本地构造的 draft；
		// 同样受 dirty 门卫保护：广播导致的 store 重算不得覆盖在途编辑（I-3）
		if (isBuiltin) {
			if (builtinDraft && !draftDirtyRef.current) setDraft(builtinDraft);
			return;
		}
		// 先从 store 缓存设置初始值（如果已有），然后通过 API 拉取最新数据覆盖
		useAgentsStore.getState().loadConfig(agentName);
		// 强制 API 重新加载，覆盖可能过期的 store 缓存（修复关闭重开后显示旧数据）
		api
			.get(`/api/agents/${encodeURIComponent(agentName)}/config`)
			.then((data: any) => {
				if (data?.config) {
					useAgentsStore.getState().setConfig(agentName, data.config);
					if (!draftDirtyRef.current) setDraft(data.config);
				}
			})
			.catch(() => {});
		const off = onMessage((e) => {
			if (e.type === "agent:config" && e.agentName === agentName)
				if (!draftDirtyRef.current) setDraft(e.config);
			if (e.type === "agent:tools:list") setTools(e.tools);
		});
		return off;
	}, [agentName, isBuiltin, builtinDraft]);

	const allAgents = useAgentsStore((s) => s.list);

	useEffect(() => {
		if (config && !draft && !isBuiltin) setDraft(config);
	}, [config, draft, isBuiltin]);

	// 重名校验：displayName 与其他智能体重复（自身原名除外）；空名也禁保存
	const trimmedName = draft?.displayName?.trim() ?? "";
	const nameConflict =
		trimmedName !== "" &&
		trimmedName !== agentName &&
		allAgents.some((a) => a.displayName === trimmedName);
	const nameEmpty = trimmedName === "";

	const canSave = !!draft && (isBuiltin || (!nameEmpty && !nameConflict));
	// 保存在途：保存期间禁用保存按钮，且阻止重复提交（成功才关窗，失败留在弹窗里重试）
	const [saving, setSaving] = useState(false);

	const handleChange = (next: AgentConfig) => {
		draftDirtyRef.current = true;
		setDraft(next);
	};

	const save = async () => {
		if (!draft || saving) return;
		// 绑定的知识库过滤失效 id（审查重点 2）；但仅在清单已知（loaded）时过滤——
		// 清单未知态（未加载成功：拉取中/失败）不得当空态，否则既有绑定会被静默清空（审查修复 1）
		const kbStore = useKnowledgeStore.getState();
		let kbIds = Array.isArray(draft.knowledgeBaseIds)
			? draft.knowledgeBaseIds
			: [];
		if (kbStore.loaded) {
			const kbKnown = new Set(kbStore.kbs.map((k) => k.id));
			kbIds = kbIds.filter((id) => kbKnown.has(id));
		}
		if (!isBuiltin && !canSave) return;
		setSaving(true);
		try {
			if (isBuiltin) {
				const validModel =
					modelIds.size > 0 && draft.model && !modelIds.has(draft.model)
						? null
						: draft.model;
				const override: SubagentOverride = {
					type: agentName,
					model: validModel ?? null,
					thinking: draft.thinking ?? null,
					knowledgeBaseIds: kbIds,
				};
				await useSubagentsStore.getState().saveOverride(override);
			} else {
				// model 无效（磁盘残留裸 ID 不匹配 option）时置 null（跟随全局），避免"显示跟随全局但保存旧值"
				const configToSend =
					modelIds.size > 0 && draft.model && !modelIds.has(draft.model)
						? { ...draft, model: null, knowledgeBaseIds: kbIds }
						: { ...draft, knowledgeBaseIds: kbIds };
				// 名称可能被改：agentName 为旧 displayName，draft.displayName 为新值，kernel 走 rename 联动
				await api.put(`/api/agents/${encodeURIComponent(agentName)}/config`, {
					config: configToSend,
				});
			}
		} catch (e) {
			// 保存失败：不关弹窗，把错误带给用户（此前静默吞错，用户以为已保存）
			useToastStore.getState().add(formatApiError(e), "error");
			return;
		} finally {
			setSaving(false);
		}
		onClose();
	};

	const def = agentDefOf(agentName);
	const [hg1, hg2] = draft?.avatarColor?.includes("-")
		? draft.avatarColor.split("-")
		: def.gradient;

	return (
		<Modal
			onClose={onClose}
			width="80vw"
			height="80vh"
			closeOnOverlayClick={false}
			data-testid="agent-config"
		>
			<header className="flex items-center gap-3 px-5 py-3.5 border-b border-hairline">
				<AgentAvatar
					avatar={draft?.avatar}
					fallback={def.emoji}
					background={`linear-gradient(135deg, ${hg1}, ${hg2})`}
					className="w-9 h-9 rounded-lg"
					textClassName="text-lg"
					iconSize={26}
					testId="cfg-avatar-preview"
				/>
				<div className="flex-1 min-w-0">
					<div className="text-sm font-semibold text-primary truncate">
						{draft?.displayName ?? agentName}
					</div>
				</div>
				<button
					onClick={onClose}
					className="text-tertiary text-xs"
					data-testid="agent-config-close"
					aria-label={t("common.close")}
				>
					✕
				</button>
			</header>
			<nav className="flex gap-1 px-4 pt-2 border-b border-hairline">
				{TABS.map((tb) => (
					<button
						key={tb.key}
						onClick={() => setTab(tb.key)}
						data-testid={`tab-${tb.key}`}
						className={`px-3 py-1.5 text-xs rounded-t-sm transition-colors ${tab === tb.key ? "text-primary font-semibold bg-surface-hover" : "text-tertiary hover:text-secondary"}`}
					>
						{t(tb.labelKey)}
					</button>
				))}
			</nav>
			{/* 滚动容器只负责滚动，不再挂 pointer-events-none：
			    挂在滚动容器上会让内部内容命中穿透到 Modal 包装层（非滚动容器的后代），
			    滚轮事件到不了滚动容器 → 只读面板的列表滚不动。只读的 pointer-events-none
			    下移到内层内容包装（滚动条与滚轮仍归滚动容器） */}
			<div
				className="px-5 py-4 flex-1 min-h-0 overflow-y-auto"
				data-testid="config-tab-content"
			>
				<div
					data-testid="config-tab-inner"
					className={
						isBuiltin
							? "pointer-events-none [&_select]:pointer-events-auto"
							: undefined
					}
				>
					{!draft && (
						<p className="text-sm text-tertiary">
							{t("agentConfig.loading")}
						</p>
					)}
					{/* 内置 subagent：所有字段只读，onChange 用 noop 防止编辑 */}
					{draft && tab === "basic" && (
						<BasicTab
							draft={draft}
							onChange={handleChange}
							isBuiltin={isBuiltin}
						/>
					)}
					{draft && tab === "tools" && (
						<ToolsTab draft={draft} onChange={handleChange} tools={tools} />
					)}
					{draft && tab === "mcp" && (
						<McpTab draft={draft} onChange={handleChange} tools={tools} />
					)}
					{draft && tab === "skills" && (
						<SkillsTab draft={draft} onChange={handleChange} />
					)}
					{draft && tab === "partners" && (
						<PartnersTab
							draft={draft}
							onChange={handleChange}
							selfName={agentName}
						/>
					)}
				</div>
			</div>
			<footer className="flex justify-end gap-2 px-5 py-3 border-t border-hairline">
				{isBuiltin && (
					<span
						data-testid="cfg-builtin-notice"
						className="text-[calc(11px*var(--font-scale))] text-tertiary self-center mr-auto"
					>
						{t("agentConfig.builtinNotice")}
					</span>
				)}
				{!isBuiltin && nameConflict && (
					<span
						data-testid="cfg-name-error"
						className="text-[calc(11px*var(--font-scale))] text-danger self-center mr-auto"
					>
						{t("agentConfig.nameConflict", { name: trimmedName })}
					</span>
				)}
				<button
					onClick={onClose}
					className="px-3 py-1.5 rounded-sm text-xs bg-surface-hover text-secondary border border-hairline transition-colors hover:text-primary"
				>
					{t("common.close")}
				</button>
				<button
					onClick={save}
					disabled={!canSave || saving}
					data-testid="cfg-save"
					className="px-3 py-1.5 rounded-sm text-xs border-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
					style={{ background: "var(--accent)", color: "#fff" }}
				>
					{t("common.save")}
				</button>
			</footer>
		</Modal>
	);
}

function Sec({ children }: { children: string }) {
	return (
		<div className="flex items-center gap-2 mt-4 first:mt-0 mb-2">
			<span className="text-[calc(11px*var(--font-scale))] tracking-wide text-tertiary uppercase">
				{children}
			</span>
			<span className="flex-1 h-px bg-hairline" />
		</div>
	);
}

function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<label className="flex items-center gap-2 mb-2">
			<span className="w-12 shrink-0 text-xs text-secondary">{label}</span>
			{children}
		</label>
	);
}

function BasicTab({ draft, onChange, isBuiltin }: TabProps) {
	const { t } = useTranslation();
	// 头像图标面板开关（点头像块弹出）
	const [avatarPanelOpen, setAvatarPanelOpen] = useState(false);
	// 知识库绑定（B5）：清单来自 knowledge store（AgentConfig mount 时已拉取）；
	// 受限判定：tools 白名单非空（空数组 = 全量默认），此时绑定会自动启用搜索工具需明示；
	// 内置 subagent 豁免——kernel 的 restricted 白名单语义只对命名 agent 的 config.tools 生效，
	// 内置走全放行，提示对其不成立
	const kbs = useKnowledgeStore((s) => s.kbs);
	// 清单未知（拉取中/失败）≠ 空清单：绑定区据此区分「加载中/加载失败」与「暂无知识库」
	const kbLoaded = useKnowledgeStore((s) => s.loaded);
	const kbError = useKnowledgeStore((s) => s.error);
	const restricted =
		!isBuiltin && Array.isArray(draft.tools) && draft.tools.length > 0;
	const kbIds = Array.isArray(draft.knowledgeBaseIds)
		? draft.knowledgeBaseIds
		: [];
	const toggleKb = (id: string) => {
		const next = kbIds.includes(id)
			? kbIds.filter((x) => x !== id)
			: [...kbIds, id];
		onChange({ ...draft, knowledgeBaseIds: next });
	};
	// 模型下拉：扁平化 providers（同 ModelSelector），slug/id 作为 option value
	const providers = useProvidersStore((s) => s.providers);
	const models = useMemo(() => {
		const slugs: string[] = [];
		return providers.flatMap((p) => {
			const slug = resolveProviderSlug(p, slugs);
			slugs.push(slug);
			return p.models.map((m) => ({
				id: m.id,
				providerName: p.name,
				providerSlug: slug,
			}));
		});
	}, [providers]);
	// model option value 集合：draft.model 若不在其中（如磁盘残留的裸 ID），select 视为未选中（跟随全局）
	const modelIds = useMemo(
		() => new Set(models.map((m) => `${m.providerSlug}/${m.id}`)),
		[models],
	);
	const effectiveModel =
		draft.model && modelIds.has(draft.model) ? draft.model : "";

	return (
		<div>
			<Sec>{t("agentConfig.secIdentity")}</Sec>
			<Row label={t("agentConfig.labelName")}>
				<input
					value={draft.displayName}
					onChange={(e) => onChange({ ...draft, displayName: e.target.value })}
					className={inp}
					data-testid="cfg-name-input"
				/>
			</Row>
			<Row label={t("agentConfig.labelDesc")}>
				<input
					value={draft.description}
					onChange={(e) => onChange({ ...draft, description: e.target.value })}
					className={inp}
				/>
			</Row>
			<Row label={t("agentConfig.labelAvatar")}>
				<button
					type="button"
					onClick={() => setAvatarPanelOpen(true)}
					className="w-14 h-9 rounded-sm border border-hairline bg-surface flex items-center justify-center cursor-pointer hover:border-hairline-strong transition-colors"
					data-testid="cfg-avatar-button"
					aria-label={t("agentConfig.labelAvatar")}
				>
					<AgentAvatar
						avatar={draft.avatar}
						fallback=""
						background={avatarBackground(draft.avatarColor)}
						iconSize={26}
						textClassName="text-lg"
						testId="cfg-avatar-preview-inline"
					/>
				</button>
			</Row>
			{avatarPanelOpen && (
				<AvatarPickerPanel
					current={draft.avatar}
					onPick={(icon) => {
						onChange({ ...draft, avatar: `icon:${icon}` });
						setAvatarPanelOpen(false);
					}}
					onClose={() => setAvatarPanelOpen(false)}
				/>
			)}

			<Sec>{t("agentConfig.secModel")}</Sec>
			<Row label={t("agentConfig.labelModel")}>
				<select
					value={effectiveModel}
					onChange={(e) => onChange({ ...draft, model: e.target.value || null })}
					className={inp}
					data-testid="cfg-model-select"
				>
					<option value="">{t("agentConfig.modelDefault")}</option>
					{models.map((m) => (
						<option
							key={`${m.providerSlug}/${m.id}`}
							value={`${m.providerSlug}/${m.id}`}
						>
							{m.providerName}/{m.id}
						</option>
					))}
				</select>
			</Row>
			<Row label={t("agentConfig.labelThinking")}>
				<select
					value={draft.thinking ?? ""}
					onChange={(e) =>
						onChange({
							...draft,
							thinking: (e.target.value || null) as AgentConfig["thinking"],
						})
					}
					className={inp}
					data-testid="cfg-thinking-select"
				>
					<option value="">{t("agentConfig.thinkingFollow")}</option>
					<option value="disabled">{t("agentConfig.thinkingOff")}</option>
					<option value="medium">{t("agentConfig.thinkingMid")}</option>
					<option value="high">{t("agentConfig.thinkingHigh")}</option>
					<option value="max">{t("agentConfig.thinkingMax")}</option>
				</select>
			</Row>

			<Sec>{t("agentConfig.secKb")}</Sec>
			{/* 内置 subagent 的 BasicTab 整体只读（pointer-events-none），
			    知识库绑定是 override 可编辑字段，单独豁免可点 */}
			<div className="pointer-events-auto">
				<KbBindingSection
					kbs={kbs}
					selected={kbIds}
					onToggle={toggleKb}
					restricted={restricted}
					ready={kbLoaded}
					error={kbError}
				/>
			</div>

			<Sec>{t("agentConfig.secPrompt")}</Sec>
			<textarea
				value={draft.systemPromptBody ?? ""}
				onChange={(e) => onChange({ ...draft, systemPromptBody: e.target.value })}
				className={`${inp} w-full min-h-[300px] resize-y leading-relaxed`}
				rows={4}
			/>

			<Sec>{t("agentConfig.secDelegateHints")}</Sec>
			<Row label={t("agentConfig.labelWhenToDelegate")}>
				<textarea
					value={draft.delegationHints?.whenToDelegate ?? ""}
					onChange={(e) =>
						onChange({
							...draft,
							delegationHints: {
								...draft.delegationHints,
								whenToDelegate: e.target.value,
							},
						})
					}
					className={`${inp} w-full min-h-[56px] resize-y leading-relaxed`}
					rows={2}
					placeholder={t("agentConfig.hintsWhenPlaceholder")}
					data-testid="cfg-hints-when"
				/>
			</Row>
			<Row label={t("agentConfig.labelWhenNotTo")}>
				<textarea
					value={draft.delegationHints?.whenNotTo ?? ""}
					onChange={(e) =>
						onChange({
							...draft,
							delegationHints: {
								...draft.delegationHints,
								whenNotTo: e.target.value,
							},
						})
					}
					className={`${inp} w-full min-h-[56px] resize-y leading-relaxed`}
					rows={2}
					placeholder={t("agentConfig.hintsNotPlaceholder")}
					data-testid="cfg-hints-not"
				/>
			</Row>
			<Row label={t("agentConfig.labelBenefit")}>
				<textarea
					value={draft.delegationHints?.benefit ?? ""}
					onChange={(e) =>
						onChange({
							...draft,
							delegationHints: {
								...draft.delegationHints,
								benefit: e.target.value,
							},
						})
					}
					className={`${inp} w-full min-h-[56px] resize-y leading-relaxed`}
					rows={2}
					placeholder={t("agentConfig.hintsBenefitPlaceholder")}
					data-testid="cfg-hints-benefit"
				/>
			</Row>
		</div>
	);
}

// MCP 入口工具（pi 的 ensureDiscoveryActive）：非「直接可用」的 MCP 工具必须靠它到达。
// kernel 无论用户勾没勾都会把它并进白名单（resolveAgentTools 无条件合并枚举结果），
// 所以界面上不再展示（既不给开关也不占条目），只保留过滤逻辑（T7 复审登记）。
const isMcpEntryTool = (name: string) =>
	name === "codemode" || name === "tool_search";

// 展示态勾选展开与批量切换用顶部导入的 agent-mcp-group-tools：纯函数已抽出单测，
// 并支持服务器粒度通配（mcp__agent_browser__* 视为整组开启，存量智能体回填态）

/** 从 `mcp__<server>__<tool>` 解析服务器名与短工具名；前缀不匹配的归入「其他」 */
function parseMcpToolName(name: string): { server: string; short: string } {
	const parts = name.split("__");
	if (parts.length >= 3 && parts[0] === "mcp" && parts[1]) {
		return { server: parts[1], short: parts.slice(2).join("__") };
	}
	return { server: "其他", short: name };
}

/** 工具行：名称（+ 来源标签）+ 可选描述 + 开关；普通工具与 MCP 工具共用 */
function ToolRow({
	name,
	label,
	source,
	description,
	on,
	onToggle,
}: {
	name: string;
	label: string;
	source: string;
	/** 可选：MCP 服务器官方描述或内置工具中文简介；第三方插件可能没有 */
	description?: string;
	on: boolean;
	onToggle: () => void;
}) {
	return (
		<label className="flex items-center gap-2 py-1 cursor-pointer justify-between">
			<span className="flex flex-col min-w-0">
				<span className="flex items-center gap-2">
					<span className="text-sm text-primary">{label}</span>
					<span
						className="text-[calc(10px*var(--font-scale))] px-1.5 py-0.5 rounded-full"
						style={{
							background: "var(--hairline)",
							color: "var(--text-tertiary)",
						}}
					>
						{source}
					</span>
				</span>
				{/* 描述行：单行截断，title 保留完整原文（MCP 描述可能很长）；无描述时不渲染 */}
				{description && (
					<span
						data-testid={`tool-desc-${name}`}
						title={description}
						className="text-[calc(11px*var(--font-scale))] text-tertiary truncate"
					>
						{description}
					</span>
				)}
			</span>
			<SwitchButton on={on} onClick={onToggle} testId={`tool-switch-${name}`} />
		</label>
	);
}

function ToolsTab({
	draft,
	onChange,
	tools,
}: TabProps & { tools: AgentToolItem[] }) {
	const { t } = useTranslation();
	// 工具 tab 只保留非 MCP 工具（内置 + 插件）；MCP 工具全部移到 MCP tab
	const plainTools = tools.filter(
		(tl) => tl.source !== "MCP" && !isMcpEntryTool(tl.name),
	);
	// 勾选基准始终是全部可选项（普通 + MCP），保证跨 tab 切换时不会误删另一侧的工具
	const all = tools.filter((tl) => !isMcpEntryTool(tl.name)).map((tl) => tl.name);
	// 防御：draft.tools 可能因磁盘残留/API 兼容性为非数组，统一规范化为 []
	const dtools: string[] = Array.isArray(draft.tools) ? draft.tools : [];
	const checked = new Set(expandChecked(dtools, all));
	const toggle = (n: string) =>
		onChange({ ...draft, tools: toggleNames(dtools, all, [n]) });
	if (tools.length === 0)
		return <p className="text-sm text-tertiary">{t("agentConfig.loading")}</p>;
	return (
		<div className="flex flex-col">
			<p className="text-[calc(11px*var(--font-scale))] text-tertiary mb-2">
				{t("agentConfig.toolsHint")}
			</p>
			{plainTools.map((tl) => (
				<ToolRow
					key={tl.name}
					name={tl.name}
					label={tl.name}
					source={tl.source}
					description={tl.description}
					on={checked.has(tl.name)}
					onToggle={() => toggle(tl.name)}
				/>
			))}
		</div>
	);
}

function McpTab({
	draft,
	onChange,
	tools,
}: TabProps & { tools: AgentToolItem[] }) {
	const { t } = useTranslation();
	const mcpTools = tools.filter(
		(tl) => tl.source === "MCP" && !isMcpEntryTool(tl.name),
	);
	// 勾选基准始终是全部可选项（普通 + MCP），与工具 tab 共用同一条保存链路
	const all = tools.filter((tl) => !isMcpEntryTool(tl.name)).map((tl) => tl.name);
	// 防御：draft.tools 可能因磁盘残留/API 兼容性为非数组，统一规范化为 []
	const dtools: string[] = Array.isArray(draft.tools) ? draft.tools : [];
	const checked = new Set(expandChecked(dtools, all));
	const toggle = (names: string[]) =>
		onChange({ ...draft, tools: toggleNames(dtools, all, names) });
	// 折叠状态：纯 UI 状态（不写进 draft/config，也不跨弹窗持久化），默认全部收起
	const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
	const toggleGroup = (server: string) => {
		setOpenGroups((prev) => {
			const next = new Set(prev);
			if (next.has(server)) next.delete(server);
			else next.add(server);
			return next;
		});
	};
	// 按服务器名分组，组按服务器名字母序排列；服务器名无法解析的归入「其他」
	const groups = new Map<
		string,
		{ name: string; short: string; description?: string }[]
	>();
	for (const tl of mcpTools) {
		const { server, short } = parseMcpToolName(tl.name);
		const list = groups.get(server) ?? [];
		list.push({ name: tl.name, short, description: tl.description });
		groups.set(server, list);
	}
	const servers = Array.from(groups.keys()).sort((a, b) =>
		a.localeCompare(b, "zh-CN"),
	);
	return (
		<div className="flex flex-col">
			<p className="text-[calc(11px*var(--font-scale))] text-tertiary">
				{t("agentConfig.toolsHint")}
			</p>
			<p className="text-[calc(11px*var(--font-scale))] text-tertiary mb-2">
				{t("agentConfig.mcpGroupHint")}
			</p>
			{groups.size === 0 && (
				<p className="text-sm text-tertiary">{t("agentConfig.mcpEmpty")}</p>
			)}
			{servers.map((server) => {
				const items = groups.get(server)!;
				const names = items.map((i) => i.name);
				// 组开关 on = 该组全部工具已勾选；点击即整组取消 / 整组勾上
				const allOn = names.every((n) => checked.has(n));
				const open = openGroups.has(server);
				return (
					<div
						key={server}
						className="mt-3 first:mt-0"
						data-testid={`mcp-group-${server}`}
					>
						<div className="flex items-center gap-2 justify-between mb-1">
							{/* 组头整体可点：切换折叠；开关单独 stopPropagation，不触发折叠 */}
							<button
								type="button"
								onClick={() => toggleGroup(server)}
								data-testid={`mcp-group-toggle-${server}`}
								aria-expanded={open}
								className="flex items-center gap-1 p-0 bg-transparent border-0 cursor-pointer text-left text-[calc(13px*var(--font-scale))] text-brand font-semibold"
							>
								<Icon
									name={open ? "chevron-down" : "chevron-right"}
									size={12}
								/>
								<span>{`${server} · ${items.length}`}</span>
							</button>
							<SwitchButton
								on={allOn}
								onClick={() => toggle(names)}
								testId={`mcp-group-switch-${server}`}
							/>
						</div>
						{/* 收起时不渲染组内工具行 */}
						{open && (
							<div data-testid={`mcp-group-body-${server}`}>
								{items.map((item) => (
									<ToolRow
										key={item.name}
										name={item.name}
										label={item.short}
										source="MCP"
										description={item.description}
										on={checked.has(item.name)}
										onToggle={() => toggle([item.name])}
									/>
								))}
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}

function SkillsTab({ draft, onChange }: TabProps) {
	const { t } = useTranslation();
	const allSkills = useSkillsStore((s) => s.allSkills);
	const disabledSkills = useSkillsStore((s) => s.disabledSkills);
	// 当前项目下实际可用的技能（排除他项目技能与同名被遮蔽者）：
	// 白名单按技能名匹配，只有这里列出的技能在该项目会话里才真能被 pi 加载
	const currentProjectId = useProjectsStore((s) => s.currentProjectId);
	const availableSkills = useMemo(
		() => selectAvailableSkillsForProject(allSkills, currentProjectId),
		[allSkills, currentProjectId],
	);
	const all = availableSkills.map((s) => s.name);
	// 防御：draft.skills 可能因磁盘残留为非数组，统一规范化为 []
	const skills: string[] = Array.isArray(draft.skills) ? draft.skills : [];
	// 显式全不选：skillsAllOff=true 时不加载任何技能；与 skills:[] 的"继承全部"区分
	const allOff = draft.skillsAllOff === true;
	// 全部选中态 = 非全不选且空数组（继承全部）。逐项勾选态：非全不选且（空数组=全选 或 在白名单内）
	const allChecked = !allOff && skills.length === 0;
	const checked = (n: string) =>
		!allOff && (skills.length === 0 || skills.includes(n));

	// 全选开关：全选→点击变全不选；非全选（部分/全不选）→点击变全选
	const toggleAll = () => {
		if (allChecked) {
			onChange({ ...draft, skills: [], skillsAllOff: true });
		} else {
			onChange({ ...draft, skills: [], skillsAllOff: undefined });
		}
	};
	// 逐项切换：取消至全部为空时归一化为全不选（skillsAllOff:true），避免落回"继承全部"
	const toggle = (n: string) => {
		if (allOff) {
			// 全不选态下勾选某项 → 转为只含该项的显式列表
			onChange({ ...draft, skills: [n], skillsAllOff: undefined });
			return;
		}
		const next =
			skills.length === 0
				? all.filter((x) => x !== n)
				: skills.includes(n)
					? skills.filter((x) => x !== n)
					: [...skills, n];
		// 全部取消 → 归一化为显式全不选
		if (next.length === 0) {
			onChange({ ...draft, skills: [], skillsAllOff: true });
		} else {
			onChange({ ...draft, skills: next, skillsAllOff: undefined });
		}
	};
	if (availableSkills.length === 0)
		return (
			<p className="text-sm text-tertiary">{t("agentConfig.skillsEmpty")}</p>
		);
	return (
		<div className="flex flex-col">
			{/* 全部勾选开关：ON=继承全部；点击在全选↔全不选间切换 */}
			<div className="flex items-center gap-2 py-1 justify-between border-b border-hairline mb-1">
				<span className="text-[calc(11px*var(--font-scale))] text-secondary font-semibold">
					{t("agentConfig.skillsSelectAll")}
				</span>
				<SwitchButton
					on={allChecked}
					onClick={toggleAll}
					testId="skill-select-all"
				/>
			</div>
			{availableSkills.map((s) => {
				const globallyDisabled = disabledSkills.includes(s.name);
				return (
					<label
						key={skillKeyOf(s.source, s.name)}
						data-testid={`skill-row-${s.name}`}
						className="flex items-center gap-2 py-1 cursor-pointer justify-between"
						style={{ opacity: globallyDisabled ? 0.5 : 1 }}
					>
						<span className="flex items-center gap-2 min-w-0 flex-1">
							<span
								data-testid={`skill-name-${s.name}`}
								className="text-sm text-primary whitespace-nowrap shrink-0"
							>
								{s.name}
							</span>
							<SkillDescBubble name={s.name} description={s.description} />
							{globallyDisabled && (
								<span
									data-testid={`skill-disabled-label-${s.name}`}
									className="text-[calc(10px*var(--font-scale))] font-semibold whitespace-nowrap shrink-0"
									style={{ color: "var(--danger)" }}
								>
									{t("agentConfig.skillsGlobalDisabled")}
								</span>
							)}
						</span>
						<SwitchButton
							on={checked(s.name)}
							onClick={() => toggle(s.name)}
							testId={`skill-switch-${s.name}`}
						/>
					</label>
				);
			})}
		</div>
	);
}

/**
 * 技能描述：超长省略 + 点击弹出气泡显示完整内容。
 * 点击描述切换气泡显隐；点击气泡外部（document click）自动关闭。
 */
function SkillDescBubble({
	name,
	description,
}: {
	name: string;
	description: string;
}) {
	const [open, setOpen] = useState(false);
	// 点击外部关闭：监听 document click，气泡内/触发器的点击通过 stopPropagation 排除
	useEffect(() => {
		if (!open) return;
		const onDocClick = () => setOpen(false);
		document.addEventListener("click", onDocClick);
		return () => document.removeEventListener("click", onDocClick);
	}, [open]);
	if (!description) return null;
	// flex-1 min-w-0：占满技能名与开关之间的剩余宽度并允许收缩；
	// 描述需为块级容器，truncate（overflow/text-overflow）在 inline 元素上不生效
	return (
		<span className="relative min-w-0 flex-1">
			<span
				data-testid={`skill-desc-${name}`}
				className="block text-[calc(11px*var(--font-scale))] text-tertiary truncate cursor-pointer hover:text-secondary"
				onClick={(e) => {
					e.stopPropagation();
					setOpen((v) => !v);
				}}
			>
				{description}
			</span>
			{open && (
				<span
					data-testid={`skill-desc-bubble-${name}`}
					className="absolute z-50 top-full left-0 mt-1 px-2 py-1 rounded-sm shadow-lg whitespace-normal break-all"
					style={{
						background: "var(--surface)",
						border: "1px solid var(--hairline)",
						color: "var(--text-primary)",
						maxWidth: "16rem",
						fontSize: "calc(11px*var(--font-scale))",
					}}
					onClick={(e) => e.stopPropagation()}
				>
					{description}
				</span>
			)}
		</span>
	);
}

function PartnersTab({
	draft,
	onChange,
	selfName,
}: TabProps & { selfName: string }) {
	const { t } = useTranslation();
	const agents = useAgentsStore((s) => s.list);
	const [query, setQuery] = useState("");
	const filtered = filterItems(
		agents.map((a) => ({ ...a, name: a.displayName })),
		query,
	);
	const toggle = (n: string) => {
		const cur = draft.partners.askTo;
		const next = cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n];
		onChange({ ...draft, partners: { ...draft.partners, askTo: next } });
	};
	return (
		<div className="flex flex-col gap-2">
			<input
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				placeholder={t("agentConfig.partnerSearchPlaceholder")}
				className={`${inp} w-full`}
				data-testid="partner-search"
			/>
			<div className="flex flex-col">
				{filtered.length === 0 && (
					<p className="text-sm text-tertiary py-1">
						{t("agentConfig.partnerNoMatch")}
					</p>
				)}
				{filtered.map((a) => {
					const isSelf = a.displayName === selfName;
					const checked = !isSelf && draft.partners.askTo.includes(a.displayName);
					return (
						<label
							key={a.displayName}
							aria-disabled={isSelf || undefined}
							className={`flex items-center gap-2 py-1 ${isSelf ? "opacity-50" : "cursor-pointer"} justify-between`}
						>
							<span className="flex items-center gap-2 min-w-0">
								<span className="text-sm text-primary">{a.displayName}</span>
								<span className="text-[calc(11px*var(--font-scale))] text-tertiary truncate">
									{a.description}
								</span>
								{isSelf && (
									<span className="text-[calc(10px*var(--font-scale))] text-tertiary shrink-0">
										{t("agentConfig.partnerSelf")}
									</span>
								)}
							</span>
							<SwitchButton
								on={checked}
								onClick={() => {
									if (!isSelf) toggle(a.displayName);
								}}
								testId={`partner-switch-${a.displayName}`}
							/>
						</label>
					);
				})}
			</div>
			<p className="text-[calc(11px*var(--font-scale))] text-tertiary">
				{t("agentConfig.partnerHint")}
			</p>
		</div>
	);
}

