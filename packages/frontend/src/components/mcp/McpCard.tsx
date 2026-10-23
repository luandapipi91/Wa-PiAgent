import { useState } from "react";
import { useTranslation } from "../../i18n/useTranslation";
import type { McpLoginState, McpServerEntry } from "../../store/mcp";
import { copyToClipboard } from "../../util/clipboard";
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
  /**
   * 是否已登录（kernel 读 mcp-auth.json 得来，F19）。
   * 缺省 = 未知（非 HTTP server / 旧回包）：那时既不显示「登录」也不显示「登出」
   * ——登录态是事实，不能靠猜。
   */
  signedIn?: boolean;
  /** 本次会话内的登录流程状态（等待授权 / 授权 URL / 失败文案） */
  loginState?: McpLoginState;
  onTest: () => void;
  onViewTools: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** 发起登录；timeoutSec 缺省 = 交给 kernel 用自己的缺省值 */
  onLogin: (timeoutSec?: number) => void;
  onLogout: () => void;
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

/** 登录等待秒数的输入框初值（秒级；与 kernel 的 DEFAULT_LOGIN_TIMEOUT_SEC 一致） */
const DEFAULT_TIMEOUT_SEC = "300";

/**
 * 登录等待秒数的上限（秒，与 kernel 的 MAX_LOGIN_TIMEOUT_SEC 一致）。
 *
 * 超大值的毫秒数会溢出 32 位整数、被运行时截断成 1ms（= pi 刚起就被杀），所以输入框给 max，
 * 提交前再 clamp 一次（max 只是原生提示，手打字/粘贴可以绕过）。
 */
const MAX_TIMEOUT_SEC = 3600;

export function McpCard({
  config,
  state,
  toolCount,
  testing,
  error,
  signedIn,
  loginState,
  onTest,
  onViewTools,
  onEdit,
  onDelete,
  onLogin,
  onLogout,
}: Props) {
  const { t } = useTranslation();
  const [timeoutSec, setTimeoutSec] = useState(DEFAULT_TIMEOUT_SEC);
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

  // 登录 / 登出只对 HTTP server 出现：stdio 没有 OAuth（pi 直接报 does not use OAuth），
  // 给按钮等于提供一个必然失败的入口。signedIn 未知（undefined）时两边都不显示。
  const isHttp = !!config.url;
  const canLogin = isHttp && signedIn === false;
  const canLogout = isHttp && signedIn === true;
  const loginPending = loginState?.pending === true;

  const handleLogin = () => {
    // 输入框被清空 / 写成非正数时不编值：交给 kernel 用它自己的缺省上限；
    // 超过上限就按上限来（否则 REST 会 400，用户只会看到一个「参数非法」）
    const n = Number(timeoutSec);
    if (!Number.isFinite(n) || n <= 0) return onLogin(undefined);
    onLogin(Math.min(Math.floor(n), MAX_TIMEOUT_SEC));
  };

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

      {/* 需登录：提示待办 */}
      {!testing && state === "needs-auth" && (
        <p
          className="text-[calc(11px*var(--font-scale))] mb-2 px-2 py-1 rounded"
          style={{ color: "var(--warning)", background: "var(--warning-soft)" }}
          data-testid={`mcp-needs-auth-${config.name}`}
        >
          {t("mcpCard.needsAuthHint")}
        </p>
      )}

      {/* 登录流程：等待授权 / 授权 URL / 失败。
          URL 只展示 + 可复制，**不自动打开**：pi 自己会打开一次系统浏览器且无法抑制
          （规格 §11），前端再自动打开必然是两个标签页。 */}
      {isHttp && loginState && (loginState.pending || loginState.error) && (
        <div
          className="mb-2 px-2 py-1 rounded text-[calc(11px*var(--font-scale))]"
          style={
            loginState.error
              ? { color: "var(--danger)", background: "var(--danger-soft)" }
              : { color: "var(--text-secondary)", background: "var(--accent-soft)" }
          }
          data-testid={`mcp-login-state-${config.name}`}
        >
          {loginState.error ? (
            <p
              className="whitespace-pre-wrap break-all m-0"
              data-testid={`mcp-login-error-${config.name}`}
            >
              {loginState.error}
            </p>
          ) : (
            <>
              <p
                className="m-0"
                data-testid={`mcp-login-waiting-${config.name}`}
              >
                ⏳ {t("mcpCard.loginWaiting")}
              </p>
              {loginState.progress && (
                <p
                  className="m-0 mt-1 opacity-80 break-all"
                  data-testid={`mcp-login-progress-${config.name}`}
                >
                  {loginState.progress}
                </p>
              )}
              {loginState.url && (
                <div className="mt-1">
                  <span className="opacity-80">{t("mcpCard.loginUrlHint")}</span>
                  <p
                    className="m-0 break-all select-all"
                    style={{ color: "var(--accent)" }}
                    data-testid={`mcp-login-url-${config.name}`}
                  >
                    {loginState.url}
                  </p>
                  <CardBtn
                    onClick={() => void copyToClipboard(loginState.url!)}
                    testId={`mcp-login-copy-${config.name}`}
                    label={t("mcpCard.loginCopyLink")}
                    accent
                  />
                </div>
              )}
            </>
          )}
        </div>
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
      <div className="flex gap-1.5 flex-wrap items-center">
        {canLogin && (
          <input
            type="number"
            min={1}
            max={MAX_TIMEOUT_SEC}
            className="w-14 text-[calc(11px*var(--font-scale))] px-1.5 py-1 rounded-md"
            style={{
              background: "var(--canvas)",
              border: "1px solid var(--hairline)",
              color: "var(--text-primary)",
            }}
            value={timeoutSec}
            onChange={(e) => setTimeoutSec(e.target.value)}
            disabled={loginPending}
            title={t("mcpCard.loginTimeoutHint")}
            aria-label={t("mcpCard.loginTimeoutHint")}
            data-testid={`mcp-login-timeout-${config.name}`}
          />
        )}
        {canLogin && (
          <CardBtn
            onClick={handleLogin}
            testId={`mcp-login-${config.name}`}
            label={t("mcpCard.loginButton")}
            accent
            disabled={loginPending}
          />
        )}
        {canLogout && (
          <CardBtn
            onClick={onLogout}
            testId={`mcp-logout-${config.name}`}
            label={t("mcpCard.logoutButton")}
            disabled={testing}
          />
        )}
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
