// KbCard — 知识库单行卡片（任务 B2，样式对齐 McpCard）
//
// 布局：头行（名称 + 状态徽章 + 自动更新开关）→ 描述（单行截断）→
// 元信息行（文件夹路径 · 规模 · 上次索引）→ 操作行（更新/重建/删除）。
// 状态徽章文案（规格 §6.8，简报逐字定稿）：
//   进行中（scanning/indexing）→ 不渲染徽章：进度区已显示「知识库生成中… + 百分比」，
//     再叠一个「索引中 x%」既重复又容易和进度区的百分比口径打架
//   failedCount>0 → 「失败 N 文件」（橙，可点击 → onShowFailed，B4 接失败弹窗）
//   error → 「索引中断」（橙红）
//   其余 → 「就绪」（绿）
// 索引进行中时「编辑/重建」置灰：kernel 对进行中的库直接拒绝重建（400），按钮可点等于没反应。
import type { KbInfo } from "@wa-pi/shared";
import { useTranslation } from "../../i18n/useTranslation";
import { KbProgress } from "./KbProgress";

interface Props {
  kb: KbInfo;
  /** 更新（名称/描述表单，B3 接入）；未传则不渲染按钮 */
  onEdit?: () => void;
  /** 重建索引；未传则不渲染按钮 */
  onReindex?: () => void;
  onDelete: () => void;
  /** 自动更新开关切换（入参为切换后的目标值） */
  onToggleWatch: (on: boolean) => void;
  /** 失败文件徽章点击（B4 接失败清单弹窗前的占位回调） */
  onShowFailed?: () => void;
  /** 取消进行中的索引（indexing/scanning 时随进度区展示取消按钮；首次索引不展示） */
  onCancel?: () => void;
  /** 打开「关联智能体」弹窗（知识库侧管理绑定） */
  /** 打开「关联智能体」弹窗（知识库侧管理绑定）；索引生成中按钮置灰 */
  onManageAgents?: (kb: KbInfo) => void;
}

/** 徽章呈现：label + 语义色（色板对齐 McpCard 的 success/accent/warning/danger） */
function statusBadge(
  kb: KbInfo,
  t: (k: string, o?: Record<string, unknown>) => string,
): { label: string; color: string; clickable: boolean } | null {
  // 进行中不渲染徽章：进度区统一显示「知识库生成中… + 百分比」
  if (kb.status === "indexing" || kb.status === "scanning") return null;
  // 失败文件数独立于 status：ready 库最近一轮也可能有部分文件失败（规格 §6.8「点开 failed_count」）
  if (kb.failedCount > 0) {
    return {
      label: t("kb.statusFailedFiles", { count: kb.failedCount }),
      color: "var(--warning)",
      clickable: true,
    };
  }
  if (kb.status === "error") {
    return { label: t("kb.statusInterrupted"), color: "var(--danger)", clickable: false };
  }
  return { label: t("kb.statusReady"), color: "var(--success)", clickable: false };
}

