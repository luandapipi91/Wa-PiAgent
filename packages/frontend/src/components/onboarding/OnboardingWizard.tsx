import { useState } from "react";
import { Modal } from "../ui/Modal";
import { ProviderForm } from "../settings/ProviderForm";
import { AgentCreatePicker } from "./AgentCreatePicker";
import { ThemePicker } from "../theme/ThemePicker";
import { useUiPrefsStore, type ThemeMode } from "../../store/ui-prefs";
import { useToastStore } from "../../store/toast";
import { useTranslation } from "../../i18n/useTranslation";

interface Props {
	onClose: () => void;
}

const TOTAL_STEPS = 3;

/** 初始化向导：第 1 步选主题（必选）→ 第 2 步配置模型（不强制）→ 第 3 步设置默认智能体（可跳过） */
export function OnboardingWizard({ onClose }: Props) {
	const { t } = useTranslation();
	const [step, setStep] = useState<1 | 2 | 3>(1);
	// 用户主动选中的主题，null = 还没选（第 1 步「下一步」据此禁用）
	const [pickedTheme, setPickedTheme] = useState<ThemeMode | null>(null);

	// 第 3 步创建成功即视为完成：设为默认智能体并关闭（「跳过」是另一出口）
	const handleCreated = (displayName: string) => {
		useUiPrefsStore.getState().setDefaultAgent(displayName);
		useToastStore
			.getState()
			.add(t("onboardingWizard.agentCreated", { name: displayName }), "success");
		onClose();
	};

	// 第 1 步「下一步」：选中的主题落库后前进
	const confirmThemeAndNext = () => {
		if (!pickedTheme) return;
		useUiPrefsStore.getState().setThemeMode(pickedTheme);
		setStep(2);
	};

	return (
		<Modal onClose={onClose} width={720} data-testid="onboarding-wizard">
			<div className="border-b border-hairline p-4">
				<div className="flex items-center justify-between">
					<div className="text-sm font-medium text-primary">
						{t("onboardingWizard.title")}
					</div>
					<button
						onClick={onClose}
						className="text-tertiary text-xs"
						data-testid="onboarding-wizard-close"
						aria-label={t("common.close")}
					>
						✕
					</button>
				</div>
				{/* 步骤条 */}
				<div
					className="mt-2 flex items-center gap-2"
					data-testid="wizard-step-indicator"
				>
					{Array.from({ length: TOTAL_STEPS }, (_, i) => (
						<div
							key={i}
							className={`h-1 w-10 rounded ${step >= i + 1 ? "bg-accent" : "bg-fill-muted"}`}
						/>
					))}
					<span className="ml-1 text-xs text-tertiary">
						{t("onboardingWizard.stepIndicator", { step, total: TOTAL_STEPS })}
					</span>
				</div>
			</div>

			<div className="max-h-[70vh] overflow-auto p-4">
				{step === 1 && (
					<div data-testid="wizard-step-1" className="flex flex-col gap-3">
						<div className="text-xs text-tertiary">
							{t("onboardingWizard.step1Desc")}
						</div>
						<ThemePicker
							onConfirm={() => {}}
							onSelect={setPickedTheme}
						/>
					</div>
				)}
				{step === 2 && (
					<div data-testid="wizard-step-2" className="flex flex-col gap-3">
						<div className="text-xs text-tertiary">
							{t("onboardingWizard.step2Desc")}
						</div>
						{/* ProviderForm 不传 onCancel：向导场景不渲染取消按钮 */}
						<ProviderForm
							onSaved={() => {
								useToastStore
									.getState()
									.add(t("onboardingWizard.providerSaved"), "success");
								// 保存成功即自动前进：这一步的唯一动作就是配好模型，
								// 再让用户点一次「下一步」是多余的一步
								setStep(3);
							}}
						/>
					</div>
				)}
				{step === 3 && (
					<div data-testid="wizard-step-3" className="flex flex-col gap-3">
						<div className="text-xs text-tertiary">
							{t("onboardingWizard.step3Desc")}
						</div>
						<AgentCreatePicker autoFocusTab="preset" onCreated={handleCreated} />
					</div>
				)}
			</div>

			<div className="flex justify-between border-t border-hairline p-3">
				<div>
					{step > 1 && (
						<button
							data-testid="wizard-back"
							onClick={() => setStep((s) => (s - 1) as 1 | 2 | 3)}
							className="rounded-md bg-surface-elevated px-3 py-1.5 text-sm text-secondary"
						>
							{t("onboardingWizard.back")}
						</button>
					)}
				</div>
				<div>
					{step === 1 && (
						<button
							data-testid="wizard-next"
							onClick={confirmThemeAndNext}
							disabled={!pickedTheme}
							className="rounded-md bg-accent px-3 py-1.5 text-sm text-[var(--on-accent)] disabled:cursor-not-allowed disabled:opacity-50"
						>
							{t("onboardingWizard.next")}
						</button>
					)}
					{step === 2 && (
						<button
							data-testid="wizard-next"
							onClick={() => setStep(3)}
							className="rounded-md bg-accent px-3 py-1.5 text-sm text-[var(--on-accent)]"
						>
							{t("onboardingWizard.next")}
						</button>
					)}
					{step === 3 && (
						<button
							data-testid="wizard-skip"
							onClick={onClose}
							className="rounded-md bg-surface-elevated px-3 py-1.5 text-sm text-secondary"
						>
							{t("onboardingWizard.skip")}
						</button>
					)}
				</div>
			</div>
		</Modal>
	);
}
