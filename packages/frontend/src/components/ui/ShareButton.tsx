// ShareButton — 产物分享按钮（文件旁分享入口）。
// 点击打开 ShareResultModal：挂载时检查分享 token 是否已配置（shareSettings），
// 未配置 → 引导去 设置 → 分享 配置 Token；已配置 → 显示待分享文件列表 +
// 「生成分享链接」（shareUpload），成功后展示分享 URL + 复制按钮 + 有效期提示。
import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { Icon } from "./Icon";
import { useTranslation } from "../../i18n/useTranslation";
import { shareSettings, shareUpload } from "../../share-client";
import { copyToClipboard } from "../../util/clipboard";

interface ShareButtonProps {
	paths: string[];
	sessionId?: string;
	className?: string;
	testId?: string;
}

export function ShareButton({
	paths,
	sessionId,
	className,
	testId,
}: ShareButtonProps) {
	const [open, setOpen] = useState(false);
	const { t } = useTranslation();
	return (
		<>
			<button
				type="button"
				data-testid={testId ?? "share-btn"}
				className={className}
				title={t("share.share")}
				aria-label={t("share.share")}
				onClick={() => setOpen(true)}
			>
				<Icon name="share" size={14} />
			</button>
			{open && (
				<ShareResultModal
					paths={paths}
					sessionId={sessionId}
					onClose={() => setOpen(false)}
				/>
			)}
		</>
	);
}

interface ShareResultModalProps {
	paths: string[];
	sessionId?: string;
	onClose: () => void;
}

/** 分享结果弹层：检查 token → 生成分享链接 → 展示 URL / 复制 / 有效期 */
function ShareResultModal({
	paths,
	sessionId,
	onClose,
}: ShareResultModalProps) {
	const { t } = useTranslation();
	// 挂载时检查 token：checking 完成前显示加载；token 为空 → 引导配置
	const [checking, setChecking] = useState(true);
	const [noToken, setNoToken] = useState(false);
	// 生成流程状态
	const [generating, setGenerating] = useState(false);
	const [result, setResult] = useState<{
		url: string;
		expiresAt: number;
	} | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		let cancelled = false;
		shareSettings()
			.then((s) => {
				if (cancelled) return;
				if (!s.token) setNoToken(true);
			})
			.catch(() => {
				// 读不到配置按未配置处理，引导用户去设置
				if (!cancelled) setNoToken(true);
			})
			.finally(() => {
				if (!cancelled) setChecking(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const generate = async () => {
		if (generating) return;
		setGenerating(true);
		setError(null);
		setCopied(false);
		try {
			const res = await shareUpload(paths, sessionId);
			setResult(res);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setGenerating(false);
		}
	};

	const copy = async () => {
		if (!result) return;
		try {
			await copyToClipboard(result.url);
			setCopied(true);
			setError(null);
		} catch {
			// 复制失败：copied 保持 false，错误展示在结果分支内（复制按钮下方）
			setError(t("common.copyFailed"));
		}
	};

	// 有效期（小时）：kernel 固定 3 小时，由 expiresAt 计算，至少 1
	const hoursLeft = result
		? Math.max(1, Math.round((result.expiresAt - Date.now()) / 3_600_000))
		: 0;

	return (
		<Modal onClose={onClose} width={480} data-testid="share-result-modal">
			<div className="p-4 border-b border-hairline flex items-center justify-between">
				<div className="text-primary font-bold text-sm">{t("share.title")}</div>
				<button
					type="button"
					onClick={onClose}
					className="text-secondary hover:text-primary transition-colors cursor-pointer"
					data-testid="share-close"
					aria-label={t("common.close")}
				>
					<Icon name="x" size={14} />
				</button>
			</div>
			<div className="p-4 flex flex-col gap-4">
				{checking ? (
					<div className="text-sm text-secondary">{t("common.loading")}</div>
				) : noToken ? (
					<div
						className="text-sm text-secondary leading-relaxed"
						data-testid="share-no-token"
					>
						{t("share.noToken")}
					</div>
				) : result ? (
					<>
						<div className="flex flex-col gap-1">
							<span className="text-xs text-secondary">{t("share.link")}</span>
							<div
								className="px-2 py-1.5 rounded-sm border border-hairline bg-surface-hover text-sm text-primary break-all"
								data-testid="share-url"
							>
								{result.url}
							</div>
						</div>
						<div className="flex items-center gap-3">
							<button
								type="button"
								onClick={() => void copy()}
								className="px-3 py-1.5 rounded-sm text-sm border-0 cursor-pointer"
								style={{ background: "var(--brand)", color: "var(--on-brand)" }}
								data-testid="share-copy-btn"
							>
								{copied ? t("share.copied") : t("share.copyLink")}
							</button>
							<span className="text-xs text-secondary" data-testid="share-expires">
								{t("share.expiresIn", { hours: hoursLeft })}
							</span>
						</div>
						{error && (
							<div
								className="text-xs"
								style={{ color: "var(--danger)" }}
								data-testid="share-error"
							>
								{error}
							</div>
						)}
					</>
				) : (
					<>
						<div className="flex flex-col gap-1" data-testid="share-files">
							<span className="text-sm text-primary">
								{t("share.files", { count: paths.length })}
							</span>
							<ul className="flex flex-col gap-0.5">
								{paths.slice(0, 3).map((p, i) => (
									<li
										key={p}
										className="text-xs text-secondary truncate"
										data-testid={`share-file-${i}`}
									>
										{p.split(/[\\/]/).pop()}
									</li>
								))}
							</ul>
							{paths.length > 3 && (
								<span
									className="text-xs"
									style={{ color: "var(--text-tertiary)" }}
									data-testid="share-more"
								>
									+{paths.length - 3}
								</span>
							)}
						</div>
						{error && (
							<div
								className="text-xs"
								style={{ color: "var(--danger)" }}
								data-testid="share-error"
							>
								{error}
							</div>
						)}
						<button
							type="button"
							onClick={() => void generate()}
							disabled={generating}
							className="self-start px-3 py-1.5 rounded-sm text-sm border-0 cursor-pointer disabled:opacity-60"
							style={{ background: "var(--brand)", color: "var(--on-brand)" }}
							data-testid="share-generate-btn"
						>
							{generating ? t("share.generating") : t("share.generate")}
						</button>
					</>
				)}
			</div>
		</Modal>
	);
}
