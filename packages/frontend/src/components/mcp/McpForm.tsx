import { useState, useEffect } from "react";
import type { McpServerConfig } from "@wa-pi/shared";
import { useTranslation } from "../../i18n/useTranslation";

type Transport = "stdio" | "http";

interface EnvPair { key: string; value: string; }

interface Props {
  initial?: McpServerConfig;
  onSave: (config: McpServerConfig, originalName?: string) => void;
  onCancel: () => void;
}

/** env Record → 可编辑的 key-value 对数组 */
function envToPairs(env?: Record<string, string>): EnvPair[] {
  if (!env) return [];
  return Object.entries(env).map(([key, value]) => ({ key, value }));
}

/** key-value 对数组 → env Record（跳过空 key） */
function pairsToEnv(pairs: EnvPair[]): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  for (const p of pairs) {
    if (p.key.trim()) env[p.key.trim()] = p.value;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

export function McpForm({ initial, onSave, onCancel }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? "");
  const [transport, setTransport] = useState<Transport>(initial?.url ? "http" : "stdio");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [argsText, setArgsText] = useState(initial?.args?.join(" ") ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [lifecycle, setLifecycle] = useState<"lazy" | "eager" | "keep-alive">(initial?.lifecycle ?? "lazy");
  const [timeout, setTimeout_] = useState(initial?.requestTimeoutMs?.toString() ?? "");
  // HTTP 服务器的 Authorization 头（完整值，如 "Bearer xxx"）。编辑时从 initial.headers 往返，
  // 避免表单保存覆盖丢失原有鉴权头。保存时若仅填了裸 token 自动补 Bearer 前缀。
  const [auth, setAuth] = useState(initial?.headers?.Authorization ?? "");
  const [envPairs, setEnvPairs] = useState<EnvPair[]>(envToPairs(initial?.env));

  useEffect(() => {
    if (initial) {
      setName(initial.name);
      setTransport(initial.url ? "http" : "stdio");
      setCommand(initial.command ?? "");
      setArgsText(initial.args?.join(" ") ?? "");
      setUrl(initial.url ?? "");
      setLifecycle(initial.lifecycle ?? "lazy");
      setTimeout_(initial.requestTimeoutMs?.toString() ?? "");
      setAuth(initial.headers?.Authorization ?? "");
      setEnvPairs(envToPairs(initial.env));
    }
  }, [initial]);

  const handleSubmit = () => {
    if (!name.trim()) return;
    const config: McpServerConfig = {
      name: name.trim(),
      lifecycle: lifecycle === "lazy" ? undefined : lifecycle,
      requestTimeoutMs: timeout ? parseInt(timeout, 10) : undefined,
    };
    if (transport === "stdio") {
      config.command = command.trim();
      if (argsText.trim()) config.args = argsText.trim().split(/\s+/);
      config.env = pairsToEnv(envPairs);
    } else {
      config.url = url.trim();
      // 往返 Authorization 头：填了就写回 headers（裸 token 自动补 Bearer），避免编辑丢鉴权
      if (auth.trim()) {
        config.headers = { Authorization: normalizeAuth(auth) };
      }
    }
    onSave(config, initial?.name !== name.trim() ? initial?.name : undefined);
  };

  return (
    <div className="flex flex-col gap-2.5" data-testid="mcp-form">
      {/* 名称 */}
      <div>
        <label className="text-[calc(11px*var(--font-scale))] font-semibold text-secondary block mb-0.5">{t("mcpForm.nameLabel")}</label>
        <input
          className="w-full text-[calc(12px*var(--font-scale))] px-2.5 py-1.5 rounded-md"
          style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
          placeholder={t("mcpForm.namePlaceholder")}
          value={name}
          onChange={e => setName(e.target.value)}
          data-testid="mcp-form-name"
        />
      </div>

        {/* 传输类型 */}
        <div className="flex gap-2">
          <label className="text-[calc(11px*var(--font-scale))] font-semibold text-secondary">{t("mcpForm.transportLabel")}</label>
          <div className="flex gap-1.5">
            {(["stdio", "http"] as Transport[]).map(tr => (
              <button
                key={tr}
                type="button"
                onClick={() => setTransport(tr)}
                className="text-[calc(11px*var(--font-scale))] font-semibold px-2.5 py-1 rounded-full"
                style={{
                  background: transport === tr ? "var(--accent-soft)" : "var(--surface)",
                  color: transport === tr ? "var(--accent)" : "var(--text-secondary)",
                  border: transport === tr ? "none" : "1px solid var(--hairline)",
                }}
                data-testid={`mcp-form-transport-${tr}`}
              >{tr === "stdio" ? t("mcpForm.transportStdio") : t("mcpForm.transportHttp")}</button>
            ))}
          </div>
        </div>

        {/* stdio 字段 */}
        {transport === "stdio" && (
          <>
            <div>
              <label className="text-[calc(11px*var(--font-scale))] font-semibold text-secondary block mb-0.5">{t("mcpForm.commandLabel")}</label>
              <input
                className="w-full text-[calc(12px*var(--font-scale))] px-2.5 py-1.5 rounded-md"
                style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
                placeholder={t("mcpForm.commandPlaceholder")}
                value={command}
                onChange={e => setCommand(e.target.value)}
                data-testid="mcp-form-command"
              />
            </div>
            <div>
              <label className="text-[calc(11px*var(--font-scale))] font-semibold text-secondary block mb-0.5">{t("mcpForm.argsLabel")}</label>
              <input
                className="w-full text-[calc(12px*var(--font-scale))] px-2.5 py-1.5 rounded-md"
                style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
                placeholder={t("mcpForm.argsPlaceholder")}
                value={argsText}
                onChange={e => setArgsText(e.target.value)}
                data-testid="mcp-form-args"
              />
            </div>

            {/* 环境变量 */}
            <div>
              <label className="text-[calc(11px*var(--font-scale))] font-semibold text-secondary block mb-0.5">{t("mcpForm.envLabel")}</label>
              <div className="flex flex-col gap-1">
                {envPairs.map((pair, i) => (
                  <div key={i} className="flex gap-1 items-center">
                    <input
                      className="text-[calc(12px*var(--font-scale))] px-2 py-1 rounded-md flex-1"
                      style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
                      placeholder={t("mcpForm.envKeyPlaceholder")}
                      value={pair.key}
                      onChange={e => {
                        const next = [...envPairs];
                        next[i] = { ...next[i], key: e.target.value };
                        setEnvPairs(next);
                      }}
                      data-testid={`mcp-form-env-key-${i}`}
                    />
                    <input
                      className="text-[calc(12px*var(--font-scale))] px-2 py-1 rounded-md flex-1"
                      style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
                      placeholder={t("mcpForm.envValuePlaceholder")}
                      value={pair.value}
                      onChange={e => {
                        const next = [...envPairs];
                        next[i] = { ...next[i], value: e.target.value };
                        setEnvPairs(next);
                      }}
                      data-testid={`mcp-form-env-val-${i}`}
                    />
                    <button
                      type="button"
                      className="text-[calc(11px*var(--font-scale))] px-1.5 py-1 rounded-md flex-shrink-0"
                      style={{ color: "var(--danger)", border: "1px solid var(--danger)", background: "#fff" }}
                      onClick={() => setEnvPairs(envPairs.filter((_, j) => j !== i))}
                      data-testid={`mcp-form-env-remove-${i}`}
                      title={t("mcpForm.envRemoveTitle")}
                    >×</button>
                  </div>
                ))}
                <button
                  type="button"
                  className="text-[calc(11px*var(--font-scale))] px-2.5 py-1 rounded-md self-start"
                  style={{ color: "var(--accent)", border: "1px solid var(--accent)", background: "transparent" }}
                  onClick={() => setEnvPairs([...envPairs, { key: "", value: "" }])}
                  data-testid="mcp-form-env-add"
                >{t("mcpForm.envAdd")}</button>
              </div>
            </div>
          </>
        )}

        {/* HTTP 字段 */}
        {transport === "http" && (
          <>
            <div>
              <label className="text-[calc(11px*var(--font-scale))] font-semibold text-secondary block mb-0.5">{t("mcpForm.urlLabel")}</label>
              <input
                className="w-full text-[calc(12px*var(--font-scale))] px-2.5 py-1.5 rounded-md"
                style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
                placeholder={t("mcpForm.urlPlaceholder")}
                value={url}
                onChange={e => setUrl(e.target.value)}
                data-testid="mcp-form-url"
              />
            </div>
            <div>
              <label className="text-[calc(11px*var(--font-scale))] font-semibold text-secondary block mb-0.5">{t("mcpForm.authLabel")}</label>
              <input
                className="w-full text-[calc(12px*var(--font-scale))] px-2.5 py-1.5 rounded-md"
                style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
                placeholder={t("mcpForm.authPlaceholder")}
                value={auth}
                onChange={e => setAuth(e.target.value)}
                data-testid="mcp-form-auth"
              />
            </div>
          </>
        )}

        {/* 生命周期 */}
        <div>
          <label className="text-[calc(11px*var(--font-scale))] font-semibold text-secondary block mb-0.5">{t("mcpForm.lifecycleLabel")}</label>
          <select
            className="text-[calc(12px*var(--font-scale))] px-2.5 py-1.5 rounded-md"
            style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
            value={lifecycle}
            onChange={e => setLifecycle(e.target.value as "lazy" | "eager" | "keep-alive")}
            data-testid="mcp-form-lifecycle"
          >
            <option value="lazy">{t("mcpForm.lifecycleLazy")}</option>
            <option value="eager">{t("mcpForm.lifecycleEager")}</option>
            <option value="keep-alive">{t("mcpForm.lifecycleKeepAlive")}</option>
          </select>
        </div>

        {/* 超时 */}
        <div>
          <label className="text-[calc(11px*var(--font-scale))] font-semibold text-secondary block mb-0.5">{t("mcpForm.timeoutLabel")}</label>
          <input
            className="w-full text-[calc(12px*var(--font-scale))] px-2.5 py-1.5 rounded-md"
            style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
            placeholder={t("mcpForm.timeoutPlaceholder")}
            value={timeout}
            onChange={e => setTimeout_(e.target.value.replace(/\D/g, ""))}
            data-testid="mcp-form-timeout"
          />
        </div>

        {/* 按钮 */}
        <div className="flex justify-end gap-2 mt-1">
          <button
            onClick={onCancel}
            className="text-[calc(11px*var(--font-scale))] px-3 py-1 rounded-md"
            style={{ border: "1px solid var(--hairline)", color: "var(--text-secondary)", background: "transparent" }}
            data-testid="mcp-form-cancel"
          >{t("mcpForm.cancel")}</button>
          <button
            onClick={handleSubmit}
            className="text-[calc(11px*var(--font-scale))] font-semibold px-3 py-1 rounded-md text-white"
            style={{ background: "var(--accent)", border: "none" }}
            disabled={!name.trim()}
            data-testid="mcp-form-save"
          >{t("mcpForm.save")}</button>
        </div>
    </div>
  );
}

/** 规范化 Authorization 头值：含空格（已有 scheme，如 "Bearer xxx"）原样返回；
 *  仅裸 token 则补 "Bearer " 前缀。 */
function normalizeAuth(raw: string): string {
  const v = raw.trim();
  return v.includes(" ") ? v : `Bearer ${v}`;
}
