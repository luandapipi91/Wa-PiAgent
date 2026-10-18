import { useEffect, useState } from "react";
import { formatApiError } from "../../util/kernel-error";
import { useTranslation } from "../../i18n/useTranslation";
import { api } from "../../api-client";
import { useToastStore } from "../../store/toast";

/**
 * 互联网搜索面板（设置 → 联网 → 互联网搜索 tab）：
 * DeepSeek 搜索/抓取双开关 + 共用 API Key（密码框，已保存时脱敏展示）。
 * 保存走 GET/PUT /api/settings/websearch；key 明文只在 PUT 上行，回包恒脱敏（hasApiKey）。
 * kernel 侧 web-access 扩展每次工具执行时自读同一 settings.json，保存后即时生效，无需重启。
 */

interface WebSearchSettingsView {
	searchEnabled: boolean;
	fetchEnabled: boolean;
	hasApiKey: boolean;
}

export function WebSearchPanel() {
	const { t } = useTranslation();
	const [searchEnabled, setSearchEnabled] = useState(true);
	const [fetchEnabled, setFetchEnabled] = useState(true);
	const [apiKey, setApiKey] = useState("");
	// 服务端是否已存 key（决定掩码态）；keyTouched 表示用户点了「修改」进入输入态
	const [hasKey, setHasKey] = useState(false);
	const [keyTouched, setKeyTouched] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		api
			.get("/api/settings/websearch")
			.then((res) => {
				const ws = (res as { webSearch?: WebSearchSettingsView })?.webSearch;
				if (!ws) return;
				setSearchEnabled(ws.searchEnabled);
				setFetchEnabled(ws.fetchEnabled);
				setHasKey(ws.hasApiKey);
			})
			.catch(() => {});
	}, []);

	const save = async () => {
		setSaving(true);
		try {
			const res = await api.put("/api/settings/websearch", {
				webSearch: {
					searchEnabled,
					fetchEnabled,
					// 空串 = 保留已存 key（服务端语义）；输入了新值才覆盖
					apiKey,
				},
			});
			const ws = (res as { webSearch?: WebSearchSettingsView })?.webSearch;
			if (ws) setHasKey(ws.hasApiKey);
			setApiKey("");
			setKeyTouched(false);
			setSaved(true);
			useToastStore.getState().add(t("settings.websearch.saved"), "success");
			setTimeout(() => setSaved(false), 2000);
		} catch (err) {
			useToastStore.getState().add(formatApiError(err), "error");
		} finally {
			setSaving(false);
		}
	};

	const keyField =
		hasKey && !keyTouched ? (
			<div className="flex items-center gap-3 w-72" data-testid="websearch-key-mask">
				<span className="text-sm text-secondary tracking-widest">••••••••</span>
				<button
					onClick={() => setKeyTouched(true)}
					className="px-2 py-1 rounded-sm border border-hairline bg-surface text-xs text-secondary cursor-pointer hover:text-primary transition-colors"
					data-testid="websearch-key-modify"
				>
					{t("settings.share.modify")}
				</button>
			</div>
		) : (
			<input
				type="password"
				value={apiKey}
				onChange={(e) => setApiKey(e.target.value)}
				placeholder="sk-..."
				autoComplete="off"
				spellCheck={false}
				className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none w-72"
				data-testid="websearch-key-input"
			/>
		);

	return (
		<div className="flex flex-col gap-4" data-testid="websearch-panel">
			<p className="text-xs text-secondary leading-relaxed">
				{t("settings.websearch.desc")}
			</p>

			<label className="flex flex-col gap-1 cursor-pointer w-fit">
				<span className="flex items-center gap-2">
					<input
						type="checkbox"
						checked={searchEnabled}
						onChange={(e) => setSearchEnabled(e.target.checked)}
						data-testid="websearch-toggle-search"
					/>
					<span className="text-sm font-medium text-primary">
						{t("settings.websearch.searchToggle")}
					</span>
				</span>
				<span className="text-xs text-secondary">
					{t("settings.websearch.searchToggleHint")}
				</span>
			</label>

			<label className="flex flex-col gap-1 cursor-pointer w-fit">
				<span className="flex items-center gap-2">
					<input
						type="checkbox"
						checked={fetchEnabled}
						onChange={(e) => setFetchEnabled(e.target.checked)}
						data-testid="websearch-toggle-fetch"
					/>
					<span className="text-sm font-medium text-primary">
						{t("settings.websearch.fetchToggle")}
					</span>
				</span>
				<span className="text-xs text-secondary">
					{t("settings.websearch.fetchToggleHint")}
				</span>
			</label>

			<label className="flex flex-col gap-1 w-fit">
				<span className="text-sm font-medium text-primary">
					{t("settings.websearch.apiKey")}
				</span>
				{keyField}
				<span className="text-xs text-secondary">
					{t("settings.websearch.apiKeyHint")}
				</span>
			</label>

			<div className="flex items-center gap-3">
				<button
					onClick={() => void save()}
					disabled={saving}
					className="px-3 py-1.5 rounded-sm bg-brand text-white text-sm cursor-pointer disabled:opacity-50 border-0"
					data-testid="websearch-save"
				>
					{saving ? t("settings.websearch.saving") : t("settings.websearch.save")}
				</button>
				{saved && (
					<span className="text-xs text-success" data-testid="websearch-saved">
						{t("settings.websearch.savedIndicator")}
					</span>
				)}
			</div>
		</div>
	);
}
