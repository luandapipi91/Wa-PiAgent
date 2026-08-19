// ShareButton — 产物分享按钮（文件旁分享入口）。
// 点击打开 ShareResultModal：挂载时检查分享 token 是否已配置（shareSettings），
// 未配置 → 引导去 设置 → 分享 配置 Token；已配置 → 显示待分享文件列表 +
// 「生成分享链接」（shareUpload），成功后展示分享 URL + 复制按钮 + 有效期提示。
import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { Icon } from "./Icon";
import { ProgressBar } from "./ProgressBar";
import { useTranslation } from "../../i18n/useTranslation";
import { shareSettings, shareUpload } from "../../share-client";
import { copyToClipboard } from "../../util/clipboard";
import { useShareProgressStore } from "../../store/share-progress";
import { useProjectsStore } from "../../store/projects";
import { useToastStore } from "../../store/toast";
import { SYSTEM_PROJECT_ID } from "@wa-pi/shared";

interface ShareButtonProps {
	paths: string[];
	sessionId?: string;
	/** 项目名称：分享名称输入框默认值（缺省回退文件/目录名自动名） */
	projectName?: string;
	className?: string;
	testId?: string;
}

/** 默认分享名（与 kernel 自动名规则一致）：单文件=文件名、单目录=目录名、多=N 个文件 */
export function defaultShareName(paths: string[]): string {
	if (paths.length === 0) return "";
	if (paths.length === 1) {
		const p = paths[0];
		// 以 / 或 \ 结尾视为目录，取去尾分隔符后的 basename
		const clean = p.replace(/[\\/]+$/, "");
		return clean.split(/[\\/]/).pop() ?? clean;
	}
	return `${paths.length} 个文件`;
}

export function ShareButton({
	paths,
	sessionId,
	projectName,
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
					projectName={projectName}
					onClose={() => setOpen(false)}
				/>
			)}
		</>
	);
}

interface ShareResultModalProps {
	paths: string[];
	sessionId?: string;
	/** 项目名称：分享名称输入框默认值（缺省回退文件/目录名自动名） */
	projectName?: string;
	onClose: () => void;
}

/** 分享结果弹层：检查 token → 生成分享链接 → 展示 URL / 复制 / 有效期 */
/** 按会话反查项目名：sessionId → session.projectId → project.name；默认工作区显示其名称，查不到返回空串 */
function projectNameOfSession(
	sessionId: string | undefined,
	projects: { id: string; name: string }[],
	sessions: { id: string; projectId: string }[],
): string {
	if (!sessionId) return "";
	const pid = sessions.find((s) => s.id === sessionId)?.projectId;
	if (!pid) return "";
	const p = projects.find((x) => x.id === pid);
	return p?.name ?? (pid === SYSTEM_PROJECT_ID ? "默认工作区" : "");
}

export function ShareResultModal({
	paths,
	sessionId,
	projectName,
	onClose,
}: ShareResultModalProps) {
	const { t } = useTranslation();
	const { projects, sessions } = useProjectsStore();
	// 挂载时检查 token：checking 完成前显示加载；token 为空 → 引导配置
	const [checking, setChecking] = useState(true);
	const [noToken, setNoToken] = useState(false);
	// 分享名（文件夹名/URL 子路径）：默认项目名（用户要求，优先显式传入，否则按会话反查），
	// 缺省回退文件/目录自动名；可修改；重复时 kernel 409
	const [shareName, setShareName] = useState(
		() =>
			projectName?.trim() ||
			projectNameOfSession(sessionId, projects, sessions) ||
			defaultShareName(paths),
	);
	// 生成流程状态
	const [generating, setGenerating] = useState(false);
	const [result, setResult] = useState<{
		url: string;
		expiresAt: number;
	} | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	// kernel SSE 广播的上传/部署进度
	const progress = useShareProgressStore();

	// 阶段文案：packing/deploying 无真实百分比；uploading 有 COS 回调的百分比
	const phaseText =
		progress.phase === "packing"
			? t("share.packing")
			: progress.phase === "uploading"
				? t("share.uploading", { percent: progress.percent })
				: progress.phase === "deploying"
					? t("share.deploying")
					: t("share.generating");

	useEffect(() => {
		let cancelled = false;
		shareSettings()
			.then((s) => {
				if (cancelled) return;
				if (!s.hasToken) setNoToken(true);
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
			const res = await shareUpload(
				paths,
				sessionId,
				shareName.trim() || undefined,
			);
			setResult(res);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			setError(msg);
			// 名称重复等业务错误：toast 提示（用户要求「已有分享名称重复，请使用其他名字」）
			if (/重复|非法字符/.test(msg)) useToastStore.getState().add(msg, "error");
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
			useToastStore.getState().add(t("share.copied"), "success");
		} catch {
			// 复制失败：copied 保持 false，错误展示在结果分支内（复制按钮下方）
			setError(t("common.copyFailed"));
		}
	};

	// 有效期（小时）：edgeone 固定 3 小时，由 expiresAt 计算，至少 1。
	// expiresAt === 0 表示永久（后端约定 CF 渠道返回 0）：渲染「永久有效」而非小时倒计时，
	// 不做 Math.max(1, …) 兜底（否则永久链接会被误显示成「1 小时」）。
	const isPermanent = result?.expiresAt === 0;
	const hoursLeft =
		result && !isPermanent
			? Math.max(1, Math.round((result.expiresAt - Date.now()) / 3_600_000))
			: 0;

	return (
		<Modal
			onClose={onClose}
			width={480}
			data-testid="share-result-modal"
			// 点击阴影不关闭：分享弹窗里可能正在输入分享名/生成链接，防止误触丢输入；
			// 关闭走 X 按钮或 ESC（Modal 默认 closeOnEsc=true）
			closeOnOverlayClick={false}
		>
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
								{isPermanent
									// 「永久有效」文案：i18n 暂无该 key，用 defaultValue 兜底（CF 渠道分享固定永久）
									? t("share.permanent", { defaultValue: "永久有效" })
									: t("share.expiresIn", { hours: hoursLeft })}
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
						<div className="flex flex-col gap-1" data-testid="share-name-field">
							<span className="text-xs text-secondary">{t("share.name")}</span>
							<input
								type="text"
								value={shareName}
								onChange={(e) => setShareName(e.target.value)}
								placeholder={t("share.namePlaceholder")}
								spellCheck={false}
								className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
								data-testid="share-name-input"
							/>
						</div>
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
						{generating ? (
							<div
								className="flex flex-col gap-1.5 w-full"
								data-testid="share-progress"
							>
								<ProgressBar
									percent={progress.percent}
									indeterminate={progress.phase !== "uploading"}
								/>
								<span
									className="text-xs text-secondary"
									data-testid="share-progress-text"
								>
									{phaseText}
								</span>
							</div>
						) : (
							<button
								type="button"
								onClick={() => void generate()}
								disabled={generating}
								className="self-start px-3 py-1.5 rounded-sm text-sm border-0 cursor-pointer disabled:opacity-60"
								style={{ background: "var(--brand)", color: "var(--on-brand)" }}
								data-testid="share-generate-btn"
							>
								{t("share.generate")}
							</button>
						)}
					</>
				)}
			</div>
		</Modal>
	);
}
