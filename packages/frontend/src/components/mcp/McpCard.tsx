import { useTranslation } from "../../i18n/useTranslation";
import type { McpServerEntry } from "../../store/mcp";
import { exposureDescKey, exposureLabelKey } from "./exposure";

interface Props {
  config: McpServerEntry;
  /**
   * 生效状态：pi 报的**原始** state 串（connected / failed / needs-auth / disabled / …）。
   * 缺省 = 状态未知（pi 没报过、或清单 stale）。
   */
  state?: string;
  /** 工具数（已连上时展示「已连接 · N 工具」） */
  toolCount?: number;
  testing?: boolean;
  error?: string;
  onTest: () => void;
  onViewTools: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

interface Badge {
  icon: string;
  labelKey: string;
  color: string;
  /** 语义色调：供 UI/测试区分「错误」与「中性」（disabled 必须是 neutral） */
  tone: "success" | "error" | "warning" | "neutral";
}

/**
 * pi 原始 state → 徽标。
 *
 * 关键语义（规格 §7）：
 *   - `disabled` 是「用户主动停用」，不能用错误样式（也不是「未连接」）
 *   - `needs-auth` 是「需要登录」，提示而已（登录入口归任务 10）
 *   - 未知 / 缺省（含 stale 清单）显示「状态未知」，不硬套一个连接态
 */
const STATE_BADGES: Record<string, Badge> = {
  connected: {
    icon: "🟢",
    labelKey: "mcpCard.connected",
    color: "var(--success)",
    tone: "success",
  },
  failed: {
    icon: "🔴",
    labelKey: "mcpCard.failed",
    color: "var(--danger)",
    tone: "error",
  },
  "needs-auth": {
    icon: "🟡",
    labelKey: "mcpCard.needsAuth",
    color: "var(--warning)",
    tone: "warning",
  },
  disabled: {
    icon: "⚪",
    labelKey: "mcpCard.disabled",
    color: "var(--text-tertiary)",
    tone: "neutral",
  },
};

const UNKNOWN_BADGE: Badge = {
  icon: "⚪",
  labelKey: "mcpCard.unknown",
  color: "var(--text-tertiary)",
  tone: "neutral",
};

/** 状态串 → 徽标（未知串一律「状态未知」） */
export function stateBadge(state?: string): Badge {
  if (!state) return UNKNOWN_BADGE;
  return STATE_BADGES[state] ?? UNKNOWN_BADGE;
}

/** 生成服务器配置的描述文本 */
function configSummary(config: McpServerEntry, emptyLabel: string): string {
  if (config.command) {
    const args = config.args?.join(" ") ?? "";
    return [config.command, args].filter(Boolean).join(" ");
  }
  if (config.url) return config.url;
  return emptyLabel;
}

export function McpCard({
  config,
  state,
  toolCount,
  testing,
  error,
  onTest,
  onViewTools,
  onEdit,
  onDelete,
}: Props) {
  const { t } = useTranslation();
  const badge = stateBadge(state);
  const st = testing
    ? {
        icon: "⏳",
        color: "var(--accent)",
        tone: "warning" as const,
        label: t("mcpCard.testing"),
      }
    : { ...badge, label: t(badge.labelKey) };

  const label =
    !testing && state === "connected" && toolCount != null
      ? t("mcpCard.connectedWithTools", { count: toolCount })
      : st.label;

  return (
    <div
      className="mb-2.5 p-3.5"
      style={{
        background: "var(--surface)",
        border: "1px solid var(--hairline)",
        borderRadius: 14,
      }}
      data-testid={`mcp-card-${config.name}`}
    >
      {/* 头部：名称 + 状态 */}
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[calc(13px*var(--font-scale))] font-semibold text-primary">
          ● {config.name}
        </span>
        <span
          className="text-[calc(10px*var(--font-scale))] px-1.5 py-0.5 rounded-full font-medium"
          style={{ background: st.color + "20", color: st.color }}
          data-testid={`mcp-state-${config.name}`}
          data-tone={st.tone}
          data-state={state}
          title={state}
        >
          {st.icon} {label}
        </span>
        {config.exposure && (
          <span
            className="text-[calc(10px*var(--font-scale))] px-1.5 py-0.5 rounded-full"
            style={{ background: "var(--hairline)", color: "var(--text-tertiary)" }}
            data-testid={`mcp-exposure-${config.name}`}
            title={t(exposureDescKey(config.exposure))}
          >
            {t(exposureLabelKey(config.exposure))}
          </span>
        )}
      </div>

      {/* 描述行 */}
      <p className="text-[calc(11.5px*var(--font-scale))] text-secondary mb-2 opacity-70 truncate">
        {configSummary(config, t("mcpCard.summaryEmpty"))}
      </p>

      {/* 需登录：提示待办（登录/登出入口归任务 10） */}
      {!testing && state === "needs-auth" && (
        <p
          className="text-[calc(11px*var(--font-scale))] mb-2 px-2 py-1 rounded"
          style={{ color: "var(--warning)", background: "var(--warning-soft)" }}
          data-testid={`mcp-needs-auth-${config.name}`}
        >
          {t("mcpCard.needsAuthHint")}
        </p>
      )}

      {/* 错误信息：折叠展示（长错误不撑开卡片）；danger 样式已承担错误信号，文本不加 ⚠ 前缀 */}
      {error && !testing && (
        <details
          className="mb-2 px-2 py-1 rounded"
          style={{ color: "var(--danger)", background: "var(--danger-soft)" }}
          data-testid={`mcp-error-${config.name}`}
        >
          <summary className="text-[calc(11px*var(--font-scale))] cursor-pointer">
            {t("mcpCard.errorDetail")}
          </summary>
          <p
            className="text-[calc(11px*var(--font-scale))] whitespace-pre-wrap break-all"
            data-testid={`mcp-error-body-${config.name}`}
          >
            {error}
          </p>
        </details>
      )}

      {/* 操作按钮 */}
      <div className="flex gap-1.5 flex-wrap">
        <CardBtn
          onClick={onTest}
          testId={`mcp-test-${config.name}`}
          label={testing ? t("mcpCard.testing") : t("mcpCard.testButton")}
          disabled={testing}
        />
        <CardBtn
          onClick={onViewTools}
          testId={`mcp-tools-${config.name}`}
          label={t("mcpCard.viewToolsButton")}
          disabled={testing}
        />
        <CardBtn
          onClick={onEdit}
          testId={`mcp-edit-${config.name}`}
          label={t("mcpCard.editButton")}
          disabled={testing}
        />
        <CardBtn
          onClick={onDelete}
          testId={`mcp-delete-${config.name}`}
          label={t("mcpCard.deleteButton")}
          danger
          disabled={testing}
        />
      </div>
    </div>
  );
}

function CardBtn({
  onClick,
  testId,
  label,
  accent,
  danger,
  disabled,
}: {
  onClick: () => void;
  testId: string;
  label: string;
  accent?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  const color = danger
    ? "var(--danger)"
    : accent
      ? "var(--accent)"
      : "var(--text-secondary)";
  const borderColor = danger
    ? "var(--danger)"
    : accent
      ? "var(--accent)"
      : "var(--hairline)";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className="text-[calc(11px*var(--font-scale))] px-2.5 py-1 rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
      style={{
        color,
        border: `1px solid ${borderColor}`,
        background: "transparent",
      }}
    >
      {label}
    </button>
  );
}
