// packages/frontend/src/components/settings/CommandListModal.tsx
// 插件「附加命令」弹窗：打开时拉取 /api/extensions/commands，按 packageName 过滤，
// 每条命令带开关（默认关）。
import { useEffect, useState } from "react";
import { useTranslation } from "../../i18n/useTranslation";
import type { CommandInfo } from "@wa-pi/shared";
import { api } from "../../api-client";
import { Modal } from "../ui/Modal";

interface CommandListModalProps {
	packageName: string;
	onClose: () => void;
}

export function CommandListModal({
	packageName,
	onClose,
}: CommandListModalProps) {
	const [commands, setCommands] = useState<CommandInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const { t } = useTranslation();

	// 打开时拉取全部命令并按 packageName 过滤
	useEffect(() => {
		let cancelled = false;
		api
			.get("/api/extensions/commands")
			.then((data: any) => {
				if (cancelled) return;
				const all: CommandInfo[] = Array.isArray(data?.commands)
					? data.commands
					: [];
				setCommands(all.filter((c) => c.packageName === packageName));
			})
			.catch(() => {
				if (!cancelled) setCommands([]);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [packageName]);

	// 即切即存：乐观翻转本地状态 + POST toggle；失败回滚
	const handleToggle = async (command: CommandInfo) => {
		const next = !command.enabled;
		setCommands((prev) =>
			prev.map((c) => (c.name === command.name ? { ...c, enabled: next } : c)),
		);
		try {
			await api.post("/api/extensions/commands/toggle", {
				packageName,
				command: command.name,
				enabled: next,
			});
		} catch {
			setCommands((prev) =>
				prev.map((c) =>
					c.name === command.name ? { ...c, enabled: command.enabled } : c,
				),
			);
		}
	};

	return (
		<Modal onClose={onClose} width={520} data-testid="command-list-modal">
			{/* 标题栏 */}
			<div className="flex items-center justify-between px-4 py-3 border-b border-hairline">
				<span className="text-sm font-semibold text-primary">
					{t("settings.extension.commandTitle", { name: packageName })}
				</span>
				<button
					className="text-lg leading-none text-tertiary hover:text-primary cursor-pointer"
					onClick={onClose}
					data-testid="cmd-modal-close"
					aria-label={t("common.close")}
				>
					×
				</button>
			</div>

			{/* 命令列表 */}
			<div className="flex-1 overflow-auto">
				{loading ? (
					<div
						className="flex items-center justify-center gap-2 py-8 text-sm text-tertiary"
						data-testid="cmd-loading"
					>
						<span
							className="inline-block w-4 h-4 rounded-full"
							style={{
								border: "2px solid var(--hairline)",
								borderTopColor: "var(--accent)",
								animation: "spin 0.8s linear infinite",
							}}
							/>
							{t("settings.extension.commandLoading")}
						</div>
					) : commands.length === 0 ? (
						<p
							className="text-sm text-tertiary py-6 text-center"
							data-testid="cmd-empty"
						>
							{t("settings.extension.commandEmpty")}
						</p>
				) : (
					commands.map((cmd) => (
						<div
							key={cmd.name}
							className="flex items-start gap-3 px-4 py-3 border-b border-hairline"
							data-testid={`cmd-row-${cmd.name}`}
						>
							<div className="flex-1 min-w-0">
								<div className="flex items-center gap-2 flex-wrap">
									<span className="text-sm font-semibold text-primary font-mono">
										/{cmd.name}
									</span>
								</div>
								{cmd.description && (
									<p className="text-xs text-secondary mt-0.5">
										{cmd.description}
									</p>
								)}
							</div>

							{/* 命令开关（默认关，读 enabled） */}
							<label
								className="relative inline-block cursor-pointer flex-shrink-0"
								style={{ marginTop: 4 }}
								onClick={() => handleToggle(cmd)}
								data-testid={`cmd-toggle-${cmd.name}`}
							>
								<span
									className="relative inline-block rounded-full transition-colors"
									style={{
										width: 38,
										height: 22,
										background: cmd.enabled ? "var(--brand)" : "var(--hairline-strong)",
									}}
								>
									<span
										className="absolute top-0.5 rounded-full bg-white transition-all"
										style={{
											width: 18,
											height: 18,
											left: cmd.enabled ? undefined : 2,
											right: cmd.enabled ? 2 : undefined,
											boxShadow: "0 1px 2px rgba(0,0,0,.1)",
										}}
									/>
								</span>
							</label>
						</div>
					))
				)}
			</div>
		</Modal>
	);
}
