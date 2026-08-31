import { useEffect, useState, type ReactNode } from "react";
import { formatApiError } from "../../util/kernel-error";
import { useTranslation } from "../../i18n/useTranslation";
import { api } from "../../api-client";
import { useToastStore } from "../../store/toast";
import { Icon } from "../ui/Icon";
import {
	shareList,
	shareDelete,
	shareClear,
	shareDeploy,
	shareRefreshLink,
	shareRename,
	shareOpenFolder,
	type ShareItemInfo,
} from "../../share-client";
import { copyToClipboard } from "../../util/clipboard";
import { useUiPrefsStore } from "../../store/ui-prefs";
import { ProgressBar } from "../ui/ProgressBar";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Modal } from "../ui/Modal";
import { useShareProgressStore } from "../../store/share-progress";

/**
 * 分享面板：「分享设置」与「我的分享」两个 tab。
 * 分享设置：渠道切换（edgeone / cloudflare）；edgeone 展示注册入口 + API Token + 自定义域名，
 * cloudflare 展示 API Token + Account ID + 注册链接 + 提示文案；
 * 保存 PUT /api/settings/share 全量提交 { channel, token, accountId, customDomain }
 * （token 空串时 kernel 保留原值），token 已保存时脱敏展示。
 * 我的分享：列表 / 复制链接 / 删除 / 清空 / 立即部署 / 存储用量 / 打开分享文件夹。
 */
/** 帮助弹窗里的图文步骤：数字圆圈 + 内容 */
function HelpStep({ n, children }: { n: string; children: ReactNode }) {
	return (
		<div className="flex items-start gap-2 text-sm">
			<span
				className="inline-flex items-center justify-center w-5 h-5 rounded-full text-xs font-medium shrink-0 mt-0.5"
				style={{ background: "var(--brand)", color: "var(--on-brand)" }}
			>
				{n}
			</span>
			<span className="text-secondary leading-relaxed">{children}</span>
		</div>
	);
}

/** 帮助弹窗示意图：SVG 简绘浏览器窗口 + 界面关键路径（高亮要点的按钮/菜单） */
function HelpDiagram({ variant }: { variant: "edgeone" | "cloudflare" }) {
	return (
		<svg
			viewBox="0 0 360 150"
			className="w-full h-auto rounded-lg border border-hairline"
			role="img"
			aria-label={
				variant === "edgeone"
					? "Makers 控制台获取 API Token 示意图"
					: "Cloudflare API Tokens 页面示意图"
			}
		>
			{/* 浏览器窗口外框 + 顶部栏 */}
			<rect
				x="2"
				y="2"
				width="356"
				height="146"
				rx="8"
				fill="var(--surface)"
				stroke="var(--hairline)"
			/>
			<rect
				x="2"
				y="2"
				width="356"
				height="24"
				rx="8"
				fill="var(--hairline)"
				opacity="0.55"
			/>
			<circle cx="16" cy="14" r="3" fill="#ff5f57" />
			<circle cx="28" cy="14" r="3" fill="#febc2e" />
			<circle cx="40" cy="14" r="3" fill="#28c840" />
			<rect
				x="54"
				y="8"
				width="150"
				height="12"
				rx="6"
				fill="var(--surface)"
				stroke="var(--hairline)"
			/>

			{variant === "edgeone" ? (
				<g>
					{/* Makers 控制台左侧菜单，高亮「设置」 */}
					<rect
						x="10"
						y="32"
						width="86"
						height="106"
						rx="4"
						fill="var(--surface)"
						stroke="var(--hairline)"
						opacity="0.8"
					/>
					<text x="18" y="48" fontSize="9" fill="#8a8f98">
						项目
					</text>
					<text x="18" y="64" fontSize="9" fill="#8a8f98">
						Agents
					</text>
					<text x="18" y="80" fontSize="9" fill="#8a8f98">
						Models
					</text>
					<text x="18" y="96" fontSize="9" fill="#8a8f98">
						存储
					</text>
					<rect
						x="14"
						y="102"
						width="78"
						height="16"
						rx="3"
						fill="var(--brand)"
						opacity="0.15"
					/>
					<text x="18" y="114" fontSize="9" fontWeight="bold" fill="var(--brand)">
						设置
					</text>
					{/* 右侧：API Token Tab + 创建按钮 + token 列表 */}
					<rect
						x="104"
						y="32"
						width="80"
						height="16"
						rx="3"
						fill="var(--brand)"
						opacity="0.15"
					/>
					<text x="110" y="44" fontSize="9" fontWeight="bold" fill="var(--brand)">
						API Token
					</text>
					<rect
						x="230"
						y="32"
						width="110"
						height="16"
						rx="3"
						fill="var(--hairline)"
						opacity="0.5"
					/>
					<text x="236" y="44" fontSize="8.5" fill="#8a8f98">
						使用文档
					</text>
					<rect x="104" y="56" width="100" height="18" rx="3" fill="var(--brand)" />
					<text
						x="112"
						y="69"
						fontSize="8.5"
						fontWeight="bold"
						fill="var(--on-brand)"
					>
						创建 API Token
					</text>
					<rect
						x="104"
						y="84"
						width="242"
						height="16"
						rx="3"
						fill="var(--surface)"
						stroke="var(--hairline)"
					/>
					<rect
						x="104"
						y="104"
						width="242"
						height="16"
						rx="3"
						fill="var(--surface)"
						stroke="var(--hairline)"
					/>
					<text x="110" y="95" fontSize="8" fill="#8a8f98">
						我的测试上传
					</text>
				</g>
			) : (
				<g>
					{/* API Tokens 页面：标题 + Create Token 按钮高亮 + token 列表 */}
					<text x="16" y="44" fontSize="11" fontWeight="bold" fill="#333">
						API Tokens
					</text>
					<text x="16" y="60" fontSize="8.5" fill="#8a8f98">
						Manage API tokens for your account
					</text>
					<rect x="16" y="70" width="88" height="20" rx="4" fill="var(--brand)" />
					<text x="26" y="84" fontSize="9" fontWeight="bold" fill="var(--on-brand)">
						Create Token
					</text>
					<rect
						x="16"
						y="98"
						width="324"
						height="18"
						rx="3"
						fill="var(--surface)"
						stroke="var(--hairline)"
					/>
					<rect
						x="16"
						y="120"
						width="324"
						height="18"
						rx="3"
						fill="var(--surface)"
						stroke="var(--hairline)"
					/>
					<text x="22" y="111" fontSize="8" fill="#8a8f98">
						Edit Cloudflare Workers (edit)…
					</text>
					<text x="22" y="133" fontSize="8" fill="#8a8f98">
						Pages deploy token …
					</text>
				</g>
			)}
		</svg>
	);
}

