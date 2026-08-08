import { useState } from "react";
import { Modal } from "../ui/Modal";
import { ProviderForm } from "../settings/ProviderForm";
import { AgentCreatePicker } from "./AgentCreatePicker";
import { useUiPrefsStore } from "../../store/ui-prefs";
import { useToastStore } from "../../store/toast";
import { useTranslation } from "../../i18n/useTranslation";

interface Props {
	onClose: () => void;
}

/** 初始化向导：第 1 步配置模型（不强制）→ 第 2 步设置默认智能体（可跳过） */
export function OnboardingWizard({ onClose }: Props) {
	const { t } = useTranslation();
	const [step, setStep] = useState<1 | 2>(1);

	// 第 2 步创建成功即视为完成：设为默认智能体并关闭（「跳过」是唯一出口按钮）
	const handleCreated = (displayName: string) => {
		useUiPrefsStore.getState().setDefaultAgent(displayName);
		useToastStore.getState().add(t("onboardingWizard.agentCreated", { name: displayName }), "success");
		onClose();
	};

	return (
		<Modal onClose={onClose} width={640} data-testid="onboarding-wizard">
			<div className="border-b border-hairline p-4">
				<div className="text-sm font-medium text-primary">{t("onboardingWizard.title")}</div>
				{/* 步骤条 */}
				<div className="mt-2 flex items-center gap-2">
					<div className={`h-1 w-10 rounded ${step >= 1 ? "bg-accent" : "bg-surface-elevated"}`} />
					<div className={`h-1 w-10 rounded ${step >= 2 ? "bg-accent" : "bg-surface-elevated"}`} />
					<span className="ml-1 text-xs text-tertiary">{t("onboardingWizard.stepIndicator", { step })}</span>
				</div>
			</div>

			<div className="max-h-[70vh] overflow-auto p-4">
				{step === 1 && (
					<div data-testid="wizard-step-1" className="flex flex-col gap-3">
						<div className="text-xs text-tertiary">{t("onboardingWizard.step1Desc")}</div>
						{/* ProviderForm 不传 onCancel：向导场景不渲染取消按钮 */}
						<ProviderForm onSaved={() => useToastStore.getState().add(t("onboardingWizard.providerSaved"), "success")} />
					</div>
				)}
				{step === 2 && (
					<div data-testid="wizard-step-2" className="flex flex-col gap-3">
						<div className="text-xs text-tertiary">{t("onboardingWizard.step2Desc")}</div>
						<AgentCreatePicker autoFocusTab="preset" onCreated={handleCreated} />
					</div>
				)}
			</div>

			<div className="flex justify-between border-t border-hairline p-3">
				<div>
					{step === 2 && (
						<button data-testid="wizard-back" onClick={() => setStep(1)}
							className="rounded-md bg-surface-elevated px-3 py-1.5 text-sm text-secondary">{t("onboardingWizard.back")}</button>
					)}
				</div>
				<div>
					{step === 1 && (
						<button data-testid="wizard-next" onClick={() => setStep(2)}
							className="rounded-md bg-accent px-3 py-1.5 text-sm text-white">{t("onboardingWizard.next")}</button>
					)}
					{step === 2 && (
						<button data-testid="wizard-skip" onClick={onClose}
							className="rounded-md bg-surface-elevated px-3 py-1.5 text-sm text-secondary">{t("onboardingWizard.skip")}</button>
					)}
				</div>
			</div>
		</Modal>
	);
}
