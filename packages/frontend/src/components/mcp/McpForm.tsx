import { useEffect, useState, type ReactNode } from "react";
import type { McpExposure, McpFieldError, McpServerConfig } from "@wa-pi/shared";
import { validateMcpServer } from "@wa-pi/shared";
import { useTranslation } from "../../i18n/useTranslation";
import { formatApiError } from "../../util/kernel-error";
import type { McpSaveResult } from "../../store/mcp";
import {
  DEFAULT_MCP_EXPOSURE,
  MCP_EXPOSURES,
  exposureDescKey,
  exposureLabelKey,
} from "./exposure";

type Transport = "stdio" | "http";

interface Pair {
  key: string;
  value: string;
}

interface ToolExposureRow {
  name: string;
  exposure: McpExposure;
}

interface Props {
  initial?: McpServerConfig;
  /** 保存（调用方负责发 `POST /api/mcp`）：返回 `{ok:false, errors}` 时字段级错误绑到对应输入框 */
  onSave: (
    config: McpServerConfig,
    originalName?: string,
  ) => McpSaveResult | Promise<McpSaveResult | void> | void;
  onCancel: () => void;
}

/** 输入控件通用外观（与既有表单一致：表单底色 + 细边框） */
const INPUT_CLASS =
  "text-[calc(12px*var(--font-scale))] px-2.5 py-1.5 rounded-md";
const INPUT_STYLE = {
  background: "var(--canvas)",
  border: "1px solid var(--hairline)",
  color: "var(--text-primary)",
} as const;
const LABEL_CLASS =
  "text-[calc(11px*var(--font-scale))] font-semibold text-secondary";

/** Record → 可编辑的 key-value 对数组 */
function pairsFrom(record?: Record<string, string>): Pair[] {
  if (!record) return [];
  return Object.entries(record).map(([key, value]) => ({ key, value }));
}

