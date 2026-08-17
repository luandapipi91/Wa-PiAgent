import { useEffect, useState } from "react";
import { useTranslation } from "../../i18n/useTranslation";
import { api } from "../../api-client";
import { useToastStore } from "../../store/toast";

/**
 * 分享设置：产物分享渠道（当前仅「腾讯 EdgeOne」，只读展示）与 API Token。
 * 挂载时 GET /api/settings/share 回填；保存 PUT /api/settings/share。
 * Token 用 type="password" 输入；已保存时脱敏展示（•••）并可「修改」切回输入。
 */
export function ShareSection() {
	const { t } = useTranslation();
	const [token, setToken] = useState("");
	const [saved, setSaved] = useState(false);
	const [saving, setSaving] = useState(false);

	// mount：回填已保存的分享配置。有 token 时进入脱敏展示态。
	useEffect(() => {
		api
			.get("/api/settings/share")
			.then((res) => {
				const share = (res as { share?: { token?: string } })?.share;
				if (share?.token) setSaved(true);
			})
			.catch(() => {});
	}, []);

	// 已保存且有值 → 脱敏展示（掩码 + 「修改」）；否则显示输入框
	const masked = saved && token === "";

	const save = async () => {
		setSaving(true);
		try {
			await api.put("/api/settings/share", {
				share: { token, channel: "edgeone" },
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

	return (
		<div className="flex flex-col gap-4 p-4 overflow-auto" data-testid="share-section">
			<div className="flex flex-col gap-1">
				<span className="text-sm font-medium text-primary">
					{t("settings.share.channel")}
				</span>
				<span className="text-xs text-secondary">腾讯 EdgeOne</span>
			</div>
			{masked ? (
				<div className="flex items-center gap-3 w-72" data-testid="share-token-mask">
					<span className="text-sm text-secondary tracking-widest">••••••••</span>
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
			{!masked && (
				<button
					onClick={() => void save()}
					disabled={saving}
					className="self-start px-3 py-1.5 rounded-sm text-sm border-0 cursor-pointer"
					style={{ background: "var(--brand)", color: "var(--on-brand)" }}
					data-testid="share-token-save"
				>
					{saving ? t("common.saving") : t("common.save")}
				</button>
			)}
		</div>
	);
}
