import { useEffect, useState } from "react";
import { resolveProviderSlug, type ChannelType } from "@wa-pi/shared";
import { useChannelsStore, type ChannelInput } from "../../store/channels";
import { useAgentsStore } from "../../store/agents";
import { useProvidersStore } from "../../store/providers";
import { useToastStore } from "../../store/toast";
import { AgentDropdown } from "../ui/AgentDropdown";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { SkillSuggestTextarea } from "../ui/SkillSuggestTextarea";
import { NewBotDialog } from "./NewBotDialog";

const STATUS_DOT: Record<string, string> = {
	connected: "var(--success)",
	connecting: "var(--warning)",
	error: "var(--danger)",
	disconnected: "var(--hairline-strong)",
};
const STATUS_TEXT: Record<string, string> = {
	connected: "已连接", connecting: "连接中", error: "异常", disconnected: "未连接",
};

/** 新建草稿的默认值 */
function emptyDraft(type: ChannelType): ChannelInput {
	return {
		type, name: "", enabled: true,
		credentials: { botId: "", secret: "" },
		agentName: "", model: null,
		extraSystemPrompt: "", replyGranularity: "standard",
	};
}

export function BotsSection() {
	const bots = useChannelsStore((s) => s.bots);
	const { loadBots, createBot, updateBot, deleteBot } = useChannelsStore.getState();
	const agents = useAgentsStore((s) => s.list);
	const providers = useProvidersStore((s) => s.providers);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [draft, setDraft] = useState<ChannelInput | null>(null); // 非 null = 新建/编辑中的表单
	const [showNew, setShowNew] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);

	useEffect(() => { void loadBots(); }, []);

	// 模型选项（与 ModelSelector 同源：providerSlug/modelId），首项「跟随智能体」
	const modelOptions = (() => {
		const slugs: string[] = [];
		return providers.flatMap((p) => {
			const slug = resolveProviderSlug(p, slugs);
			slugs.push(slug);
			return p.models.map((m) => ({ value: `${slug}/${m.id}`, label: `${p.name} / ${m.id}` }));
		});
	})();

	const selected = bots.find((b) => b.id === selectedId);
	// 编辑已有机型：表单初始值 = 渠道当前值（secret 已脱敏，留空表示不修改）
	const openEdit = (id: string) => {
		const b = bots.find((x) => x.id === id)!;
		setSelectedId(id);
		setDraft({
			type: b.type, name: b.name, enabled: b.enabled,
			credentials: { botId: b.credentials.botId, secret: "" },
			agentName: b.agentName, model: b.model,
			extraSystemPrompt: b.extraSystemPrompt, replyGranularity: b.replyGranularity,
		});
	};

	const handleSave = async () => {
		if (!draft) return;
		try {
			if (selectedId) {
				// secret 留空 = 不修改（kernel 侧 merge）
				const patch: any = { ...draft };
				if (!patch.credentials.secret) {
					patch.credentials = { botId: draft.credentials.botId };
				}
				await updateBot(selectedId, patch);
			} else {
				await createBot(draft);
			}
			setDraft(null);
			setSelectedId(null);
		} catch (e) {
			// 保存失败：用 toast 提示，不再在按钮旁显示 inline 文本
			useToastStore.getState().add(e instanceof Error ? e.message : String(e), "error");
		}
	};

	const agentMissing = draft?.agentName
		? !agents.some((a) => a.displayName === draft.agentName)
		: false;

	return (
		<div className="flex flex-1 min-h-0">
			{/* 左：机器人列表 */}
			<div className="w-56 border-r border-hairline p-3 flex flex-col gap-2" style={{ background: "var(--surface-elevated)" }}>
				<button
					onClick={() => setShowNew(true)}
					className="px-3 py-1.5 rounded-sm text-sm border-0 cursor-pointer"
					style={{ background: "var(--brand)", color: "var(--on-brand)" }}
					data-testid="bots-new-btn"
				>＋ 新建机器人</button>
				{bots.map((b) => (
					<div
						key={b.id}
						role="button"
						tabIndex={0}
						onClick={() => openEdit(b.id)}
						onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") openEdit(b.id); }}
						className="text-left px-2.5 py-2 rounded-md border cursor-pointer"
						style={{
							borderColor: selectedId === b.id ? "var(--hairline-strong)" : "var(--hairline)",
							background: "var(--surface)",
						}}
						data-testid={`bot-card-${b.id}`}
					>
						<div className="flex items-center gap-1.5 text-sm font-medium text-primary">
							<img src={`/channels/${b.type}.ico`} alt="" className="w-4 h-4 rounded" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
							<span className="flex-1 truncate">{b.name}</span>
							{/* 内联启用开关：即时生效（PUT 后 kernel 启停对应 WS 连接），不进入编辑表单 */}
							<button
								onClick={(e) => {
									e.stopPropagation();
									void updateBot(b.id, { enabled: !b.enabled }).catch((err) =>
										useToastStore.getState().add(err instanceof Error ? err.message : String(err), "error"),
									);
								}}
								title={b.enabled ? "点击停用" : "点击启用"}
								className="border-0 bg-transparent p-0 cursor-pointer shrink-0"
								data-testid={`bot-toggle-${b.id}`}
							>
								<span
									className="relative inline-block w-7 h-4 rounded-full align-middle"
									style={{ background: b.enabled ? "var(--success)" : "var(--hairline-strong)" }}
								>
									<span
										className="absolute top-0.5 w-3 h-3 rounded-full"
										style={{ left: b.enabled ? 14 : 2, background: "var(--surface)" }}
									/>
								</span>
							</button>
						</div>
						<div className="flex items-center gap-1 mt-1 text-xs text-tertiary">
							<span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: STATUS_DOT[b.status] }} />
							{STATUS_TEXT[b.status]}{b.statusDetail ? ` · ${b.statusDetail}` : ""}
						</div>
					</div>
				))}
			</div>

			{/* 右：表单 */}
			<div className="flex-1 flex flex-col gap-3 p-4 overflow-auto">
				{!draft && <div className="text-sm text-tertiary p-4">选择左侧机器人进行配置，或新建一个。</div>}
				{draft && (
					<>
						<label className="flex flex-col gap-1 w-72">
							<span className="text-xs text-secondary">名称</span>
							<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
								className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
								data-testid="bot-name-input" />
						</label>
						<div className="flex gap-3">
							<label className="flex flex-col gap-1 w-56">
								<span className="text-xs text-secondary">Bot ID</span>
								<input value={draft.credentials.botId}
									onChange={(e) => setDraft({ ...draft, credentials: { ...draft.credentials, botId: e.target.value } })}
									className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
									data-testid="bot-botid-input" />
							</label>
							<label className="flex flex-col gap-1 w-56">
								<span className="text-xs text-secondary">Secret{selectedId ? "（留空不修改）" : ""}</span>
								<input type="password" value={draft.credentials.secret}
									onChange={(e) => setDraft({ ...draft, credentials: { ...draft.credentials, secret: e.target.value } })}
									className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
									data-testid="bot-secret-input" />
							</label>
						</div>
						<div className="flex flex-col gap-1 w-72">
							<span className="text-xs text-secondary">关联智能体</span>
							<div>
								<AgentDropdown
									agents={agents}
									value={draft.agentName || null}
									onPick={(name) => setDraft({ ...draft, agentName: name })}
									missing={agentMissing}
									placeholder="系统默认（列表第一项）"
									defaultLabel="系统默认（列表第一项）"
									pillTestId="bot-agent-select"
									itemTestIdPrefix="bot-agent"
								/>
							</div>
							{agentMissing && (
								<span className="text-xs px-2 py-1 rounded-sm" style={{ background: "var(--warning-soft)", color: "var(--warning)" }}
									data-testid="bot-agent-missing-warning">
									⚠️ 原智能体已删除，当前降级使用系统默认智能体
								</span>
							)}
						</div>
						<label className="flex flex-col gap-1 w-72">
							<span className="text-xs text-secondary">模型</span>
							<select value={draft.model ?? ""}
								onChange={(e) => setDraft({ ...draft, model: e.target.value || null })}
								className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
								data-testid="bot-model-select">
								<option value="">跟随智能体</option>
								{modelOptions.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
							</select>
						</label>
						<label className="flex flex-col gap-1 w-full max-w-lg">
							<span className="text-xs text-secondary">额外系统提示词</span>
							<SkillSuggestTextarea
								value={draft.extraSystemPrompt}
								onChange={(v) => setDraft({ ...draft, extraSystemPrompt: v })}
								rows={3}
								data-testid="bot-prompt-textarea"
							/>
							<span className="text-xs text-tertiary">追加拼接到系统提示词中，位于记忆内容之前。输入 $ 可引用技能。</span>
						</label>
						<label className="flex flex-col gap-1 w-72">
							<span className="text-xs text-secondary">回复粒度</span>
							<select value={draft.replyGranularity}
								onChange={(e) => setDraft({ ...draft, replyGranularity: e.target.value as any })}
								className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
								data-testid="bot-granularity-select">
								<option value="standard">标准回复 · 正文 + 文件变更</option>
								<option value="simple">简洁回复 · 仅正文</option>
							</select>
						</label>
						<label className="flex items-center gap-2 text-sm text-secondary">
							<input type="checkbox" checked={draft.enabled}
								onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
								data-testid="bot-enabled-toggle" />
							启用（保存后生效）
						</label>
						<div className="flex items-center gap-3 border-t border-hairline pt-3">
							{selectedId && (
								<button onClick={() => setConfirmDelete(true)}
									className="px-3 py-1.5 rounded-sm text-sm border border-hairline cursor-pointer"
									style={{ color: "var(--danger)" }}
									data-testid="bot-delete-btn">删除机器人</button>
							)}
							<span className="flex-1" />
							<button onClick={() => void handleSave()}
								className="px-3 py-1.5 rounded-sm text-sm border-0 cursor-pointer"
								style={{ background: "var(--brand)", color: "var(--on-brand)" }}
								data-testid="bot-save-btn">保存</button>
						</div>
					</>
				)}
			</div>

			{showNew && (
				<NewBotDialog
					onClose={() => setShowNew(false)}
					onSelect={(type) => { setShowNew(false); setSelectedId(null); setDraft(emptyDraft(type)); }}
				/>
			)}
			{confirmDelete && selectedId && (
				<ConfirmDialog
					title="删除机器人"
					message={`确定删除「${selected?.name}」吗？历史会话保留，但机器人将断开连接。`}
					confirmText="删除"
					danger
					onCancel={() => setConfirmDelete(false)}
					onConfirm={() => {
						void deleteBot(selectedId).then(() => {
							setConfirmDelete(false); setSelectedId(null); setDraft(null);
						});
					}}
				/>
			)}
		</div>
	);
}
