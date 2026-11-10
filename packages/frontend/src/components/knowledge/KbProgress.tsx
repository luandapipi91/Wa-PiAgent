// KbProgress — 索引进度区：统一文案 + 整体百分比 + 进度条 + 取消按钮。
//
// 仅 status=indexing/scanning 时渲染（ready/error 返回 null，进度区随终态消失，
// 由 store applyProgress 的终态帧清除驱动——SSE 为主、断连 refetch 兜底）。
// 文案不再按阶段切换（「生成向量中…」这类阶段名对用户无意义，且文件解析完进嵌入时
// 会从 100% 倒退）；统一显示「知识库生成中…」。
// 百分比口径（一条连续推进的进度条）：
//   scanning/extracting/chunking → 文件解析占前 50%（filesDone/filesTotal）
//   embedding/committing → 块嵌入占后 50%（chunksDone/chunksTotal）
// 块总量未知（旧快照未带）时停在 50%，绝不拿文件口径冒充 100%。
import type { KbInfo } from "@wa-pi/shared";
import { useTranslation } from "../../i18n/useTranslation";

interface Props {
  kb: KbInfo;
  /** 取消进行中的索引（入参 kb.id）；未传则不渲染取消按钮 */
  onCancel?: (id: string) => void;
}

type KbProgressInfo = NonNullable<KbInfo["progress"]>;

/** 整体索引进度百分比（0-100）：文件解析段 + 向量生成段合并成一条进度条 */
export function kbIndexPercent(p: KbProgressInfo): number {
  if (p.phase === "embedding" || p.phase === "committing") {
    const total = p.chunksTotal ?? 0;
    if (total > 0) {
      return 50 + Math.round((Math.min(p.chunksDone, total) / total) * 50);
    }
    return 50;
  }
  if (p.filesTotal > 0) {
    return Math.round((Math.min(p.filesDone, p.filesTotal) / p.filesTotal) * 50);
  }
  return 0;
}

export function KbProgress({ kb, onCancel }: Props) {
  const { t } = useTranslation();
  if (kb.status !== "indexing" && kb.status !== "scanning") return null;
  const p = kb.progress;
  const percent = p ? kbIndexPercent(p) : 0;
  return (
    <div className="mt-1.5" data-testid={`kb-progress-${kb.id}`}>
      {/* 行 1：统一文案 + 百分比 + 取消按钮 */}
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[calc(11px*var(--font-scale))] text-secondary">
          {t("kb.generating")}
        </span>
        <span
          className="text-[calc(11px*var(--font-scale))] font-semibold"
          style={{ color: "var(--info)" }}
        >
          {percent}%
        </span>
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
    </div>
  );
}
