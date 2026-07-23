import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Modal } from "../ui/Modal";
import { TagInput } from "../ui/TagInput";
import { useProvidersStore } from "../../store/providers";
import { send, onMessage } from "../../ws-instance";
import type { ModelProvider, ProviderApi, ProviderModel, ModelPreset } from "@hiagent/shared";

interface Props {
  initial?: ModelProvider;   // 编辑时传，新增时不传
  onClose: () => void;
}

const DEFAULT_CONTEXT = 128000;
const DEFAULT_MAX_TOKENS = 4096;

export function ProviderFormModal({ initial, onClose }: Props) {
  const save = useProvidersStore(s => s.save);
  const test = useProvidersStore(s => s.test);

  const [name, setName] = useState(initial?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [api, setApi] = useState<ProviderApi>(initial?.api ?? "openai-completions");
  const [modelIds, setModelIds] = useState<string[]>(initial?.models.map(m => m.id) ?? []);
  // 模型长度配置：key = modelId
  const [modelConfigs, setModelConfigs] = useState<Record<string, ProviderModel>>(
    Object.fromEntries((initial?.models ?? []).map(m => [m.id, m]))
  );
  const [testStatus, setTestStatus] = useState<{ state: "idle" | "testing" | "ok" | "fail"; error?: string }>({ state: "idle" });
  const [selectedPresetKey, setSelectedPresetKey] = useState<string>("");
  const [presets, setPresets] = useState<ModelPreset[]>([]);
  const [modelSearch, setModelSearch] = useState("");
  const selectedPreset = presets.find(p => p.key === selectedPresetKey);
  const tagContainerRef = useRef<HTMLDivElement>(null);
  const [dropPos, setDropPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const [tagKey, setTagKey] = useState(0);

  // 组件挂载时从 SDK 获取供应商预设列表
  useEffect(() => {
    const off = onMessage((e: any) => {
      if (e.type === "model:presets") {
        setPresets(e.presets ?? []);
      }
    });
    send({ type: "model:presets" });
    return off;
  }, []);

  // 滚动时更新下拉位置
  useEffect(() => {
    if (!dropPos) return;
    const update = () => {
      if (tagContainerRef.current && modelSearch) {
        const r = tagContainerRef.current.getBoundingClientRect();
        setDropPos({ top: r.bottom + 2, left: r.left, width: r.width });
      }
    };
    window.addEventListener("scroll", update, true);
    return () => window.removeEventListener("scroll", update, true);
  }, [dropPos, modelSearch]);

  // tag 变化 → 同步 modelConfigs（新增的用默认值，删除的移除）
  const handleTagsChange = (tags: string[]) => {
    setModelIds(tags);
    setModelConfigs(prev => {
      const next: Record<string, ProviderModel> = {};
      for (const id of tags) {
        next[id] = prev[id] ?? { id, contextWindow: DEFAULT_CONTEXT, maxTokens: DEFAULT_MAX_TOKENS };
      }
      return next;
    });
  };

  // 选预设 → 填供应商信息（不自动填模型），模型通过快捷下拉单独添加
  const applyPreset = (key: string): void => {
    setSelectedPresetKey(key);
    if (!key) { setModelIds([]); setModelConfigs({}); return; }
    const preset = presets.find(p => p.key === key);
    if (!preset) return;
    setName(preset.name);
    setBaseUrl(preset.baseUrl);
    setApi(preset.api as ProviderApi);
    // 清空已有模型，模型通过快捷下拉逐个添加
    setModelIds([]);
    setModelConfigs({});
    setModelSearch("");
    setDropPos(null);
    setTagKey(k => k + 1);
    // apiKey 不动（新增时为空）
  };

  // 从选中的供应商快捷添加一个模型（带预设参数）
  const addModelFromPreset = (modelId: string): void => {
    if (!modelId || !selectedPreset) return;
    const m = selectedPreset.models.find(x => x.id === modelId);
    if (!m) return;
    if (modelIds.includes(m.id)) return;
    setModelIds(prev => [...prev, m.id]);
    setModelConfigs(prev => ({
      ...prev,
      [m.id]: { id: m.id, contextWindow: m.contextWindow, maxTokens: m.maxTokens, supportsVision: m.supportsVision },
    }));
    setModelSearch("");
    setDropPos(null);
    setTagKey(k => k + 1);  // 强制 TagInput 重挂载清空输入
  };

  const valid = name.trim() && baseUrl.trim() && apiKey.trim() && modelIds.length > 0;

  const handleSave = () => {
    if (!valid) return;
    const provider: ModelProvider = {
      id: initial?.id ?? crypto.randomUUID(),
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      api,
      models: modelIds.map(id => modelConfigs[id]),
    };
    save(provider);
    onClose();
  };

  const handleTest = async () => {
    setTestStatus({ state: "testing" });
    const result = await test({ baseUrl, apiKey, api, models: modelIds.map(id => modelConfigs[id]) });
    setTestStatus(result.ok ? { state: "ok" } : { state: "fail", error: result.error });
  };

  return (
    <Modal onClose={onClose} width={640} data-testid="provider-form-modal">
      <div className="p-4 border-b border-hairline">
        <span className="text-primary font-bold text-sm">{initial ? "编辑供应商" : "添加供应商"}</span>
      </div>
      <div className="p-4 flex flex-col gap-3 overflow-auto" style={{ maxHeight: "70vh" }}>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-secondary">快捷选择</span>
          <select
            data-testid="preset-select"
            value={selectedPresetKey}
            onChange={e => applyPreset(e.target.value)}
            className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
          >
            <option value="">自定义（手动填写）</option>
            {presets.map(p => (
              <option key={p.key} value={p.key}>{p.name} ({p.models.length} 个模型)</option>
            ))}
          </select>
          {initial && (
            <span className="text-xs" style={{ color: "var(--danger)" }}>选择预设会覆盖当前表单</span>
          )}
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-secondary">供应商名称</span>
          <input
            data-testid="field-name"
            value={name}
            onChange={e => setName(e.target.value)}
            className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-secondary">Base URL</span>
          <input
            data-testid="field-baseUrl"
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
            className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-secondary">API Key</span>
          <input
            data-testid="field-apiKey"
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
          />
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-secondary">API 格式</span>
          <div className="flex gap-4">
            <label className="flex items-center gap-1.5 text-sm text-primary cursor-pointer">
              <input type="radio" checked={api === "openai-completions"} onChange={() => setApi("openai-completions")} />
              OpenAI 兼容
            </label>
            <label className="flex items-center gap-1.5 text-sm text-primary cursor-pointer">
              <input type="radio" checked={api === "anthropic-messages"} onChange={() => setApi("anthropic-messages")} />
              Anthropic
            </label>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-secondary">模型 ID（输入 | 添加，× 移除）</span>
          <div ref={tagContainerRef}>
          <TagInput key={tagKey} value={modelIds} onChange={handleTagsChange}
            placeholder="输入模型 ID，回车或 | 添加"
            onInputText={text => {
              setModelSearch(text);
              if (text && tagContainerRef.current) {
                const r = tagContainerRef.current.getBoundingClientRect();
                setDropPos({ top: r.bottom + 2, left: r.left, width: r.width });
              } else {
                setDropPos(null);
              }
            }}
          />
          </div>
        </div>
        {modelIds.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-secondary">模型列表</span>
            <div className="rounded-sm border border-hairline overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-surface-hover text-tertiary">
                  <tr>
                    <th className="text-left px-2 py-1 font-normal">模型 ID</th>
                    <th className="text-left px-2 py-1 font-normal">上下文窗口</th>
                    <th className="text-left px-2 py-1 font-normal">最大输出</th>
                    <th className="text-left px-2 py-1 font-normal">图片</th>
                  </tr>
                </thead>
                <tbody>
                  {modelIds.map((id, i) => (
                    <tr key={id} className="border-t border-hairline">
                      <td className="px-2 py-1 text-primary">{id}</td>
                      <td className="px-2 py-1">
                        <input
                          data-testid={`model-contextWindow-${i}`}
                          type="number"
                          value={modelConfigs[id]?.contextWindow ?? DEFAULT_CONTEXT}
                          onChange={e => setModelConfigs(prev => ({
                            ...prev,
                            [id]: { ...prev[id], contextWindow: Number(e.target.value) || 0 },
                          }))}
                          className="w-24 px-1 py-0.5 rounded-sm border border-hairline bg-surface text-primary outline-none"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          data-testid={`model-maxTokens-${i}`}
                          type="number"
                          value={modelConfigs[id]?.maxTokens ?? DEFAULT_MAX_TOKENS}
                          onChange={e => setModelConfigs(prev => ({
                            ...prev,
                            [id]: { ...prev[id], maxTokens: Number(e.target.value) || 0 },
                          }))}
                          className="w-24 px-1 py-0.5 rounded-sm border border-hairline bg-surface text-primary outline-none"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          data-testid={`model-vision-${i}`}
                          type="checkbox"
                          checked={modelConfigs[id]?.supportsVision ?? false}
                          onChange={e => setModelConfigs(prev => ({
                            ...prev,
                            [id]: { ...prev[id], supportsVision: e.target.checked },
                          }))}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {/* 测试连接结果 */}
        {testStatus.state === "testing" && <span className="text-xs text-secondary">测试中…</span>}
        {testStatus.state === "ok" && <span className="text-xs" style={{ color: "var(--success)" }}>✓ 连接成功</span>}
        {testStatus.state === "fail" && <span className="text-xs" style={{ color: "var(--danger)" }}>✗ 失败：{testStatus.error}</span>}
      </div>
      {dropPos && selectedPreset && createPortal(
        (() => {
          const q = modelSearch.toLowerCase();
          const available = selectedPreset.models.filter(m =>
            !modelIds.includes(m.id) && m.id.toLowerCase().includes(q)
          );
          if (available.length === 0) return null;
          return (
            <div className="fixed max-h-48 overflow-y-auto rounded-sm border border-hairline bg-surface shadow-lg z-50"
              style={{ top: dropPos.top, left: dropPos.left, width: dropPos.width }}
              data-testid="model-quick-dropdown">
              {available.map(m => (
                <div key={m.id}
                  data-testid="model-quick-option"
                  className="px-2 py-1.5 text-sm text-primary hover:bg-surface-hover cursor-pointer border-b border-hairline last:border-b-0"
                  onMouseDown={e => { e.preventDefault(); addModelFromPreset(m.id); }}
                >{m.id} <span className="text-tertiary text-xs">({m.contextWindow.toLocaleString()} ctx, {m.maxTokens.toLocaleString()} out{m.supportsVision ? ", 视觉" : ""})</span></div>
              ))}
            </div>
          );
        })(),
        document.body
      )}
      <div className="flex justify-between items-center p-3 border-t border-hairline">
        <button
          onClick={handleTest}
          disabled={!baseUrl || !apiKey}
          className="px-3 py-1.5 rounded-sm text-sm border border-hairline text-secondary hover:text-primary disabled:opacity-50"
        >测试连接</button>
        <div className="flex gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-sm text-sm bg-surface-hover text-secondary border border-hairline hover:text-primary">取消</button>
          <button
            onClick={handleSave}
            disabled={!valid}
            data-testid="provider-save-btn"
            className="px-3 py-1.5 rounded-sm text-sm border-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: "var(--brand)", color: "var(--on-brand)" }}
          >保存</button>
        </div>
      </div>
    </Modal>
  );
}