export function KbCard({
  kb,
  onEdit,
  onReindex,
  onDelete,
  onToggleWatch,
  onShowFailed,
  onCancel,
  onManageAgents,
}: Props) {
  const { t } = useTranslation();
  const badge = statusBadge(kb, t);
  // 索引进行中：编辑/重建不可用（kernel 会拒绝，按钮可点等于没反应）
  const busy = kb.status === "indexing" || kb.status === "scanning";
  // 可点击徽章（failedCount>0）渲染为 button：原生可聚焦/可回车触发，供 B4 接失败清单弹窗
  const badgeNode = !badge ? null : badge.clickable ? (
    <button
      type="button"
      className="text-[calc(10px*var(--font-scale))] px-1.5 py-0.5 rounded-full font-medium"
      style={{ background: badge.color + "20", color: badge.color }}
      data-testid={`kb-status-${kb.id}`}
      title={t("kb.statusFailedHint", { count: kb.failedCount })}
      onClick={onShowFailed}
    >
      {badge.label}
    </button>
  ) : (
    <span
      className="text-[calc(10px*var(--font-scale))] px-1.5 py-0.5 rounded-full font-medium"
      style={{ background: badge.color + "20", color: badge.color }}
      data-testid={`kb-status-${kb.id}`}
      // 索引中断时把失败原因挂出来（此前只有四个字，用户无从判断）
      title={kb.status === "error" ? (kb.lastError ?? undefined) : undefined}
      aria-label={
        kb.status === "error" && kb.lastError
          ? `${badge.label}：${kb.lastError}`
          : undefined
      }
    >
      {badge.label}
    </span>
  );

  return (
    <div
      className="mb-2.5 p-3.5"
      style={{
        background: "var(--surface)",
        border: "1px solid var(--hairline)",
        borderRadius: 14,
      }}
      data-testid={`kb-card-${kb.id}`}
    >
      {/* 头部：名称 + 状态徽章 + 自动更新开关 */}
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[calc(13px*var(--font-scale))] font-semibold text-primary">
          ● {kb.name}
        </span>
        {badgeNode}
        <span className="flex-1" />
        <AutoWatchSwitch
          on={kb.autoWatch}
          label={t("kb.autoWatch")}
          hint={t("kb.autoWatchHint")}
          testId={`kb-watch-toggle-${kb.id}`}
          onToggle={() => onToggleWatch(!kb.autoWatch)}
        />
      </div>

      {/* 索引进度区（任务 B4：仅 indexing/scanning 渲染，ready/error 内部返回 null） */}
      {/* 取消入口只给「已索引过」的库（重建/自动更新场景）：首次创建的库还在建库首次索引，
          此时库里没有任何可回退的内容，摆一个取消按钮只是让人误点掉刚发起的建库 */}
      <KbProgress
        kb={kb}
        onCancel={onCancel && kb.lastIndexedAt != null ? () => onCancel() : undefined}
      />

      {/* 描述行（单行截断） */}
      {kb.description && (
        <p className="text-[calc(11.5px*var(--font-scale))] text-secondary mb-2 opacity-70 truncate m-0">
          {kb.description}
        </p>
      )}

      {/* 元信息行：文件夹路径 · 规模 · 上次索引 */}
      <div className="flex items-center gap-2 text-[calc(11px*var(--font-scale))] text-tertiary mb-2 flex-wrap">
        <span className="truncate" title={kb.folderPath} data-testid={`kb-folder-${kb.id}`}>
          📁 {kb.folderPath}
        </span>
        <span>·</span>
        <span>
          {t("kb.fileCount", { count: kb.fileCount })} ·{" "}
          {t("kb.chunkCount", { count: kb.chunkCount })}
        </span>
        <span>·</span>
        <span data-testid={`kb-last-indexed-${kb.id}`}>
          {kb.lastIndexedAt
            ? t("kb.lastIndexedAt", {
                time: new Date(kb.lastIndexedAt).toLocaleString(),
              })
            : t("kb.neverIndexed")}
        </span>
      </div>

      {/* 操作行：更新/重建/删除 */}
      <div className="flex gap-1.5 flex-wrap items-center">
        {onEdit && (
          <CardBtn
            onClick={onEdit}
            testId={`kb-edit-${kb.id}`}
            label={t("kb.editButton")}
            disabled={busy}
          />
        )}
        {onReindex && (
          <CardBtn
            onClick={onReindex}
            testId={`kb-reindex-${kb.id}`}
            label={t("kb.reindexButton")}
            disabled={busy}
          />
        )}
        {onManageAgents && (
          // 索引生成中置灰（与编辑/重建一致：库未就绪时不开放操作）
          <CardBtn
            onClick={() => onManageAgents(kb)}
            testId={`kb-agents-${kb.id}`}
            label={t("kb.agentsButton")}
            disabled={busy}
          />
        )}
        <CardBtn
          onClick={onDelete}
          testId={`kb-delete-${kb.id}`}
          label={t("kb.deleteButton")}
          // 索引进行中 kernel 会拒绝删除（400），禁用并挂原因，避免用户走完确认框才失败
          disabled={busy}
          title={busy ? t("kb.deleteBusyHint") : undefined}
          danger
        />
      </div>
    </div>
  );
}

/** 自动更新开关（样式对齐 McpPage 的 ProjectScopeToggle 滑块开关） */
function AutoWatchSwitch({
  on,
  label,
  hint,
  testId,
  onToggle,
}: {
  on: boolean;
  label: string;
  hint: string;
  testId: string;
  onToggle: () => void;
}) {
  return (
    <span className="flex items-center gap-2 shrink-0">
      <span className="text-[calc(11px*var(--font-scale))] text-tertiary whitespace-nowrap">
        {label}
      </span>
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={on}
        title={hint}
        data-testid={testId}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        className="relative shrink-0"
        style={{
          width: 34,
          height: 20,
          borderRadius: 9999,
          background: on ? "var(--brand)" : "var(--hairline-strong)",
          transition: "background 0.2s",
          border: "none",
          padding: 0,
          cursor: "pointer",
        }}
      >
        <span
          className="absolute rounded-full bg-white transition-all"
          style={{
            width: 16,
            height: 16,
            top: 2,
            left: on ? undefined : 2,
            right: on ? 2 : undefined,
            boxShadow: "0 1px 2px rgba(0,0,0,.1)",
          }}
        />
      </button>
    </span>
  );
}

/** 卡片操作按钮（对齐 McpCard 的 CardBtn 样式） */
function CardBtn({
  onClick,
  testId,
  label,
  danger,
  disabled,
  title,
}: {
  onClick: () => void;
  testId: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  /** 悬停提示（禁用时说明原因） */
  title?: string;
}) {
  const color = danger ? "var(--danger)" : "var(--text-secondary)";
  const borderColor = danger ? "var(--danger)" : "var(--hairline)";
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      disabled={disabled}
      title={title}
      className="text-[calc(11px*var(--font-scale))] px-2.5 py-1 rounded-md"
      style={{
        color,
        border: `1px solid ${borderColor}`,
        background: "transparent",
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {label}
    </button>
  );
}