export function ShareSection() {
	const { t } = useTranslation();
	const [tab, setTab] = useState<"settings" | "shares">("settings");
	const [token, setToken] = useState("");
	// 每个渠道的已保存标记：切渠道时按目标渠道恢复，不把已保存渠道的状态一刀切清空
	const [savedByChannel, setSavedByChannel] = useState<{
		edgeone: boolean;
		cloudflare: boolean;
	}>({ edgeone: false, cloudflare: false });
	const [saving, setSaving] = useState(false);
	const [customDomain, setCustomDomain] = useState("");
	// 分享渠道：edgeone（腾讯 EdgeOne）/ cloudflare（Cloudflare Pages）
	const [channel, setChannel] = useState<"edgeone" | "cloudflare">("edgeone");
	const [accountId, setAccountId] = useState("");
	// 帮助弹窗：token 获取指引（小白用户找不到入口；Account ID 已改为接口自动获取，无需帮助）
	const [helpFor, setHelpFor] = useState<
		"edgeone-token" | "cloudflare-token" | null
	>(null);
	const [items, setItems] = useState<ShareItemInfo[]>([]);
	const [pending, setPending] = useState(0);
	const [usage, setUsage] = useState({ totalSize: 0, totalLimit: 0 });
	const [workspaceDir, setWorkspaceDir] = useState("");
	const [deploying, setDeploying] = useState(false);
	const [copiedId, setCopiedId] = useState<string | null>(null);
	// 重命名：editingId 非空时该条 name 变 input（预填 renameDraft）
	const [editingId, setEditingId] = useState<string | null>(null);
	const [renameDraft, setRenameDraft] = useState("");
	// 「清空分享」二次确认弹窗
	const [confirmClear, setConfirmClear] = useState(false);
	// kernel SSE 广播的上传/部署进度（部署阶段无真实百分比 → indeterminate）
	const progress = useShareProgressStore();

	// 注册入口按界面语言分流到中/英文产品页
	const language = useUiPrefsStore((s) => s.language);
	const registerUrl =
		language === "zh"
			? "https://edgeone.ai/zh/products/pages"
			: "https://edgeone.ai/products/pages";

	// mount：回填已保存的分享配置。hasToken 为 true 时进入脱敏展示态（token 不下发明文）。
	useEffect(() => {
		api
			.get("/api/settings/share")
			.then((res) => {
				const share = (
					res as {
						share?: {
							hasToken?: boolean;
							channel?: string;
							customDomain?: string;
							accountId?: string;
						};
					}
				)?.share;
				if (share?.hasToken)
					setSavedByChannel((prev) => ({
						...prev,
						[share.channel === "cloudflare" ? "cloudflare" : "edgeone"]: true,
					}));
				setChannel(share?.channel === "cloudflare" ? "cloudflare" : "edgeone");
				setCustomDomain(share?.customDomain ?? "");
				setAccountId(share?.accountId ?? "");
			})
			.catch(() => {});
	}, []);

	// 切换渠道：不同渠道的 API Token 不通用，切过去后必须重新填写（清空输入）；
	// 已保存状态按渠道记录——切到已保存的渠道恢复掩码，切到未保存渠道显示空输入框。
	const switchChannel = (next: "edgeone" | "cloudflare") => {
		setChannel(next);
		setToken("");
	};

	// 已保存且有值 → 脱敏展示（掩码 + 「修改」）；否则显示输入框
	const saved = savedByChannel[channel];
	const masked = saved && token === "";

	const save = async () => {
		setSaving(true);
		try {
			await api.put("/api/settings/share", {
				share: { token, channel, accountId, customDomain },
			});
			setToken("");
			setSavedByChannel((prev) => ({ ...prev, [channel]: true }));
			useToastStore.getState().add(t("settings.share.saved"), "success");
		} catch (e) {
			useToastStore.getState().add(formatApiError(e), "error");
		} finally {
			setSaving(false);
		}
	};

	// 读取分享列表；失败静默（未配置 token 也可查看本地列表）
	const refresh = async () => {
		try {
			const r = await shareList();
			setItems(r.items);
			setPending(r.pending);
			setUsage({ totalSize: r.totalSize, totalLimit: r.totalLimit });
			setWorkspaceDir(r.workspaceDir ?? "");
		} catch {
			/* 列表失败静默 */
		}
	};
	useEffect(() => {
		void refresh();
	}, []);

	const formatSize = (n: number) =>
		n >= 1 << 30
			? `${(n / (1 << 30)).toFixed(1)} GB`
			: n >= 1 << 20
				? `${(n / (1 << 20)).toFixed(1)} MB`
				: `${Math.ceil(n / 1024)} KB`;

	// 复制链接：先 refresh-link 换新的 3h 时效链接再复制
	const onCopy = async (id: string) => {
		try {
			const { url } = await shareRefreshLink(id);
			await copyToClipboard(url);
			setCopiedId(id);
			useToastStore.getState().add(t("settings.share.copied"), "success");
			setTimeout(() => setCopiedId(null), 1500);
		} catch (e) {
			useToastStore.getState().add(formatApiError(e), "error");
		}
	};

	const onRename = async (id: string) => {
		const name = renameDraft.trim();
		if (!name) return;
		try {
			await shareRename(id, name);
			setEditingId(null);
			useToastStore.getState().add(t("settings.share.renamedDeploy"), "success");
			await refresh();
		} catch (e) {
			useToastStore.getState().add(formatApiError(e), "error");
		}
	};

	const onDelete = async (id: string) => {
		try {
			await shareDelete(id);
			await refresh();
		} catch (e) {
			useToastStore.getState().add(formatApiError(e), "error");
		}
	};

	const onClear = async () => {
		setConfirmClear(false);
		try {
			await shareClear();
			await refresh();
		} catch (e) {
			useToastStore.getState().add(formatApiError(e), "error");
		}
	};

	// 打开分享文件夹：桌面端走 Electron 原生能力；浏览器（dev）走 kernel 系统打开器兜底
	const onOpenFolder = async () => {
		if (!workspaceDir) return;
		if (window.waPiApp?.showItemInFolder) {
			void window.waPiApp.showItemInFolder(workspaceDir);
			return;
		}
		try {
			await shareOpenFolder();
		} catch (e) {
			useToastStore.getState().add(formatApiError(e), "error");
		}
	};

	const onDeploy = async () => {
		setDeploying(true);
		try {
			await shareDeploy();
			useToastStore.getState().add(t("settings.share.deployed"), "success");
			await refresh();
		} catch (e) {
			useToastStore.getState().add(formatApiError(e), "error");
		} finally {
			setDeploying(false);
		}
	};

	const tabBtn = (key: "settings" | "shares", label: string, testid: string) => (
		<button
			onClick={() => setTab(key)}
			className="px-3 py-1.5 text-sm cursor-pointer border-0 bg-transparent"
			style={{
				color: tab === key ? "var(--brand)" : "var(--text-secondary)",
				borderBottom:
					tab === key ? "2px solid var(--brand)" : "2px solid transparent",
			}}
			data-testid={testid}
		>
			{label}
		</button>
	);

	// Token 字段：按渠道显示不同 label/placeholder；已保存 token 时统一脱敏展示
	const tokenField = masked ? (
		<div className="flex items-center gap-3 w-72" data-testid="share-token-mask">
			<span className="text-sm text-secondary tracking-widest">••••••••</span>
			<button
				onClick={() => setSavedByChannel((prev) => ({ ...prev, [channel]: false }))}
				className="px-2 py-1 rounded-sm border border-hairline bg-surface text-xs text-secondary cursor-pointer hover:text-primary transition-colors"
				data-testid="share-token-modify"
			>
				{t("settings.share.modify")}
			</button>
		</div>
	) : (
		<label className="flex flex-col gap-1 w-72">
			<span className="flex items-center gap-1.5">
				<span className="text-xs text-secondary">
					{channel === "cloudflare"
						? "Cloudflare API Token"
						: t("settings.share.token")}
				</span>
				<button
					type="button"
					onClick={() =>
						setHelpFor(
							channel === "cloudflare" ? "cloudflare-token" : "edgeone-token",
						)
					}
					className="w-4 h-4 rounded-full border border-hairline text-[10px] leading-none text-secondary hover:text-primary cursor-pointer inline-flex items-center justify-center shrink-0"
					data-testid="share-token-help"
					aria-label="获取 API Token 帮助"
				>
					?
				</button>
			</span>
			<input
				type="password"
				value={token}
				onChange={(e) => {
					setToken(e.target.value);
					setSavedByChannel((prev) => ({ ...prev, [channel]: false }));
				}}
				placeholder={
					channel === "cloudflare"
						? "在 Cloudflare 控制台创建，权限 Account → Cloudflare Pages → Edit"
						: undefined
				}
				autoComplete="off"
				spellCheck={false}
				className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
				data-testid="share-token-input"
			/>
		</label>
	);

	return (
		<div
			className="flex flex-col gap-4 p-4 overflow-auto"
			data-testid="share-section"
		>
			<div
				className="flex items-center gap-1 border-b border-hairline"
				data-testid="share-tabs"
			>
				{tabBtn("settings", t("settings.share.tabSettings"), "share-tab-settings")}
				{tabBtn("shares", t("settings.share.tabShares"), "share-tab-shares")}
			</div>

			{tab === "settings" && (
				<>
					<div className="flex flex-col gap-1">
						<span className="text-sm font-medium text-primary">
							{t("settings.share.channel")}
						</span>
						<div className="flex items-center gap-4">
							<label className="flex items-center gap-1.5 cursor-pointer">
								<input
									type="radio"
									name="share-channel"
									checked={channel === "edgeone"}
									onChange={() => switchChannel("edgeone")}
									data-testid="share-channel-edgeone"
								/>
								<span className="text-xs text-secondary">腾讯 EdgeOne</span>
							</label>
							<label className="flex items-center gap-1.5 cursor-pointer">
								<input
									type="radio"
									name="share-channel"
									checked={channel === "cloudflare"}
									onChange={() => switchChannel("cloudflare")}
									data-testid="share-channel-cloudflare"
								/>
								<span className="text-xs text-secondary">Cloudflare</span>
							</label>
						</div>
					</div>

					{channel === "edgeone" && (
						<>
							{tokenField}
							<label className="flex flex-col gap-1 w-72">
								<span className="text-xs text-secondary">
									{t("settings.share.customDomain")}
								</span>
								<input
									type="text"
									value={customDomain}
									onChange={(e) => setCustomDomain(e.target.value)}
									placeholder="share.example.com"
									spellCheck={false}
									className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
									data-testid="share-domain-input"
								/>
								<span className="text-xs text-secondary">
									{t("settings.share.customDomainHint")}
								</span>
							</label>
							<div className="flex items-center gap-2">
								<a
									href={registerUrl}
									target="_blank"
									rel="noreferrer"
									className="text-xs cursor-pointer hover:underline"
									style={{ color: "var(--brand)" }}
									data-testid="share-register-link"
								>
									{t("settings.share.register")} &gt;
								</a>
							</div>
						</>
					)}

					{channel === "cloudflare" && (
						<>
							{tokenField}
							{/* Account ID 无需填写：部署时用 token 调 GET /accounts 自动获取 */}
							<div className="flex items-center gap-2">
								<a
									href="https://dash.cloudflare.com/sign-up"
									target="_blank"
									rel="noreferrer"
									className="text-xs cursor-pointer hover:underline"
									style={{ color: "var(--brand)" }}
									data-testid="share-cf-register-link"
								>
									注册 Cloudflare &gt;
								</a>
							</div>
							<span className="text-xs text-secondary">
								Cloudflare 分享链接永久公开；单文件 ≤ 25MB
							</span>
						</>
					)}

					{/* 保存按钮始终渲染：域名随时可改；token 为空串时 kernel 保留原 token */}
					<button
						onClick={() => void save()}
						disabled={saving}
						className="self-start px-3 py-1.5 rounded-sm text-sm border-0 cursor-pointer"
						style={{ background: "var(--brand)", color: "var(--on-brand)" }}
						data-testid="share-token-save"
					>
						{saving ? t("common.saving") : t("common.save")}
					</button>
				</>
			)}

			{tab === "shares" && (
				<div className="flex flex-col gap-2" data-testid="share-manage">
					<div className="flex items-center gap-2">
						<span className="text-xs text-secondary" data-testid="share-usage">
							{usage.totalLimit > 0
								? t("settings.share.usage", {
										used: formatSize(usage.totalSize),
										limit: formatSize(usage.totalLimit),
									})
								: // 云端存储上限无接口可查 → 不显示上限，只显示已用量
									t("settings.share.usageOnly", {
										used: formatSize(usage.totalSize),
									})}
						</span>
						<button
							onClick={() => void onOpenFolder()}
							className="p-1 text-secondary hover:text-primary cursor-pointer border-0 bg-transparent"
							title={t("settings.share.openFolder")}
							aria-label={t("settings.share.openFolder")}
							data-testid="share-open-folder"
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
							</svg>
						</button>
					</div>
					{items.length === 0 ? (
						<span className="text-xs text-secondary">
							{t("settings.share.empty")}
						</span>
					) : (
						<ul className="flex flex-col gap-1">
							{items.map((it) => (
								<li
									key={it.id}
									className="flex items-center gap-2 text-xs"
									data-testid={`share-item-${it.id}`}
								>
									{editingId === it.id ? (
										<input
											type="text"
											value={renameDraft}
											onChange={(e) => setRenameDraft(e.target.value)}
											onKeyDown={(e) => {
												if (e.key === "Enter") void onRename(it.id);
												if (e.key === "Escape") setEditingId(null);
											}}
											onBlur={() => void onRename(it.id)}
											autoFocus
											spellCheck={false}
											className="px-1.5 py-0.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none w-40"
											data-testid={`share-rename-input-${it.id}`}
										/>
									) : (
										<span className="flex items-center gap-1">
											<span
												className="text-primary"
												data-testid={`share-item-name-${it.id}`}
											>
												{it.name}
											</span>
											<button
												type="button"
												onClick={() => {
													setEditingId(it.id);
													setRenameDraft(it.name);
												}}
												className="p-0.5 text-secondary hover:text-primary cursor-pointer border-0 bg-transparent"
												title={t("settings.share.rename")}
												aria-label={t("settings.share.rename")}
												data-testid={`share-rename-${it.id}`}
											>
												<Icon name="edit" size={12} />
											</button>
										</span>
									)}
									<span className="text-secondary">{formatSize(it.size)}</span>
									<span className="text-secondary">
										{new Date(it.createdAt).toLocaleString()}
									</span>
									<button
										onClick={() => void onCopy(it.id)}
										className="px-2 py-0.5 rounded-sm border border-hairline bg-surface cursor-pointer hover:text-primary transition-colors"
										data-testid={`share-copy-${it.id}`}
									>
										{copiedId === it.id
											? t("settings.share.copied")
											: t("settings.share.copyLink")}
									</button>
									<button
										onClick={() => void onDelete(it.id)}
										className="px-2 py-0.5 rounded-sm border border-hairline bg-surface cursor-pointer hover:text-primary transition-colors"
										data-testid={`share-delete-${it.id}`}
									>
										{t("settings.share.remove")}
									</button>
								</li>
							))}
						</ul>
					)}
					<div className="flex items-center gap-2">
						<button
							onClick={() => void onDeploy()}
							disabled={deploying}
							className="px-3 py-1.5 rounded-sm text-sm border-0 cursor-pointer"
							style={{ background: "var(--brand)", color: "var(--on-brand)" }}
							data-testid="share-deploy"
						>
							{deploying ? t("settings.share.deploying") : t("settings.share.deploy")}
						</button>
						{items.length > 0 && (
							<button
								onClick={() => setConfirmClear(true)}
								className="px-3 py-1.5 rounded-sm text-sm border-0 cursor-pointer"
								style={{ background: "var(--danger)", color: "#fff" }}
								data-testid="share-clear"
							>
								{t("settings.share.clearAll")}
							</button>
						)}
					</div>
					{pending > 0 && (
						<span
							className="text-xs"
							style={{ color: "var(--warning, #d97706)" }}
							data-testid="share-pending"
						>
							{t("settings.share.pending", { count: pending })}
						</span>
					)}
					{deploying && (
						<div
							className="flex flex-col gap-1.5 w-72"
							data-testid="share-deploy-progress"
						>
							<ProgressBar
								percent={progress.percent}
								indeterminate={progress.phase !== "uploading"}
							/>
							<span
								className="text-xs text-secondary"
								data-testid="share-deploy-progress-text"
							>
								{progress.phase === "uploading"
									? t("share.uploading", { percent: progress.percent })
									: progress.phase === "packing"
										? t("share.packing")
										: t("share.deploying")}
							</span>
						</div>
					)}
				</div>
			)}
			{confirmClear && (
				<ConfirmDialog
					title={t("settings.share.clearAll")}
					message={t("settings.share.clearConfirm")}
					confirmText={t("settings.share.clearAll")}
					danger
					onConfirm={() => void onClear()}
					onCancel={() => setConfirmClear(false)}
				/>
			)}
			{helpFor && (
				<Modal
					onClose={() => setHelpFor(null)}
					width={560}
					data-testid="share-help-modal"
				>
					<div className="flex flex-col gap-4 p-5">
						<div className="flex items-center justify-between">
							<h3 className="text-base font-semibold">
								{helpFor === "edgeone-token"
									? "获取 EdgeOne API Token"
									: "获取 Cloudflare API Token"}
							</h3>
							<button
								type="button"
								onClick={() => setHelpFor(null)}
								className="w-7 h-7 rounded-sm flex items-center justify-center text-secondary hover:text-primary hover:bg-surface cursor-pointer text-lg leading-none"
								data-testid="share-help-close"
								aria-label="关闭"
							>
								✕
							</button>
						</div>
						{helpFor === "edgeone-token" && (
							<>
								<HelpDiagram variant="edgeone" />
								<div className="flex flex-col gap-3">
									<HelpStep n="1">
										打开 Makers 控制台：{" "}
										<a
											href="https://console.tencentcloud.com/edgeone/pages"
											target="_blank"
											rel="noreferrer"
											className="text-brand underline"
										>
											console.tencentcloud.com/edgeone/pages
										</a>
									</HelpStep>
									<HelpStep n="2">左侧「设置」→ 切到「API Token」Tab</HelpStep>
									<HelpStep n="3">
										点「创建 API Token」→ 填描述 + 选过期时间 → 提交，复制 Token
										粘贴到「API Token」输入框
									</HelpStep>
								</div>
							</>
						)}
						{helpFor === "cloudflare-token" && (
							<>
								<HelpDiagram variant="cloudflare" />
								<div className="flex flex-col gap-3">
									<HelpStep n="1">
										打开 API Token 页面：{" "}
										<a
											href="https://dash.cloudflare.com/profile/api-tokens"
											target="_blank"
											rel="noreferrer"
											className="text-brand underline"
										>
											dash.cloudflare.com → My Profile → API Tokens
										</a>
									</HelpStep>
									<HelpStep n="2">
										点「Create Token」，模板选{" "}
										<code className="px-1 rounded-sm bg-surface text-xs">
											Edit Cloudflare Workers
										</code>
										（或自定义权限：Account → Cloudflare Pages → Edit）
									</HelpStep>
									<HelpStep n="3">
										生成后立即复制（只显示一次），粘贴到「Cloudflare API Token」输入框
									</HelpStep>
								</div>
							</>
						)}
					</div>
				</Modal>
			)}
		</div>
	);
}
