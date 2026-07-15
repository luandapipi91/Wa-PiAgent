import { useState, useEffect } from "react";
import type { McpServerConfig } from "@hiagent/shared";

type Transport = "stdio" | "http";

interface Props {
  initial?: McpServerConfig;
  onSave: (config: McpServerConfig, originalName?: string) => void;
  onCancel: () => void;
}

export function McpForm({ initial, onSave, onCancel }: Props) {
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
        <label className="text-[11px] font-semibold text-secondary block mb-0.5">名称</label>
        <input
          className="w-full text-[12px] px-2.5 py-1.5 rounded-md"
          style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
          placeholder="服务器名称（如 chrome-devtools）"
          value={name}
          onChange={e => setName(e.target.value)}
          data-testid="mcp-form-name"
        />
      </div>

        {/* 传输类型 */}
        <div className="flex gap-2">
          <label className="text-[11px] font-semibold text-secondary">传输类型</label>
          <div className="flex gap-1.5">
            {(["stdio", "http"] as Transport[]).map(t => (
              <button
                key={t}
                type="button"
                onClick={() => setTransport(t)}
                className="text-[11px] font-semibold px-2.5 py-1 rounded-full"
                style={{
                  background: transport === t ? "var(--accent-soft)" : "var(--surface)",
                  color: transport === t ? "var(--accent)" : "var(--text-secondary)",
                  border: transport === t ? "none" : "1px solid var(--hairline)",
                }}
                data-testid={`mcp-form-transport-${t}`}
              >{t === "stdio" ? "stdio" : "HTTP"}</button>
            ))}
          </div>
        </div>

        {/* stdio 字段 */}
        {transport === "stdio" && (
          <>
            <div>
              <label className="text-[11px] font-semibold text-secondary block mb-0.5">Command</label>
              <input
                className="w-full text-[12px] px-2.5 py-1.5 rounded-md"
                style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
                placeholder="npx"
                value={command}
                onChange={e => setCommand(e.target.value)}
                data-testid="mcp-form-command"
              />
            </div>
            <div>
              <label className="text-[11px] font-semibold text-secondary block mb-0.5">Args</label>
              <input
                className="w-full text-[12px] px-2.5 py-1.5 rounded-md"
                style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
                placeholder="-y some-mcp-server@latest"
                value={argsText}
                onChange={e => setArgsText(e.target.value)}
                data-testid="mcp-form-args"
              />
            </div>
          </>
        )}

        {/* HTTP 字段 */}
        {transport === "http" && (
          <>
            <div>
              <label className="text-[11px] font-semibold text-secondary block mb-0.5">URL</label>
              <input
                className="w-full text-[12px] px-2.5 py-1.5 rounded-md"
                style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
                placeholder="http://localhost:3845/mcp"
                value={url}
                onChange={e => setUrl(e.target.value)}
                data-testid="mcp-form-url"
              />
            </div>
            <div>
              <label className="text-[11px] font-semibold text-secondary block mb-0.5">Authorization</label>
              <input
                className="w-full text-[12px] px-2.5 py-1.5 rounded-md"
                style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
                placeholder="Bearer your-token（仅填 token 会自动补 Bearer）"
                value={auth}
                onChange={e => setAuth(e.target.value)}
                data-testid="mcp-form-auth"
              />
            </div>
          </>
        )}

        {/* 生命周期 */}
        <div>
          <label className="text-[11px] font-semibold text-secondary block mb-0.5">生命周期</label>
          <select
            className="text-[12px] px-2.5 py-1.5 rounded-md"
            style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
            value={lifecycle}
            onChange={e => setLifecycle(e.target.value as "lazy" | "eager" | "keep-alive")}
            data-testid="mcp-form-lifecycle"
          >
            <option value="lazy">lazy — 按需连接</option>
            <option value="eager">eager — 启动时连接</option>
            <option value="keep-alive">keep-alive — 保持连接</option>
          </select>
        </div>

        {/* 超时 */}
        <div>
          <label className="text-[11px] font-semibold text-secondary block mb-0.5">超时 (ms)</label>
          <input
            className="w-full text-[12px] px-2.5 py-1.5 rounded-md"
            style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
            placeholder="30000"
            value={timeout}
            onChange={e => setTimeout_(e.target.value.replace(/\D/g, ""))}
            data-testid="mcp-form-timeout"
          />
        </div>

        {/* 按钮 */}
        <div className="flex justify-end gap-2 mt-1">
          <button
            onClick={onCancel}
            className="text-[11px] px-3 py-1 rounded-md"
            style={{ border: "1px solid var(--hairline)", color: "var(--text-secondary)", background: "transparent" }}
            data-testid="mcp-form-cancel"
          >取消</button>
          <button
            onClick={handleSubmit}
            className="text-[11px] font-semibold px-3 py-1 rounded-md text-white"
            style={{ background: "var(--accent)", border: "none" }}
            disabled={!name.trim()}
            data-testid="mcp-form-save"
          >保存</button>
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
