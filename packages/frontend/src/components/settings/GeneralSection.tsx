import { useEffect, useState } from "react";
import { api } from "../../api-client";
import type { RetrySettings } from "@wa-pi/shared";

/** 与 kernel settings-store 的产品约束对齐（重试最多 10 次；间隔 0.5s-60s） */
const MAX_RETRIES = 10;
const MIN_DELAY_S = 0.5;
const MAX_DELAY_S = 60;

/**
 * 通用设置：pi 自动重试配置（transient 错误——网络/超时/5xx/限流——后的自动重试）。
 * 保存到 settings.json.retry，pi 进程启动时加载；kernel 保存后会标脏活跃会话，
 * 下次发消息时重建进程生效。
 */
export function GeneralSection() {
	const [maxRetries, setMaxRetries] = useState("3");
	const [delaySeconds, setDelaySeconds] = useState("2");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		api
			.get("/api/settings/retry")
			.then((res) => {
				const retry = (res as any)?.retry as RetrySettings | undefined;
				if (retry) {
					setMaxRetries(String(retry.maxRetries));
					setDelaySeconds(String(retry.baseDelayMs / 1000));
				}
			})
			.catch((e) => setError(e instanceof Error ? e.message : String(e)))
			.finally(() => setLoading(false));
	}, []);

	const handleSave = async () => {
		const retries = Number(maxRetries);
		const delayMs = Math.round(Number(delaySeconds) * 1000);
		setSaving(true);
		setError(null);
		setSaved(false);
		try {
			await api.put("/api/settings/retry", {
				retry: { maxRetries: retries, baseDelayMs: delayMs },
			});
			setSaved(true);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	};

	if (loading) {
		return <div className="p-4 text-sm text-tertiary">加载中…</div>;
	}

	return (
		<div className="flex flex-col gap-4 p-4 overflow-auto">
			<div className="flex flex-col gap-1">
				<span className="text-sm font-medium text-primary">自动重试</span>
				<span className="text-xs text-tertiary">
					模型请求遇到网络错误 / 超时 / 5xx / 限流时自动重试，重试间隔按「间隔
					× 2ⁿ」递增。保存后对新请求生效。
				</span>
			</div>
			<label className="flex flex-col gap-1 w-56">
				<span className="text-xs text-secondary">重试次数（0-{MAX_RETRIES}）</span>
				<input
					type="number"
					min={0}
					max={MAX_RETRIES}
					step={1}
					value={maxRetries}
					onChange={(e) => {
						setMaxRetries(e.target.value);
						setSaved(false);
					}}
					className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
					data-testid="retry-max-input"
				/>
			</label>
			<label className="flex flex-col gap-1 w-56">
				<span className="text-xs text-secondary">
					重试间隔基数（秒，{MIN_DELAY_S}-{MAX_DELAY_S}）
				</span>
				<input
					type="number"
					min={MIN_DELAY_S}
					max={MAX_DELAY_S}
					step={0.5}
					value={delaySeconds}
					onChange={(e) => {
						setDelaySeconds(e.target.value);
						setSaved(false);
					}}
					className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
					data-testid="retry-delay-input"
				/>
			</label>
			<div className="flex items-center gap-3">
				<button
					onClick={() => void handleSave()}
					disabled={saving}
					className={`self-start px-3 py-1.5 rounded-sm text-sm border-0 ${saving ? "text-tertiary cursor-not-allowed" : "cursor-pointer"}`}
					style={
						saving
							? { background: "var(--surface-hover)" }
							: { background: "var(--brand)", color: "var(--on-brand)" }
					}
					data-testid="retry-save-btn"
				>
					{saving ? "保存中…" : "保存"}
				</button>
				{saved && <span className="text-xs text-secondary">已保存</span>}
				{error && (
					<span
						className="text-xs"
						style={{ color: "var(--danger)" }}
						data-testid="retry-save-error"
					>
						{error}
					</span>
				)}
			</div>
		</div>
	);
}
