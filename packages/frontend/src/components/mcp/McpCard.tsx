import type { McpServerConfig, McpServerStatus } from "@wa-pi/shared";
import { useTranslation } from "../../i18n/useTranslation";

interface Props {
  config: McpServerConfig;
  status: McpServerStatus;
  /** 连接测试成功时返回的工具数（展示「已连接 · N 工具」） */
  toolCount?: number;
  testing?: boolean;
  error?: string;
  onTest: () => void;
  onViewTools: () => void;
  onAuth: () => void;
  onClearAuth: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

const STATUS_CONFIG: Record<McpServerStatus, { icon: string; labelKey: string; color: string }> = {
  connected:    { icon: "🟢", labelKey: "mcpCard.connected", color: "var(--success)" },
  needs_auth:   { icon: "🟡", labelKey: "mcpCard.needsAuth", color: "var(--warning)" },
  error:        { icon: "🔴", labelKey: "mcpCard.error", color: "var(--danger)" },
  disconnected: { icon: "🔴", labelKey: "mcpCard.disconnected", color: "var(--text-tertiary)" },
};

/** 生成服务器配置的描述文本 */
function configSummary(config: McpServerConfig, emptyLabel: string): string {
  if (config.command) {
    const args = config.args?.join(" ") ?? "";
    return [config.command, args].filter(Boolean).join(" ");
  }
  if (config.url) return config.url;
  return emptyLabel;
}

export function McpCard({ config, status, toolCount, testing, error, onTest, onViewTools, onAuth, onClearAuth, onEdit, onDelete }: Props) {
  const { t } = useTranslation();
  const cfg = testing
    ? { icon: "⏳", labelKey: "mcpCard.testing", color: "var(--accent)" }
    : (STATUS_CONFIG[status] ?? STATUS_CONFIG.disconnected);
  const st = { icon: cfg.icon, color: cfg.color, label: t(cfg.labelKey) };

  const label = (!testing && status === "connected" && toolCount != null)
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
        <span className="text-[calc(13px*var(--font-scale))] font-semibold text-primary">● {config.name}</span>
        <span
          className="text-[calc(10px*var(--font-scale))] px-1.5 py-0.5 rounded-full font-medium"
          style={{ background: st.color + "20", color: st.color }}
        >{st.icon} {label}</span>
      </div>

      {/* 描述行 */}
      <p className="text-[calc(11.5px*var(--font-scale))] text-secondary mb-2 opacity-70 truncate">
        {configSummary(config, t("mcpCard.summaryEmpty"))}
      </p>

      {/* 错误信息：danger 样式（红字+红底）已承担错误信号，文本不加 ⚠ 前缀 */}
      {error && !testing && (
        <p className="text-[calc(11px*var(--font-scale))] mb-2 px-2 py-1 rounded" style={{ color: "var(--danger)", background: "var(--danger-soft)" }} data-testid={`mcp-error-${config.name}`}>
          {error}
        </p>
      )}

      {/* 操作按钮 */}
      <div className="flex gap-1.5 flex-wrap">
        <CardBtn
          onClick={onTest}
          testId={`mcp-test-${config.name}`}
          label={testing ? t("mcpCard.testing") : t("mcpCard.testButton")}
          disabled={testing}
        />
        <CardBtn onClick={onViewTools} testId={`mcp-tools-${config.name}`} label={t("mcpCard.viewToolsButton")} disabled={testing} />
        {status === "needs_auth" ? (
          <CardBtn onClick={onAuth} testId={`mcp-auth-${config.name}`} label={t("mcpCard.authButton")} accent disabled={testing} />
        ) : config.auth ? (
          <CardBtn onClick={onClearAuth} testId={`mcp-clearauth-${config.name}`} label={t("mcpCard.clearAuthButton")} disabled={testing} />
        ) : null}
        <CardBtn onClick={onEdit} testId={`mcp-edit-${config.name}`} label={t("mcpCard.editButton")} disabled={testing} />
        <CardBtn onClick={onDelete} testId={`mcp-delete-${config.name}`} label={t("mcpCard.deleteButton")} danger disabled={testing} />
      </div>
    </div>
  );
}

function CardBtn({ onClick, testId, label, accent, danger, disabled }: {
  onClick: () => void;
  testId: string;
  label: string;
  accent?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  const color = danger ? "var(--danger)" : accent ? "var(--accent)" : "var(--text-secondary)";
  const borderColor = danger ? "var(--danger)" : accent ? "var(--accent)" : "var(--hairline)";
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
    >{label}</button>
  );
}
