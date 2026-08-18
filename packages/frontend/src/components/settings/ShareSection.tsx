import { useEffect, useState } from "react";
import { useTranslation } from "../../i18n/useTranslation";
import { api } from "../../api-client";
import { useToastStore } from "../../store/toast";
import {
	shareList,
	shareDelete,
	shareClear,
	shareDeploy,
	shareRefreshLink,
	type ShareItemInfo,
} from "../../share-client";
import { copyToClipboard } from "../../util/clipboard";
import { useUiPrefsStore } from "../../store/ui-prefs";

/**
 * 分享面板：「分享设置」与「我的分享」两个 tab。
 * 分享设置：渠道（腾讯 EdgeOne，只读 + 注册入口）、API Token、自定义域名；
 * 保存 PUT /api/settings/share（token 空串时 kernel 保留原值），token 已保存时脱敏展示。
 * 我的分享：列表 / 复制链接 / 删除 / 清空 / 立即部署 / 存储用量 / 打开分享文件夹。
 */
export function ShareSection() {
	const { t } = useTranslation();
	const [tab, setTab] = useState<"settings" | "shares">("settings");
	const [token, setToken] = useState("");
	const [saved, setSaved] = useState(false);
	const [saving, setSaving] = useState(false);
	const [customDomain, setCustomDomain] = useState("");
	const [items, setItems] = useState<ShareItemInfo[]>([]);
	const [pending, setPending] = useState(0);
	const [usage, setUsage] = useState({ totalSize: 0, totalLimit: 0 });
	const [workspaceDir, setWorkspaceDir] = useState("");
	const [deploying, setDeploying] = useState(false);
	const [copiedId, setCopiedId] = useState<string | null>(null);

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
					res as { share?: { hasToken?: boolean; customDomain?: string } }
				)?.share;
				if (share?.hasToken) setSaved(true);
				setCustomDomain(share?.customDomain ?? "");
			})
			.catch(() => {});
	}, []);

	// 已保存且有值 → 脱敏展示（掩码 + 「修改」）；否则显示输入框
	const masked = saved && token === "";

	const save = async () => {
		setSaving(true);
		try {
			await api.put("/api/settings/share", {
				share: { token, channel: "edgeone", customDomain },
			});
			setToken("");
			setSaved(true);
			useToastStore.getState().add(t("settings.share.saved"), "success");
		} catch (e) {
			useToastStore
				.getState()
				.add(e instanceof Error ? e.message : String(e), "error");
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
			setTimeout(() => setCopiedId(null), 1500);
		} catch (e) {
			useToastStore
				.getState()
				.add(e instanceof Error ? e.message : String(e), "error");
		}
	};

	const onDelete = async (id: string) => {
		try {
			await shareDelete(id);
			await refresh();
		} catch (e) {
			useToastStore
				.getState()
				.add(e instanceof Error ? e.message : String(e), "error");
		}
	};

	const onClear = async () => {
		try {
			await shareClear();
			await refresh();
		} catch (e) {
			useToastStore
				.getState()
				.add(e instanceof Error ? e.message : String(e), "error");
		}
	};

	const onDeploy = async () => {
		setDeploying(true);
		try {
			await shareDeploy();
			useToastStore
				.getState()
				.add(t("settings.share.deployed"), "success");
			await refresh();
		} catch (e) {
			useToastStore
				.getState()
				.add(e instanceof Error ? e.message : String(e), "error");
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
						<div className="flex items-center gap-2">
							<span className="text-xs text-secondary">腾讯 EdgeOne</span>
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
					</div>
					{masked ? (
						<div
							className="flex items-center gap-3 w-72"
							data-testid="share-token-mask"
						>
							<span className="text-sm text-secondary tracking-widest">
								••••••••
							</span>
							<button
								onClick={() => setSaved(false)}
								className="px-2 py-1 rounded-sm border border-hairline bg-surface text-xs text-secondary cursor-pointer hover:text-primary transition-colors"
								data-testid="share-token-modify"
							>
								{t("settings.share.modify")}
							</button>
						</div>
					) : (
						<label className="flex flex-col gap-1 w-72">
							<span className="text-xs text-secondary">
								{t("settings.share.token")}
							</span>
							<input
								type="password"
								value={token}
								onChange={(e) => {
									setToken(e.target.value);
									setSaved(false);
								}}
								autoComplete="off"
								spellCheck={false}
								className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
								data-testid="share-token-input"
							/>
						</label>
					)}
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
							{t("settings.share.usage", {
								used: formatSize(usage.totalSize),
								limit: formatSize(usage.totalLimit),
							})}
						</span>
						<button
							onClick={() =>
								workspaceDir &&
								void window.waPiApp?.showItemInFolder?.(workspaceDir)
							}
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
									<span className="text-primary">{it.name}</span>
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
							{deploying
								? t("settings.share.deploying")
								: t("settings.share.deploy")}
						</button>
						{pending > 0 && (
							<span
								className="text-xs"
								style={{ color: "var(--warning, #d97706)" }}
								data-testid="share-pending"
							>
								{t("settings.share.pending", { count: pending })}
							</span>
						)}
						{items.length > 0 && (
							<button
								onClick={() => void onClear()}
								className="px-2 py-1 rounded-sm border border-hairline bg-surface text-xs text-secondary cursor-pointer hover:text-primary transition-colors"
								data-testid="share-clear"
							>
								{t("settings.share.clearAll")}
							</button>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
