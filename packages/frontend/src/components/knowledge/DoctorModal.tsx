// 知识库体检弹窗：健康分（100 分制）+ 问题清单（按严重度着色）+ 重新诊断。
import { useEffect } from "react";
import { Modal } from "../ui/Modal";
import { useTranslation } from "../../i18n/useTranslation";
import { useKnowledgeStore } from "../../store/knowledge";

interface Props {
  onClose: () => void;
}

const SEVERITY_COLOR: Record<string, string> = {
  blocking: "var(--danger)",
  warning: "var(--warning)",
  info: "var(--text-tertiary)",
};

export function DoctorModal({ onClose }: Props) {
  const { t } = useTranslation();
  const doctor = useKnowledgeStore((s) => s.doctor);
  const doctorLoading = useKnowledgeStore((s) => s.doctorLoading);
  const doctorUpdatedAt = useKnowledgeStore((s) => s.doctorUpdatedAt);
  const loadDoctor = useKnowledgeStore((s) => s.loadDoctor);

  useEffect(() => {
    void loadDoctor();
  }, [loadDoctor]);

  return (
    <Modal onClose={onClose} width={520} data-testid="kb-doctor-modal">
      <div
        className="px-4 py-3 flex items-center justify-between"
        style={{ borderBottom: "1px solid var(--hairline)" }}
      >
        <span className="text-primary font-bold text-sm">{t("kb.doctorTitle")}</span>
        <span className="flex items-center gap-1.5">
          <button
            onClick={() => void loadDoctor()}
            disabled={doctorLoading}
            className="text-[calc(11px*var(--font-scale))] px-2 py-1 rounded-md"
            style={{
              border: "1px solid var(--hairline)",
              color: "var(--text-secondary)",
              cursor: doctorLoading ? "default" : "pointer",
              opacity: doctorLoading ? 0.6 : 1,
            }}
            data-testid="kb-doctor-rerun"
          >
            {doctorLoading ? t("kb.doctorRunning") : t("kb.doctorRerun")}
          </button>
          {/* 标题栏关闭按钮：可预期的退出路径，不依赖猜「点遮罩能关」 */}
          <button
            onClick={onClose}
            aria-label={t("common.close")}
            title={t("common.close")}
            className="w-6 h-6 flex items-center justify-center rounded-md text-secondary hover:text-primary"
            style={{ border: "none", background: "transparent", cursor: "pointer" }}
            data-testid="kb-doctor-close"
          >
            ✕
          </button>
        </span>
      </div>
      <div
        className="p-4 overflow-y-auto"
        style={{ maxHeight: "60vh", opacity: doctorLoading ? 0.6 : 1, transition: "opacity 0.15s" }}
        data-testid="kb-doctor-content"
      >
        <div className="flex items-baseline gap-2 mb-3">
          <span
            className="text-[calc(28px*var(--font-scale))] font-extrabold"
            style={{ color: "var(--accent)" }}
            data-testid="kb-doctor-score"
          >
            {doctor ? String(doctor.health_score) : "…"}
          </span>
          <span className="text-tertiary text-[calc(11px*var(--font-scale))]">
            {doctor?.summary ?? ""}
          </span>
          {/* 更新时间：每轮诊断都会刷新，让「重新诊断」有可见结果 */}
          {doctorUpdatedAt && !doctorLoading && (
            <span
              className="text-tertiary text-[calc(10px*var(--font-scale))] ml-auto"
              data-testid="kb-doctor-updated"
            >
              {t("kb.doctorUpdatedAt", {
                time: new Date(doctorUpdatedAt).toLocaleTimeString(undefined, { hour12: false }),
              })}
            </span>
          )}
        </div>
        {(doctor?.issues ?? []).length === 0 ? (
          <div className="text-tertiary text-[calc(12px*var(--font-scale))] py-4 text-center">
            {t("kb.doctorHealthy")}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {(doctor?.issues ?? []).map((issue, i) => (
              <div
                key={`${issue.severity}-${i}`}
                className="px-2.5 py-2 rounded-md text-[calc(11.5px*var(--font-scale))]"
                style={{
                  background: "var(--canvas)",
                  border: "1px solid var(--hairline)",
                  borderLeft: `3px solid ${SEVERITY_COLOR[issue.severity] ?? "var(--hairline)"}`,
                }}
                data-testid={`kb-doctor-issue-${i}`}
              >
                <div className="text-primary">
                  {issue.kbName ? `「${issue.kbName}」` : ""}
                  {issue.message}
                </div>
                <div className="text-tertiary mt-0.5">{issue.action}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
