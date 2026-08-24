import { useEffect, useRef, useState } from "react";
import { Icon } from "./ui/Icon";
import { useBrowserStore } from "../store/browser";
import { useSessionStore } from "../store/session";
import { HtmlPreview } from "./blocks/HtmlPreview";
import { ShareResultModal } from "./ui/ShareButton";
import { isHtmlPath, toExternalUrl } from "../preview-url";
import { copyToClipboard } from "../util/clipboard";
import { useToastStore } from "../store/toast";
import { useProjectsStore } from "../store/projects";
import { useTranslation } from "../i18n/useTranslation";
import { parseInspectMessage, sendElementToChat } from "../element-pick";

type Current =
	| { kind: "local"; path: string }
	| { kind: "external"; url: string };

/** 预览元素高亮选择的开关状态（主应用本地保存；本地预览 iframe 为不透明源无法自存，故放主应用） */
const INSPECT_KEY = "hiagent.preview.inspect";

export function BrowserPanel() {
	// 逐字段 selector 订阅：整订阅会让 splitRatio/floatRect 拖拽期的每帧变化也触发本组件重渲染
	const path = useBrowserStore((s) => s.path);
	const sessionId = useBrowserStore((s) => s.sessionId);
	const closeBrowser = useBrowserStore((s) => s.closeBrowser);
	const mode = useBrowserStore((s) => s.mode);
	const setMode = useBrowserStore((s) => s.setMode);
	const [current, setCurrent] = useState<Current | null>(
		path ? { kind: "local", path } : null,
	);
	const [input, setInput] = useState(path ?? "");
	const [refreshKey, setRefreshKey] = useState(0);
	const [shareOpen, setShareOpen] = useState(false);
	const { t } = useTranslation();
	const addToast = useToastStore((s) => s.add);

	// store.path 变化（切换会话恢复预览 / 外部 setPath）时同步内部 current 与地址栏输入；
	// 否则面板挂载期间不会随 path 变化而更新，会话切换恢复时仍显示旧内容。
	// 注意：外部 URL 导航只写 current 不写 store.path，故 path 不变时此 effect 不触发、不会覆盖外部视图。
	useEffect(() => {
		setCurrent(path ? { kind: "local", path } : null);
		setInput(path ?? "");
	}, [path]);

	const loadedPath = current?.kind === "local" ? current.path : null;
	const externalUrl = current?.kind === "external" ? current.url : null;

	const openPath = (raw: string) => {
		const p = raw.trim();
		// 绝对路径判定：POSIX（/ 开头）、Windows 盘符（C:\ 或 C:/ 开头）、UNC（\\server\share）均放行
		const isAbs =
			p.startsWith("/") || p.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(p);
		if (!isAbs) {
			// 先尝试外部 URL（http/https 或域名/IP/localhost，自动补协议）
			const external = toExternalUrl(p);
			if (external) {
				// 同源拒绝：外部模式带 allow-same-origin，禁止加载宿主自身源
				// （否则内嵌页面可读写父页面 DOM、以同源身份访问 kernel API）
				try {
					const u = new URL(external);
					if (u.origin === window.location.origin) {
						addToast(t("browser.invalidPath"), "error");
						return;
					}
				} catch {
					/* 解析失败走正常外部加载 */
				}
				setCurrent({ kind: "external", url: external });
				setInput(p);
				return;
			}
			// 相对 html 路径暂不支持（地址栏只接受绝对路径或网址）
			if (isHtmlPath(p)) {
				addToast(t("browser.invalidPath"), "error");
				return;
			}
			addToast(t("browser.invalidPath"), "error");
			return;
		}
		// 项目内校验：已有项目时路径必须落在某项目 cwd 下，避免加载项目外任意文件。
		// 比较前规范化：统一分隔符为 /、统一小写、去尾斜杠（Windows 盘符大小写/分隔符混用兼容）
		const cwdList = useProjectsStore
			.getState()
			.projects.map((p) => p.cwd)
			.filter(Boolean);
		if (cwdList.length > 0) {
			const norm = (s: string) =>
				s
					.replace(/[\\/]+$/, "")
					.replace(/\\/g, "/")
					.toLowerCase() || "/";
			const pp = norm(p);
			const inside = cwdList.some((cwd) => {
				const c = norm(cwd);
				// 根目录项目：任意绝对路径都在项目内（p 已通过上面的绝对路径判定）
				if (c === "/") return true;
				return pp === c || pp.startsWith(c + "/");
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
		setCurrent({ kind: "local", path: p });
		setInput(p);
		// 同步到 store：模式切换（split/full/float）重挂面板后可恢复预览内容
		useBrowserStore.getState().setPath(p);
	};

	const copyCurrent = () => {
		if (!current) return;
		void copyToClipboard(
			current.kind === "local" ? current.path : current.url,
		).then(() => addToast(t("browser.copied"), "success"));
	};

	const iframeRef = useRef<HTMLIFrameElement | null>(null);

	// inspect 消息监听：仅本地预览；source 必须来自预览 iframe（独特源 origin 为 "null"，
	// 不能按 origin 校验），消息体经 parseInspectMessage 白名单校验
	useEffect(() => {
		if (!loadedPath) return;
		const path = loadedPath;
		const onMessage = (e: MessageEvent) => {
			if (e.source !== iframeRef.current?.contentWindow) return;
			const data = e.data as any;
			// 预览 iframe 上报：查询/回写「高亮选择功能」开关状态（主应用持久化）
			if (data?.type === "hiagent:inspect:query") {
				const enabled = localStorage.getItem(INSPECT_KEY) !== "off";
				iframeRef.current?.contentWindow?.postMessage(
					{ type: "hiagent:inspect:set", enabled },
					"*",
				);
				return;
			}
			if (data?.type === "hiagent:inspect:changed") {
				localStorage.setItem(INSPECT_KEY, data.enabled ? "on" : "off");
				return;
			}
			const picked = parseInspectMessage(e.data);
			if (!picked) return;
			const browser = useBrowserStore.getState();
			if (browser.mode === "full") {
				// 全屏时聊天（及输入框）未挂载：先切回分屏让 composer 挂载，再延迟投递插入事件
				browser.setMode("split");
				setTimeout(() => void sendElementToChat(path, picked), 150);
			} else {
				void sendElementToChat(path, picked);
			}
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [loadedPath]);

	const canCodeShare = loadedPath !== null;

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
					disabled={!current}
					onClick={copyCurrent}
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
					disabled={!current}
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
					title={t("browser.modeSplit")}
					data-testid="browser-mode-split"
					aria-pressed={mode === "split"}
					onClick={() => setMode("split")}
					style={mode === "split" ? { color: "var(--brand)" } : undefined}
				>
					<Icon
						name="columns"
						size="1em"
						className="text-[calc(16px*var(--font-scale))]"
					/>
				</button>
				<button
					type="button"
					className="fv-btn fv-btn--icon"
					title={t("browser.modeFull")}
					data-testid="browser-mode-full"
					aria-pressed={mode === "full"}
					onClick={() => setMode("full")}
					style={mode === "full" ? { color: "var(--brand)" } : undefined}
				>
					<Icon
						name="monitor"
						size="1em"
						className="text-[calc(16px*var(--font-scale))]"
					/>
				</button>
				<button
					type="button"
					className="fv-btn fv-btn--icon"
					title={t("browser.modeFloat")}
					data-testid="browser-mode-float"
					aria-pressed={mode === "float"}
					onClick={() => setMode("float")}
					style={mode === "float" ? { color: "var(--brand)" } : undefined}
				>
					<Icon
						name="float"
						size="1em"
						className="text-[calc(16px*var(--font-scale))]"
					/>
				</button>
				{/* 最小化为气泡（仅浮动模式显示；气泡点击可恢复） */}
				{mode === "float" && (
					<button
						type="button"
						className="fv-btn fv-btn--icon"
						title={t("browser.minimize")}
						data-testid="browser-minimize"
						onClick={() => useBrowserStore.getState().setMinimized(true)}
					>
						<Icon
							name="minus"
							size="1em"
							className="text-[calc(16px*var(--font-scale))]"
						/>
					</button>
				)}
				<button
					type="button"
					className="fv-btn fv-btn--icon"
					title={t("browser.code")}
					data-testid="browser-code"
					disabled={!canCodeShare}
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
					disabled={!canCodeShare}
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
				{current ? (
					current.kind === "local" ? (
						<HtmlPreview
							ref={iframeRef}
							path={current.path}
							refreshKey={refreshKey}
						/>
					) : (
						<HtmlPreview
							ref={iframeRef}
							externalUrl={current.url}
							refreshKey={refreshKey}
						/>
					)
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

			{/* 分享弹窗（复用现有；仅本地文件可分享） */}
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
