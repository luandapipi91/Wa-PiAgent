import { Modal } from "../ui/Modal";
import { ThemePicker } from "./ThemePicker";
import { useUiPrefsStore } from "../../store/ui-prefs";
import { useTranslation } from "../../i18n/useTranslation";

interface Props {
	onClose: () => void;
}

/**
 * 升级后一次性主题引导：单页八张卡片，确认或关闭即结束。
 * 不重复问模型与智能体（老用户早就配好了）。
 */
export function ThemeIntroModal({ onClose }: Props) {
	const { t } = useTranslation();

	return (
		<Modal onClose={onClose} width={760} data-testid="theme-intro">
			<div className="border-b border-hairline p-4">
				<div className="flex items-start justify-between gap-4">
					<div className="flex flex-col gap-1">
						<div className="text-sm font-medium text-primary">
							{t("themeIntro.title")}
						</div>
						<div className="text-xs text-tertiary">
							{t("themeIntro.desc")}
						</div>
					</div>
					<button
						onClick={onClose}
						className="text-tertiary text-xs"
						data-testid="theme-intro-close"
						aria-label={t("common.close")}
					>
						✕
					</button>
				</div>
			</div>
			<div className="max-h-[70vh] overflow-auto p-4">
				<ThemePicker
					showConfirm
					onConfirm={(mode) => {
						useUiPrefsStore.getState().setThemeMode(mode);
						onClose();
					}}
				/>
			</div>
		</Modal>
	);
}