/** key-value 对数组 → Record（跳过空 key） */
function pairsToRecord(pairs: Pair[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    if (p.key.trim()) out[p.key.trim()] = p.value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** toolExposure Record → 行数组 */
function rowsFrom(record?: Record<string, McpExposure>): ToolExposureRow[] {
  if (!record) return [];
  return Object.entries(record).map(([name, exposure]) => ({ name, exposure }));
}

/** 行数组 → toolExposure Record（跳过空工具名） */
function rowsToRecord(
  rows: ToolExposureRow[],
): Record<string, McpExposure> | undefined {
  const out: Record<string, McpExposure> = {};
  for (const r of rows) {
    if (r.name.trim()) out[r.name.trim()] = r.exposure;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 规范化 Authorization 头值：含空格（已有 scheme，如 "Bearer xxx"）原样返回；
 *  仅裸 token 则补 "Bearer " 前缀。 */
function normalizeAuth(raw: string): string {
  const v = raw.trim();
  return v.includes(" ") ? v : `Bearer ${v}`;
}

/** 去掉 Authorization（它有专属输入框，避免两处编辑同一个键） */
function omitAuthorization(
  headers?: Record<string, string>,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const rest = Object.fromEntries(
    Object.entries(headers).filter(([k]) => k !== "Authorization"),
  );
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/** 同步返回还是 Promise（组件测试里的 mock 是同步的） */
function isThenable<T>(value: unknown): value is Promise<T> {
  return (
    !!value && typeof (value as { then?: unknown }).then === "function"
  );
}

/** 表单初始传输类型：无 type 时按 url 推断；streamable-http 归入 HTTP 一侧 */
function initialTransport(initial?: McpServerConfig): Transport {
  if (initial?.type === "stdio") return "stdio";
  if (initial?.type) return "http";
  return initial?.url ? "http" : "stdio";
}

/**
 * 新增/编辑 MCP 服务器表单。
 *
 * 字段集对齐内置 schema（规格 §4.2）：
 *   name / type / command / args / env / cwd / url / headers / timeout(秒) / enabled
 *   / exposure / toolExposure
 * 不再使用 pi-mcp-adapter 时代的 lifecycle / requestTimeoutMs 等字段（已无消费者）。
 */
export function McpForm({ initial, onSave, onCancel }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState<Transport>(initialTransport(initial));
  const [command, setCommand] = useState(initial?.command ?? "");
  const [argsText, setArgsText] = useState(initial?.args?.join(" ") ?? "");
  const [envPairs, setEnvPairs] = useState<Pair[]>(pairsFrom(initial?.env));
  const [cwd, setCwd] = useState(initial?.cwd ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  // HTTP 服务器的 Authorization 头（完整值，如 "Bearer xxx"）。编辑时从 initial.headers 往返，
  // 避免表单保存覆盖丢失原有鉴权头。保存时若仅填了裸 token 自动补 Bearer 前缀。
  const [auth, setAuth] = useState(initial?.headers?.Authorization ?? "");
  // Authorization 之外的请求头（schema 的 headers 支持任意键）
  const [headerPairs, setHeaderPairs] = useState<Pair[]>(
    pairsFrom(omitAuthorization(initial?.headers)),
  );
  const [timeoutText, setTimeoutText] = useState(
    initial?.timeout?.toString() ?? "",
  );
  const [enabled, setEnabled] = useState(initial?.enabled !== false);
  const [exposure, setExposure] = useState<McpExposure>(
    initial?.exposure ?? DEFAULT_MCP_EXPOSURE,
  );
  const [toolExposureRows, setToolExposureRows] = useState<ToolExposureRow[]>(
    rowsFrom(initial?.toolExposure),
  );
  const [fieldErrors, setFieldErrors] = useState<McpFieldError[]>([]);
  const [formError, setFormError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!initial) return;
    setName(initial.name);
    setType(initialTransport(initial));
    setCommand(initial.command ?? "");
    setArgsText(initial.args?.join(" ") ?? "");
    setEnvPairs(pairsFrom(initial.env));
    setCwd(initial.cwd ?? "");
    setUrl(initial.url ?? "");
    setAuth(initial.headers?.Authorization ?? "");
    setHeaderPairs(pairsFrom(omitAuthorization(initial.headers)));
    setTimeoutText(initial.timeout?.toString() ?? "");
    setEnabled(initial.enabled !== false);
    setExposure(initial.exposure ?? DEFAULT_MCP_EXPOSURE);
    setToolExposureRows(rowsFrom(initial.toolExposure));
  }, [initial]);

  /** 字段级错误文案（无该字段错误时为 undefined） */
  const errorOf = (field: string): string | undefined =>
    fieldErrors.find((e) => e.field === field)?.message;

  const buildConfig = (): McpServerConfig => {
    const config: McpServerConfig = { name: name.trim(), type };
    if (type === "stdio") {
      config.command = command.trim();
      const args = argsText.trim();
      if (args) config.args = args.split(/\s+/);
      config.env = pairsToRecord(envPairs);
    } else {
      config.url = url.trim();
      // 往返 Authorization 头：填了就写回 headers（裸 token 自动补 Bearer），避免编辑丢鉴权；
      // 专属输入框优先于「其它请求头」里同名的键
      const headers: Record<string, string> = { ...pairsToRecord(headerPairs) };
      if (auth.trim()) headers.Authorization = normalizeAuth(auth);
      if (Object.keys(headers).length > 0) config.headers = headers;
    }
    const cwdValue = cwd.trim();
    if (cwdValue) config.cwd = cwdValue;
    // 留空 = 不设超时（schema 不允许 0/负数：清空即不写该字段）
    const timeoutValue = timeoutText.trim();
    if (timeoutValue) config.timeout = Number(timeoutValue);
    config.enabled = enabled;
    config.exposure = exposure;
    config.toolExposure = rowsToRecord(toolExposureRows);
    return config;
  };

  const handleSubmit = () => {
    const config = buildConfig();
    // 先本地校验（与 kernel 共用 validateMcpServer）：非法名 / command 与 url 互斥不必往返一次
    const local = validateMcpServer(config);
    if (local.length > 0) {
      setFieldErrors(local);
      setFormError(undefined);
      return;
    }
    setFieldErrors([]);
    setFormError(undefined);

    const applyResult = (result: McpSaveResult | void) => {
      if (!result || result.ok) return;
      setFieldErrors(result.errors ?? []);
      // 只有总错误才弹总提示：有字段级错误时逐项提示，不重复
      setFormError(result.errors?.length ? undefined : result.message);
    };

    let result: McpSaveResult | void | Promise<McpSaveResult | void>;
    try {
      result = onSave(
        config,
        initial && initial.name !== config.name ? initial.name : undefined,
      );
    } catch (e) {
      setFormError(formatApiError(e));
      return;
    }
    // 同步返回（组件测试里的 mock）不上「保存中」态，异步才置位并等结果
    if (isThenable<McpSaveResult | void>(result)) {
      setSaving(true);
      void (result as Promise<McpSaveResult | void>)
        .then(applyResult)
        .catch((e) => setFormError(formatApiError(e)))
        .finally(() => setSaving(false));
      return;
    }
    applyResult(result);
  };

  return (
    <div className="flex flex-col gap-2.5" data-testid="mcp-form">
      <Field label={t("mcpForm.nameLabel")}>
        <input
          className={`w-full ${INPUT_CLASS}`}
          style={INPUT_STYLE}
          placeholder={t("mcpForm.namePlaceholder")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="mcp-form-name"
        />
        <FieldError message={errorOf("name")} field="name" />
      </Field>

      {/* 传输类型 */}
      <div className="flex gap-2">
        <label className={LABEL_CLASS}>{t("mcpForm.transportLabel")}</label>
        <div className="flex gap-1.5">
          {(["stdio", "http"] as Transport[]).map((tr) => (
            <button
              key={tr}
              type="button"
              onClick={() => setType(tr)}
              className="text-[calc(11px*var(--font-scale))] font-semibold px-2.5 py-1 rounded-full"
              style={{
                background:
                  type === tr ? "var(--accent-soft)" : "var(--surface)",
                color: type === tr ? "var(--accent)" : "var(--text-secondary)",
                border: type === tr ? "none" : "1px solid var(--hairline)",
              }}
              data-testid={`mcp-form-transport-${tr}`}
            >
              {tr === "stdio"
                ? t("mcpForm.transportStdio")
                : t("mcpForm.transportHttp")}
            </button>
          ))}
        </div>
      </div>
      <FieldError message={errorOf("type")} field="type" />

      {/* stdio 字段 */}
      {type === "stdio" && (
        <>
          <Field label={t("mcpForm.commandLabel")}>
            <input
              className={`w-full ${INPUT_CLASS}`}
              style={INPUT_STYLE}
              placeholder={t("mcpForm.commandPlaceholder")}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              data-testid="mcp-form-command"
            />
            <FieldError message={errorOf("command")} field="command" />
          </Field>
          <Field label={t("mcpForm.argsLabel")}>
            <input
              className={`w-full ${INPUT_CLASS}`}
              style={INPUT_STYLE}
              placeholder={t("mcpForm.argsPlaceholder")}
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              data-testid="mcp-form-args"
            />
          </Field>
          <Field label={t("mcpForm.envLabel")}>
            <PairsEditor
              pairs={envPairs}
              onChange={setEnvPairs}
              prefix="mcp-form-env"
              addLabel={t("mcpForm.envAdd")}
              removeTitle={t("mcpForm.envRemoveTitle")}
              keyPlaceholder={t("mcpForm.envKeyPlaceholder")}
              valuePlaceholder={t("mcpForm.envValuePlaceholder")}
            />
          </Field>
        </>
      )}

      {/* HTTP 字段 */}
      {type === "http" && (
        <>
          <Field label={t("mcpForm.urlLabel")}>
            <input
              className={`w-full ${INPUT_CLASS}`}
              style={INPUT_STYLE}
              placeholder={t("mcpForm.urlPlaceholder")}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              data-testid="mcp-form-url"
            />
            <FieldError message={errorOf("url")} field="url" />
          </Field>
          <Field label={t("mcpForm.authLabel")}>
            <input
              className={`w-full ${INPUT_CLASS}`}
              style={INPUT_STYLE}
              placeholder={t("mcpForm.authPlaceholder")}
              value={auth}
              onChange={(e) => setAuth(e.target.value)}
              data-testid="mcp-form-auth"
            />
          </Field>
          <Field label={t("mcpForm.headersLabel")}>
            <PairsEditor
              pairs={headerPairs}
              onChange={setHeaderPairs}
              prefix="mcp-form-header"
              addLabel={t("mcpForm.headerAdd")}
              removeTitle={t("mcpForm.headerRemoveTitle")}
              keyPlaceholder={t("mcpForm.headerKeyPlaceholder")}
              valuePlaceholder={t("mcpForm.headerValuePlaceholder")}
            />
          </Field>
        </>
      )}

      {/* 工作目录（两种传输都可用） */}
      <Field label={t("mcpForm.cwdLabel")}>
        <input
          className={`w-full ${INPUT_CLASS}`}
          style={INPUT_STYLE}
          placeholder={t("mcpForm.cwdPlaceholder")}
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          data-testid="mcp-form-cwd"
        />
      </Field>

      {/* 暴露方式 */}
      <Field label={t("mcpForm.exposureLabel")}>
        <select
          className={`${INPUT_CLASS} self-start`}
          style={INPUT_STYLE}
          value={exposure}
          onChange={(e) => setExposure(e.target.value as McpExposure)}
          data-testid="mcp-form-exposure"
        >
          {MCP_EXPOSURES.map((e) => (
            <option key={e} value={e}>
              {t(exposureLabelKey(e))}
            </option>
          ))}
        </select>
        <p
          className="text-[calc(10.5px*var(--font-scale))] text-tertiary mt-1"
          data-testid="mcp-form-exposure-desc"
        >
          {t(exposureDescKey(exposure))}
        </p>
        <p className="text-[calc(10.5px*var(--font-scale))] text-tertiary mt-0.5">
          {t("mcpForm.exposureHint")}
        </p>
      </Field>

      {/* 逐工具暴露方式覆盖 */}
      <Field label={t("mcpForm.toolExposureLabel")}>
        <div className="flex flex-col gap-1">
          {toolExposureRows.map((row, i) => (
            <div key={i} className="flex gap-1 items-center">
              <input
                className={`flex-1 ${INPUT_CLASS}`}
                style={INPUT_STYLE}
                placeholder={t("mcpForm.toolExposureNamePlaceholder")}
                value={row.name}
                onChange={(e) => {
                  const next = [...toolExposureRows];
                  next[i] = { ...next[i], name: e.target.value };
                  setToolExposureRows(next);
                }}
                data-testid={`mcp-form-tool-exposure-name-${i}`}
              />
              <select
                className={INPUT_CLASS}
                style={INPUT_STYLE}
                value={row.exposure}
                onChange={(e) => {
                  const next = [...toolExposureRows];
                  next[i] = {
                    ...next[i],
                    exposure: e.target.value as McpExposure,
                  };
                  setToolExposureRows(next);
                }}
                data-testid={`mcp-form-tool-exposure-value-${i}`}
              >
                {MCP_EXPOSURES.map((e) => (
                  <option key={e} value={e}>
                    {t(exposureLabelKey(e))}
                  </option>
                ))}
              </select>
              <RemoveBtn
                testId={`mcp-form-tool-exposure-remove-${i}`}
                title={t("mcpForm.toolExposureRemoveTitle")}
                onClick={() =>
                  setToolExposureRows(toolExposureRows.filter((_, j) => j !== i))
                }
              />
            </div>
          ))}
          <AddBtn
            testId="mcp-form-tool-exposure-add"
            label={t("mcpForm.toolExposureAdd")}
            onClick={() =>
              setToolExposureRows([
                ...toolExposureRows,
                { name: "", exposure: DEFAULT_MCP_EXPOSURE },
              ])
            }
          />
        </div>
      </Field>

      {/* 超时（秒） */}
      <Field label={t("mcpForm.timeoutLabel")}>
        <input
          className={`w-full ${INPUT_CLASS}`}
          style={INPUT_STYLE}
          placeholder={t("mcpForm.timeoutPlaceholder")}
          value={timeoutText}
          onChange={(e) => setTimeoutText(e.target.value.replace(/\D/g, ""))}
          data-testid="mcp-form-timeout"
        />
        <FieldError message={errorOf("timeout")} field="timeout" />
      </Field>

      {/* 启用 */}
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          data-testid="mcp-form-enabled"
        />
        <span className={LABEL_CLASS}>{t("mcpForm.enabledLabel")}</span>
      </label>

      {/* 整体错误（无字段级信息时，如原服务器不存在） */}
      {formError && (
        <p
          className="text-[calc(11.5px*var(--font-scale))] px-2 py-1 rounded"
          style={{ color: "var(--danger)", background: "var(--danger-soft)" }}
          data-testid="mcp-form-error"
        >
          {formError}
        </p>
      )}

      {/* 按钮 */}
      <div className="flex justify-end gap-2 mt-1">
        <button
          onClick={onCancel}
          className="text-[calc(11px*var(--font-scale))] px-3 py-1 rounded-md"
          style={{
            border: "1px solid var(--hairline)",
            color: "var(--text-secondary)",
            background: "transparent",
          }}
          data-testid="mcp-form-cancel"
        >
          {t("mcpForm.cancel")}
        </button>
        <button
          onClick={handleSubmit}
          className="text-[calc(11px*var(--font-scale))] font-semibold px-3 py-1 rounded-md text-white disabled:opacity-50"
          style={{ background: "var(--accent)", border: "none" }}
          disabled={!name.trim() || saving}
          data-testid="mcp-form-save"
        >
          {saving ? t("mcpForm.saving") : t("mcpForm.save")}
        </button>
      </div>
    </div>
  );
}

/** 带标签的字段容器（标签 + 控件 + 字段级错误） */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <label className={LABEL_CLASS}>{label}</label>
      {children}
    </div>
  );
}

/** 字段级错误：绑在对应输入框下方（不是只弹一个总错误） */
function FieldError({ message, field }: { message?: string; field: string }) {
  if (!message) return null;
  return (
    <p
      className="text-[calc(10.5px*var(--font-scale))] mt-0.5"
      style={{ color: "var(--danger)" }}
      data-testid={`mcp-form-error-${field}`}
    >
      {message}
    </p>
  );
}

/** key-value 行编辑器（env / 其它请求头共用） */
function PairsEditor({
  pairs,
  onChange,
  prefix,
  addLabel,
  removeTitle,
  keyPlaceholder,
  valuePlaceholder,
}: {
  pairs: Pair[];
  onChange: (next: Pair[]) => void;
  prefix: string;
  addLabel: string;
  removeTitle: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      {pairs.map((pair, i) => (
        <div key={i} className="flex gap-1 items-center">
          <input
            className={`flex-1 ${INPUT_CLASS}`}
            style={INPUT_STYLE}
            placeholder={keyPlaceholder}
            value={pair.key}
            onChange={(e) => {
              const next = [...pairs];
              next[i] = { ...next[i], key: e.target.value };
              onChange(next);
            }}
            data-testid={`${prefix}-key-${i}`}
          />
          <input
            className={`flex-1 ${INPUT_CLASS}`}
            style={INPUT_STYLE}
            placeholder={valuePlaceholder}
            value={pair.value}
            onChange={(e) => {
              const next = [...pairs];
              next[i] = { ...next[i], value: e.target.value };
              onChange(next);
            }}
            data-testid={`${prefix}-val-${i}`}
          />
          <RemoveBtn
            testId={`${prefix}-remove-${i}`}
            title={removeTitle}
            onClick={() => onChange(pairs.filter((_, j) => j !== i))}
          />
        </div>
      ))}
      <AddBtn
        testId={`${prefix}-add`}
        label={addLabel}
        onClick={() => onChange([...pairs, { key: "", value: "" }])}
      />
    </div>
  );
}

function AddBtn({
  testId,
  label,
  onClick,
}: {
  testId: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="text-[calc(11px*var(--font-scale))] px-2.5 py-1 rounded-md self-start"
      style={{
        color: "var(--accent)",
        border: "1px solid var(--accent)",
        background: "transparent",
      }}
      onClick={onClick}
      data-testid={testId}
    >
      {label}
    </button>
  );
}

function RemoveBtn({
  testId,
  title,
  onClick,
}: {
  testId: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="text-[calc(11px*var(--font-scale))] px-1.5 py-1 rounded-md flex-shrink-0"
      style={{
        color: "var(--danger)",
        border: "1px solid var(--danger)",
        background: "#fff",
      }}
      onClick={onClick}
      data-testid={testId}
      title={title}
    >
      ×
    </button>
  );
}
