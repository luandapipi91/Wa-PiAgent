import { useState } from "react";
import { Icon } from "./ui/Icon";
import { useBrowserStore } from "../store/browser";
import { useSessionStore } from "../store/session";
import { HtmlPreview } from "./blocks/HtmlPreview";
import { ShareResultModal } from "./ui/ShareButton";
import { isHtmlPath } from "../preview-url";
import { copyToClipboard } from "../util/clipboard";
import { useToastStore } from "../store/toast";
import { useProjectsStore } from "../store/projects";
import { useTranslation } from "../i18n/useTranslation";

export function BrowserPanel() {
	const { path, sessionId, closeBrowser } = useBrowserStore();
	const [loadedPath, setLoadedPath] = useState<string | null>(path);
	const [input, setInput] = useState(path ?? "");
	const [refreshKey, setRefreshKey] = useState(0);
	const [shareOpen, setShareOpen] = useState(false);
	const { t } = useTranslation();
	const addToast = useToastStore((s) => s.add);

	const openPath = (raw: string) => {
		const p = raw.trim();
		// 绝对路径判定：POSIX（/ 开头）或 Windows 盘符（C:\ 或 C:/ 开头）均放行，其余 → 拒绝
		const isAbs = p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
		if (!isAbs) {
			addToast(t("browser.invalidPath"), "error");
			return;
		}
		// 项目内校验：已有项目时路径必须落在某项目 cwd 下，避免加载项目外任意文件
		const cwdList = useProjectsStore
			.getState()
			.projects.map((p) => p.cwd)
			.filter(Boolean);
		if (cwdList.length > 0) {
			// cwd 规范化：去尾斜杠（保留根 `/`），避免 `/a/` 等尾斜杠导致 startsWith 不命中
			const normCwd = (cwd: string) => cwd.replace(/[\\/]+$/, "") || "/";
			const inside = cwdList.some((cwd) => {
				const c = normCwd(cwd);
				// 根目录项目：任意绝对路径都在项目内（p 已通过上面的绝对路径判定）
				if (c === "/") return true;
				return p === c || p.startsWith(c + "/") || p.startsWith(c + "\\");
			});
			if (!inside) {
				addToast(t("browser.invalidPath"), "error");
				return;
			}
		}
		if (!isHtmlPath(p)) {
			addToast(t("browser.invalidPath"), "error");
			return;
		}
		setLoadedPath(p);
		setInput(p);
	};

	return (
		<div className="flex flex-col h-full bg-surface" data-testid="browser-panel">
			{/* 工具栏 */}
			<div className="flex items-center gap-1.5 px-3 py-2 border-b border-hairline">
				<div className="flex-1 flex items-center gap-2 px-2 py-1.5 rounded-md border border-hairline bg-surface-hover">
					<Icon name="globe" size={14} className="text-secondary" />
					<input
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && openPath(input)}
						placeholder={t("browser.placeholder")}
						spellCheck={false}
						className="flex-1 bg-transparent text-sm text-primary outline-none"
						data-testid="browser-input"
					/>
				</div>
				<button
					type="button"
					className="fv-btn fv-btn--icon"
					title={t("browser.copy")}
					data-testid="browser-copy"
					disabled={!loadedPath}
					onClick={() =>
						loadedPath &&
						void copyToClipboard(loadedPath).then(() =>
							addToast(t("browser.copied"), "success"),
						)
					}
				>
					<Icon
						name="clipboard"
						size="1em"
						className="text-[calc(16px*var(--font-scale))]"
					/>
				</button>
				<button
					type="button"
					className="fv-btn fv-btn--icon"
					title={t("browser.refresh")}
					data-testid="browser-refresh"
					disabled={!loadedPath}
					onClick={() => setRefreshKey((k) => k + 1)}
				>
					<Icon
						name="refresh"
						size="1em"
						className="text-[calc(16px*var(--font-scale))]"
					/>
				</button>
				<button
					type="button"
					className="fv-btn fv-btn--icon"
					title={t("browser.code")}
					data-testid="browser-code"
					disabled={!loadedPath}
					onClick={() =>
						loadedPath &&
						useSessionStore.getState().openFilePreview(loadedPath, sessionId ?? "")
					}
				>
					<Icon
						name="code"
						size="1em"
						className="text-[calc(16px*var(--font-scale))]"
					/>
				</button>
				<button
					type="button"
					className="fv-btn fv-btn--icon"
					title={t("browser.share")}
					data-testid="browser-share"
					disabled={!loadedPath}
					onClick={() => setShareOpen(true)}
				>
					<Icon
						name="share"
						size="1em"
						className="text-[calc(16px*var(--font-scale))]"
					/>
				</button>
				<button
					type="button"
					className="fv-btn fv-btn--icon"
					title={t("common.close")}
					data-testid="browser-close"
					onClick={closeBrowser}
					style={{ color: "var(--danger)" }}
				>
					<Icon
						name="x"
						size="1em"
						className="text-[calc(16px*var(--font-scale))]"
					/>
				</button>
			</div>

			{/* 内容区 */}
			<div className="flex-1 overflow-hidden">
				{loadedPath ? (
					<HtmlPreview path={loadedPath} refreshKey={refreshKey} />
				) : (
					<div
						className="h-full flex flex-col items-center justify-center gap-3 text-secondary"
						data-testid="browser-empty"
					>
						<Icon name="globe" size={32} className="text-tertiary" />
						<span className="text-sm">{t("browser.empty")}</span>
					</div>
				)}
			</div>

			{/* 分享弹窗（复用现有） */}
			{shareOpen && loadedPath && (
				<ShareResultModal
					paths={[loadedPath]}
					sessionId={sessionId ?? undefined}
					onClose={() => setShareOpen(false)}
				/>
			)}
		</div>
	);
}
