import { useEffect, useRef, useState } from "react";
import { Icon } from "./ui/Icon";
import { useBrowserStore } from "../store/browser";
import { useSessionStore } from "../store/session";
import { HtmlPreview } from "./blocks/HtmlPreview";
import { ShareResultModal } from "./ui/ShareButton";
import { SidebarResizer } from "./SidebarResizer";
import {
	URLBAR_WIDTH_KEY,
	MIN_URLBAR_W,
	urlBarMaxW,
	halfUrlBarW,
	loadStoredUrlBarW,
} from "./urlbar-size";
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
	// 刷新令牌在 store：手动按钮与「任务完成修改清单命中预览文件」的自动刷新同源递增，
	// 令牌变化 → HtmlPreview iframe key 变化 → 重挂重拉磁盘最新内容
	const refreshToken = useBrowserStore((s) => s.refreshToken);
	const bumpRefresh = useBrowserStore((s) => s.bumpRefresh);
	const [shareOpen, setShareOpen] = useState(false);
	// 元素选中开关的可视镜像：真相源仍是 localStorage（与 kernel 注入脚本共享），
	// 这里同步展示——点击开关写入并即时下发，iframe 内快捷键切换后经 changed 消息反向同步
	const [inspectOn, setInspectOn] = useState(
		() => localStorage.getItem(INSPECT_KEY) !== "off",
	);
	// 地址栏宽度：null = 未定制 → CSS 50% 占工具栏一半；拖拽后记录数值并持久化，
	// 上限 = 工具栏宽 − 图标按钮区预留，伸缩不得挤占图标
	const [urlW, setUrlW] = useState<number | null>(loadStoredUrlBarW);
	const toolbarRef = useRef<HTMLDivElement | null>(null);
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

	// 拖拽中实时更新宽度并逐次落盘（localStorage 同步轻量，无需等 mouseup 事件回调）
	const handleUrlResize = (w: number) => {
		setUrlW(w);
		localStorage.setItem(URLBAR_WIDTH_KEY, String(w));
	};

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
				// 回复给提问者（e.source）而非当前 ref：iframe 换代窗口内旧/新文档交替，
				// 发给 ref 可能落到错误窗口，提问者收不到回复会永久停在初值
				(e.source as Window | null)?.postMessage(
					{ type: "hiagent:inspect:set", enabled },
					"*",
				);
				return;
			}
			if (data?.type === "hiagent:inspect:changed") {
				localStorage.setItem(INSPECT_KEY, data.enabled ? "on" : "off");
				setInspectOn(Boolean(data.enabled));
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

	// Cmd/Ctrl 单按切换「元素选中」主应用侧双通道：与预览页内快捷键互补。
	// 焦点在预览 iframe 内时按键进 iframe 文档（不跨文档冒泡，不会双触发）；
	// 焦点在主应用（输入框/空白处）时由本监听兜底——否则首次切换后焦点一旦
	// 漂回主应用，后续 Cmd 静默失效，表现为「选中功能又丢了」。
	useEffect(() => {
		if (!loadedPath) return;
		let pending: string | null = null;
		// 与预览页内快捷键同款去抖：部分键盘/驱动会双发 Meta keydown(非 repeat)
		// +keyup 配对，第二配对在本窗内忽略——否则一次按键切换两次（开了又关）
		let lastToggleAt = 0;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Control" || e.key === "Meta") {
				if (!e.repeat) pending = e.key;
			} else {
				pending = null; // 组合键（⌘C/⌘V 等）：取消待翻转
			}
		};
		const onKeyUp = (e: KeyboardEvent) => {
			if ((e.key === "Control" || e.key === "Meta") && pending === e.key) {
				pending = null;
				const now = performance.now();
				if (now - lastToggleAt < 150) return;
				lastToggleAt = now;
				setInspectOn((prev) => {
					const next = !prev;
					localStorage.setItem(INSPECT_KEY, next ? "on" : "off");
					iframeRef.current?.contentWindow?.postMessage(
						{ type: "hiagent:inspect:set", enabled: next },
						"*",
					);
					return next;
				});
			}
		};
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("keyup", onKeyUp);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("keyup", onKeyUp);
		};
	}, [loadedPath]);

	const canCodeShare = loadedPath !== null;

	// 显性开关切换：写回持久层 + 即时通知预览 iframe 生效（不等下次 query 上报）
	const toggleInspect = () => {
		const next = !inspectOn;
		setInspectOn(next);
		localStorage.setItem(INSPECT_KEY, next ? "on" : "off");
		pushInspectState(next);
	};

	// iframe load 完成后主动下发当前开关状态：head 内同步 inspect 脚本此时监听器必已
	// 注册，push 一次确定性对齐。反向兑底（iframe 加载时主动 query→主应用回复）在换代
	// 窗口内可能被 source 校验丢弃，两通道任一成功即同步；push 幂等，双达无害。
	const pushInspectState = (enabled: boolean) => {
		iframeRef.current?.contentWindow?.postMessage(
			{ type: "hiagent:inspect:set", enabled },
			"*",
		);
	};

	return (
		<div className="flex flex-col h-full bg-surface" data-testid="browser-panel">
			{/* 工具栏：地址栏定宽可拖拽调宽；空白吸收在输入区与按钮之间 → 按钮贴右缘 */}
			<div
				ref={toolbarRef}
				className="flex items-center gap-1.5 px-3 py-2 border-b border-hairline"
			>
				<div
					className="flex shrink-0 items-center gap-2 px-2 py-1.5 rounded-md border border-hairline bg-surface-hover"
					style={{ width: urlW ?? "50%", minWidth: MIN_URLBAR_W }}
				>
					<Icon name="globe" size={14} className="text-secondary" />
					<input
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && openPath(input)}
						placeholder={t("browser.placeholder")}
						spellCheck={false}
						className="w-full bg-transparent text-sm text-primary outline-none"
						data-testid="browser-input"
					/>
				</div>
				{/* 拖拽把手：调地址栏宽度，上限扣除右侧按钮区不挤占图标；
					inline 形态=可见小把手+hover 高亮 */}
				<div className="self-stretch flex items-center">
					<SidebarResizer
						side="left"
						testId="browser-url-resize"
						variant="inline"
						title={t("browser.urlbarResize")}
						minWidth={MIN_URLBAR_W}
						maxRatio={0.6}
						getWidth={() => urlW ?? halfUrlBarW(toolbarRef.current?.clientWidth ?? 0)}
						onResize={handleUrlResize}
						getMaxPx={() => urlBarMaxW(toolbarRef.current?.clientWidth ?? 0)}
					/>
				</div>
				{/* 弹性空白：把所有动作按钮推到工具栏右缘 */}
				<div className="flex-1" />
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
					onClick={bumpRefresh}
				>
					<Icon
						name="refresh"
						size="1em"
						className="text-[calc(16px*var(--font-scale))]"
					/>
				</button>
				{/* 元素选中显性开关：与预览页内 Ctrl/⌘ 快捷键双通道同源，仅本地预览可用（外部 URL 无注入脚本） */}
				<button
					type="button"
					className="fv-btn fv-btn--icon"
					title={t("browser.inspect")}
					data-testid="browser-inspect"
					aria-pressed={inspectOn}
					disabled={!loadedPath}
					onClick={toggleInspect}
					style={inspectOn ? { color: "var(--brand)" } : undefined}
				>
					<Icon
						name="element"
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
							refreshKey={refreshToken}
							onLoad={() =>
								pushInspectState(localStorage.getItem(INSPECT_KEY) !== "off")
							}
						/>
					) : (
						<HtmlPreview
							ref={iframeRef}
							externalUrl={current.url}
							refreshKey={refreshToken}
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
