// KbProgress — 索引进度区（任务 B4）：阶段文案 + 百分比 + 进度条 + 取消按钮。
//
// 仅 status=indexing/scanning 时渲染（ready/error 返回 null，进度区随终态消失，
// 由 store applyProgress 的终态帧清除驱动——SSE 为主、断连 refetch 兜底）。
// 样式：项目无现成进度条组件，用简单 div 宽度百分比 + 语义色 --info
// （与 KbCard「索引中」徽章同色板：--info 固定蓝，区别于主题色 --accent 的就绪绿系）。
import type { KbInfo } from "@wa-pi/shared";
import { useTranslation } from "../../i18n/useTranslation";

interface Props {
  kb: KbInfo;
  /** 取消进行中的索引（入参 kb.id）；未传则不渲染取消按钮 */
  onCancel?: (id: string) => void;
}

/** phase → i18n 键（与 KbProgressEvent 的五阶段对齐，规格 §6.1） */
const PHASE_KEYS: Record<NonNullable<KbInfo["progress"]>["phase"], string> = {
  scanning: "kb.phaseScanning",
  extracting: "kb.phaseExtracting",
  chunking: "kb.phaseChunking",
  embedding: "kb.phaseEmbedding",
  committing: "kb.phaseCommitting",
};

export function KbProgress({ kb, onCancel }: Props) {
  const { t } = useTranslation();
  if (kb.status !== "indexing" && kb.status !== "scanning") return null;
  const p = kb.progress;
  // filesTotal=0 时百分比无意义（0/0 → NaN），只渲染阶段文案不渲染进度条（照 KbCard 退化逻辑）
  const percent =
    p && p.filesTotal > 0
      ? Math.round((p.filesDone / p.filesTotal) * 100)
      : null;
  return (
    <div className="mt-1.5" data-testid={`kb-progress-${kb.id}`}>
      {/* 行 1：阶段文案 + 百分比 + 取消按钮 */}
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[calc(11px*var(--font-scale))] text-secondary">
          {p ? t(PHASE_KEYS[p.phase]) : t("kb.statusIndexing")}
        </span>
        {percent !== null && (
          <span
            className="text-[calc(11px*var(--font-scale))] font-semibold"
            style={{ color: "var(--info)" }}
          >
            {percent}%
          </span>
        )}
        <span className="flex-1" />
        {onCancel && (
          <button
            type="button"
            data-testid="kb-cancel"
            onClick={() => onCancel(kb.id)}
            className="text-[calc(10.5px*var(--font-scale))] font-medium px-2 py-0.5 rounded-md"
            style={{
              background: "transparent",
              border: "1px solid var(--hairline)",
              color: "var(--text-secondary)",
              cursor: "pointer",
            }}
          >
            {t("kb.cancelIndex")}
          </button>
        )}
      </div>
      {/* 进度条：外层轨道 + 内层宽度百分比 */}
      {percent !== null && (
        <div
          className="h-1 rounded-full overflow-hidden"
          style={{ background: "var(--hairline)" }}
        >
          <div
            className="h-full rounded-full"
            style={{
              width: `${percent}%`,
              background: "var(--info)",
              transition: "width 0.3s",
            }}
          />
        </div>
      )}
    </div>
  );
}
