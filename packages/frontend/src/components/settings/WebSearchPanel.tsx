import { useEffect, useState } from "react";
import { formatApiError } from "../../util/kernel-error";
import { useTranslation } from "../../i18n/useTranslation";
import { api } from "../../api-client";
import { useToastStore } from "../../store/toast";

/**
 * 互联网搜索面板（设置 → 联网 → 互联网搜索 tab）：
 * 供应商选择（Bing（免费，无需 Key）/ DeepSeek / 智谱 BigModel，默认 bing）+ 搜索/抓取双开关 + 各自 API Key（密码框，已保存时脱敏展示）。
 * 保存走 GET/PUT /api/settings/websearch；key 明文只在 PUT 上行，回包恒脱敏（hasApiKey*）。
 * 开关/供应商决定扩展注册面——保存后 kernel 标脏重建会话生效；key 本身即时生效。
 */

type WebSearchProvider = "bing" | "deepseek" | "bigmodel";

interface WebSearchSettingsView {
	provider: WebSearchProvider;
	searchEnabled: boolean;
	fetchEnabled: boolean;
	hasApiKey: boolean;
	hasApiKeyBigmodel: boolean;
}

/** key 输入框的掩码/编辑状态 */
interface KeyState {
	value: string;
	hasSaved: boolean;
	touched: boolean;
}

export function WebSearchPanel() {
	const { t } = useTranslation();
	const [provider, setProvider] = useState<WebSearchProvider>("bing");
	const [searchEnabled, setSearchEnabled] = useState(true);
	const [fetchEnabled, setFetchEnabled] = useState(true);
	const [deepseekKey, setDeepseekKey] = useState<KeyState>({
		value: "",
		hasSaved: false,
		touched: false,
	});
	const [bigmodelKey, setBigmodelKey] = useState<KeyState>({
		value: "",
		hasSaved: false,
		touched: false,
	});
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		api
			.get("/api/settings/websearch")
			.then((res) => {
				const ws = (res as { webSearch?: WebSearchSettingsView })?.webSearch;
				if (!ws) return;
				if (
					ws.provider === "bigmodel" ||
					ws.provider === "deepseek" ||
					ws.provider === "bing"
				)
					setProvider(ws.provider);
				setSearchEnabled(ws.searchEnabled);
				setFetchEnabled(ws.fetchEnabled);
				setDeepseekKey((prev) => ({ ...prev, hasSaved: ws.hasApiKey }));
				setBigmodelKey((prev) => ({ ...prev, hasSaved: ws.hasApiKeyBigmodel }));
			})
			.catch(() => {});
	}, []);

	const save = async () => {
		setSaving(true);
		try {
			const res = await api.put("/api/settings/websearch", {
				webSearch: {
					provider,
					searchEnabled,
					fetchEnabled,
					// 原样上传：输入了新值就覆盖；空串 = 服务端保留已存 key
					apiKey: deepseekKey.value,
					apiKeyBigmodel: bigmodelKey.value,
				},
			});
			const ws = (res as { webSearch?: WebSearchSettingsView })?.webSearch;
			if (ws) {
				setDeepseekKey((prev) => ({ ...prev, hasSaved: ws.hasApiKey }));
				setBigmodelKey((prev) => ({ ...prev, hasSaved: ws.hasApiKeyBigmodel }));
			}
			setDeepseekKey((prev) => ({ ...prev, value: "", touched: false }));
			setBigmodelKey((prev) => ({ ...prev, value: "", touched: false }));
			setSaved(true);
			useToastStore.getState().add(t("settings.websearch.saved"), "success");
			setTimeout(() => setSaved(false), 2000);
		} catch (err) {
			useToastStore.getState().add(formatApiError(err), "error");
		} finally {
			setSaving(false);
		}
	};

	const keyField = (
		state: KeyState,
		onTouched: () => void,
		onChange: (v: string) => void,
		testid: string,
	) =>
		state.hasSaved && !state.touched ? (
			<div className="flex items-center gap-3 w-72" data-testid={`${testid}-mask`}>
				<span className="text-sm text-secondary tracking-widest">••••••••</span>
				<button
					onClick={onTouched}
					className="px-2 py-1 rounded-sm border border-hairline bg-surface text-xs text-secondary cursor-pointer hover:text-primary transition-colors"
					data-testid={`${testid}-modify`}
				>
					{t("settings.share.modify")}
				</button>
			</div>
		) : (
			<input
				type="password"
				value={state.value}
				onChange={(e) => onChange(e.target.value)}
				placeholder="sk-..."
				autoComplete="off"
				spellCheck={false}
				className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none w-72"
				data-testid={`${testid}-input`}
			/>
		);

	return (
		<div className="flex flex-col gap-4" data-testid="websearch-panel">
			<div className="flex flex-col gap-1" data-testid="websearch-provider">
				<span className="text-sm font-medium text-primary">
					{t("settings.websearch.providerLabel")}
				</span>
				<select
					value={provider}
					onChange={(e) => setProvider(e.target.value as WebSearchProvider)}
					className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none w-56"
					data-testid="websearch-provider-select"
					aria-label={t("settings.websearch.providerLabel")}
				>
					<option value="bing">{t("settings.websearch.providerBing")}</option>
					<option value="deepseek">{t("settings.websearch.providerDeepseek")}</option>
					<option value="bigmodel">{t("settings.websearch.providerBigmodel")}</option>
				</select>
			</div>

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

			{provider === "deepseek" && (
				<label className="flex flex-col gap-1 w-fit">
					<span className="text-sm font-medium text-primary">
						{t("settings.websearch.apiKey")}
					</span>
					{keyField(
						deepseekKey,
						() => setDeepseekKey((prev) => ({ ...prev, touched: true })),
						(v) => setDeepseekKey((prev) => ({ ...prev, value: v })),
						"websearch-key-deepseek",
					)}
					<span className="text-xs text-secondary">
						{t("settings.websearch.apiKeyHint")}
					</span>
				</label>
			)}

			{provider === "bigmodel" && (
				<label className="flex flex-col gap-1 w-fit">
					<span className="text-sm font-medium text-primary">
						{t("settings.websearch.apiKeyBigmodel")}
					</span>
					{keyField(
						bigmodelKey,
						() => setBigmodelKey((prev) => ({ ...prev, touched: true })),
						(v) => setBigmodelKey((prev) => ({ ...prev, value: v })),
						"websearch-key-bigmodel",
					)}
					<span className="text-xs text-secondary">
						{t("settings.websearch.apiKeyBigmodelHint")}
					</span>
				</label>
			)}

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
