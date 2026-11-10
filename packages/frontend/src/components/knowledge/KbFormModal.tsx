// KbFormModal — 知识库新建/编辑弹窗（任务 B3，仿 McpFormModal 模式：Modal 壳 + 表单体）
//
// 两段式（新建）：选路径（浏览/目录树选中/手输后失焦或回车，自动触发）POST /api/knowledge/preview
// → 展示可索引数 + 跳过原因计数 →「创建并索引」经 onSave（调用方 KnowledgePage 发 POST /api/knowledge）；
// 编辑模式走 PUT 只更新名称/描述（源文件夹创建后不可改，只读展示）。
//
// 文件夹选择对齐 projects store 惯例（createProjectFromDir）：Electron 下用原生系统目录
// 对话框（window.waPiApp.showOpenDirectoryDialog），浏览器回退 DirTreePicker 覆盖层；
// 文本输入始终可用（手动粘贴路径）。
//
// 默认值规则（kernel 同款兜底，前端空值直接提交）：名称留空 → 后端取文件夹名；
// 描述留空 → 后端生成默认描述。保存失败经 onSave 返回 { ok:false, message } 回显弹窗，
// 成功时由调用方刷新清单并关闭弹窗。
import { useRef, useState } from "react";
import type { KbInfo, KbScanPreview } from "@wa-pi/shared";
import { Modal } from "../ui/Modal";
import { DirTreePicker } from "../DirTreePicker";
import { api } from "../../api-client";
import { formatApiError } from "../../util/kernel-error";
import { useTranslation } from "../../i18n/useTranslation";

export interface KbFormPayload {
  folderPath: string;
  /** 留空则由 kernel 取 folderPath basename */
  name?: string;
  /** 留空则由 kernel 生成默认描述 */
  description?: string;
  /** 预览计划令牌（来自最近一次预览）：创建时回传给 kernel 比对目录是否变化 */
  planToken?: string;
}

export interface KbFormSaveResult {
  ok: boolean;
  /** ok:false 时的展示文案（如「目录不存在」「名称重复」） */
  message?: string;
}

interface Props {
  /** 传入 = 编辑模式（仅名称/描述可改）；缺省 = 新建（需选文件夹 + 扫描预览） */
  kb?: KbInfo;
  /** 保存（调用方发 POST/PUT）：返回 { ok:false, message } 时弹窗内回显；成功由调用方关闭弹窗 */
  onSave: (
    payload: KbFormPayload,
  ) => KbFormSaveResult | Promise<KbFormSaveResult | void> | void;
  onClose?: () => void;
}

/** 跳过原因 → i18n 键（六类，与 kernel scanFolder 的 reason 枚举对齐） */
const SKIP_REASON_KEYS: Record<
  KbScanPreview["skippable"][number]["reason"],
  string
> = {
  suggested_excluded: "kb.skipSuggestedExcluded",
  oversized: "kb.skipOversized",
  binary: "kb.skipBinary",
  unreadable: "kb.skipUnreadable",
  inaccessible: "kb.skipInaccessible",
  extraction_failed: "kb.skipExtractionFailed",
};

// 输入控件通用外观（对齐 McpForm 惯例：表单底色 + 细边框）
const INPUT_CLASS = "text-[calc(12px*var(--font-scale))] px-2.5 py-1.5 rounded-md";
const INPUT_STYLE = {
  background: "var(--canvas)",
  border: "1px solid var(--hairline)",
  color: "var(--text-primary)",
} as const;
const LABEL_CLASS =
  "text-[calc(11px*var(--font-scale))] font-semibold text-secondary";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <label className={LABEL_CLASS}>{label}</label>
      {children}
    </div>
  );
}

/** 字段级错误提示（danger 色，绑在对应输入框下方） */
function FieldError({ message, testId }: { message?: string; testId: string }) {
  if (!message) return null;
  return (
    <p
      className="text-[calc(10.5px*var(--font-scale))] mt-0.5"
      style={{ color: "var(--danger)" }}
      data-testid={testId}
    >
      {message}
    </p>
  );
}

export function KbFormModal({ kb, onSave, onClose }: Props) {
  const { t } = useTranslation();
  const editing = !!kb;
  const [folderPath, setFolderPath] = useState("");
  const [name, setName] = useState(kb?.name ?? "");
  const [description, setDescription] = useState(kb?.description ?? "");
  const [scanning, setScanning] = useState(false);
  const [preview, setPreview] = useState<KbScanPreview | null>(null);
  // 预览计划令牌：随预览回包落地，创建时透传（目录在预览后变动由后端报告）
  const [planToken, setPlanToken] = useState<string | undefined>();
  const [scanError, setScanError] = useState<string | undefined>();
  const [inlineError, setInlineError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  // 浏览器环境（无 Electron 原生目录对话框）才挂 DirTreePicker 覆盖层
  const [pickerOpen, setPickerOpen] = useState(false);
  // 扫描序号：改路径/再次扫描即作废在途响应（resolve 时序号不匹配则丢弃），
  // 防止旧路径的预览落地误导新路径提交（架空两段式确认语义）
  const scanSeqRef = useRef(0);
  // 已扫描路径：自动触发（失焦/回车/选完目录）对同一路径去重，避免无意义重复请求；
  // 扫描失败时清空，允许同路径再次触发重试
  const scannedPathRef = useRef("");

  const changeFolder = (v: string) => {
    setFolderPath(v);
    // 路径变了：作废在途扫描（旧响应 resolve 后被序号检查丢弃）并清旧预览
    scanSeqRef.current += 1;
    scannedPathRef.current = "";
    setScanning(false);
    setPreview(null);
    setPlanToken(undefined);
    setScanError(undefined);
    setInlineError(undefined);
  };

  // 「浏览」：Electron 原生目录对话框优先，浏览器回退 DirTreePicker；
  // 选定即自动扫描预览
  const browseFolder = async () => {
    const show = (
      window as {
        waPiApp?: { showOpenDirectoryDialog?: () => Promise<string | null> };
      }
    ).waPiApp?.showOpenDirectoryDialog;
    if (show) {
      const dir = await show();
      if (dir) {
        changeFolder(dir);
        void runScan(dir);
      }
      return;
    }
    setPickerOpen(true);
  };

  // 第一段：扫描预览（临时目录也可扫——只扫不建库，kernel 存在性校验在此兜底）。
  // 由选路径动作自动触发（浏览/目录树/失焦/回车），无需单独的扫描按钮
  const runScan = async (rawPath: string) => {
    const p = rawPath.trim();
    if (!p || p === scannedPathRef.current) return;
    scannedPathRef.current = p;
    const seq = ++scanSeqRef.current;
    setScanning(true);
    setScanError(undefined);
    setPreview(null);
    try {
      const data = (await api.post("/api/knowledge/preview", {
        folderPath: p,
      })) as { preview?: KbScanPreview; planToken?: string };
      // 本次扫描仍是最新一次才落地（期间改过路径/重新扫描则丢弃旧响应）
      if (seq === scanSeqRef.current) {
        setPreview(data?.preview ?? null);
        setPlanToken(data?.planToken);
      }
    } catch (e) {
      if (seq === scanSeqRef.current) {
        setScanError(formatApiError(e));
        scannedPathRef.current = ""; // 失败允许同路径重试（再次失焦/回车）
      }
    } finally {
      if (seq === scanSeqRef.current) setScanning(false);
    }
  };

  const handleSubmit = async () => {
    // 编辑模式源文件夹固定为原值；新建未选路径则内联拦截，不发起保存
    const folder = editing ? kb!.folderPath : folderPath.trim();
    if (!folder) {
      setInlineError(t("kb.pleaseSelectFolder"));
      return;
    }
    setInlineError(undefined);
    setFormError(undefined);
    setSaving(true);
    try {
      // 名称/描述 trim 后留空 → undefined（前端空值直接提交，kernel 兜底默认值）
      const result = await onSave({
        folderPath: folder,
        name: name.trim() || undefined,
        description: description.trim() || undefined,
        // 编辑模式无预览（源目录不可改），planToken 自然为 undefined
        planToken,
      });
      if (result && !result.ok) setFormError(result.message);
    } catch (e) {
      setFormError(formatApiError(e));
    } finally {
      setSaving(false);
    }
  };

  // 跳过原因 → 计数（按 skippable 出现顺序，仅展示出现的类别）
  const skipCounts: Array<
    [KbScanPreview["skippable"][number]["reason"], number]
  > = [];
  if (preview) {
    for (const s of preview.skippable) {
      const found = skipCounts.find(([r]) => r === s.reason);
      if (found) found[1] += 1;
      else skipCounts.push([s.reason, 1]);
    }
  }

  const close = onClose ?? (() => {});
  const title = editing
    ? t("kb.formTitleEdit")
    : t("kb.formTitleNew");

  return (
    <>
      <Modal
        onClose={close}
        width={520}
        closeOnOverlayClick={false}
        data-testid="kb-form-modal"
      >
        <div
          className="px-4 py-3 flex items-center justify-between"
          style={{ borderBottom: "1px solid var(--hairline)" }}
        >
          <span className="text-primary font-bold text-sm">{title}</span>
          <button
            onClick={close}
            className="text-tertiary text-xs"
            data-testid="kb-form-modal-close"
          >
            ✕
          </button>
        </div>
        <div className="p-4 overflow-y-auto" style={{ maxHeight: "72vh" }}>
          <div className="flex flex-col gap-2.5" data-testid="kb-form">
            {/* 源文件夹：编辑模式只读（PUT 不收 folderPath）；新建 = 文本输入 + 浏览（选定即自动扫描预览） */}
            <Field label={t("kb.folderLabel")}>
              {editing ? (
                <div
                  className={`${INPUT_CLASS} text-tertiary`}
                  style={{
                    ...INPUT_STYLE,
                    color: "var(--text-tertiary)",
                  }}
                  data-testid="kb-folder-static"
                >
                  {kb!.folderPath}
                </div>
              ) : (
                <>
                  <div className="flex gap-1.5">
                    <input
                      className={`flex-1 min-w-0 ${INPUT_CLASS}`}
                      style={INPUT_STYLE}
                      placeholder={t("kb.folderPlaceholder")}
                      value={folderPath}
                      onChange={(e) => changeFolder(e.target.value)}
                      onBlur={() => void runScan(folderPath)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void runScan(folderPath);
                      }}
                      data-testid="kb-folder-input"
                    />
                    <button
                      type="button"
                      onClick={() => void browseFolder()}
                      className="text-[calc(11px*var(--font-scale))] font-semibold px-2.5 py-1.5 rounded-md shrink-0"
                      style={{
                        background: "var(--surface)",
                        border: "1px solid var(--hairline)",
                        color: "var(--text-secondary)",
                      }}
                      data-testid="kb-browse"
                    >
                      {t("kb.browse")}
                    </button>
                  </div>
                  {/* 扫描状态行：自动扫描进行中提示 / 失败文案（无手动扫描按钮，选路径即预览） */}
                  <div className="flex items-center gap-2 mt-1">
                    {scanning && (
                      <span
                        className="text-[calc(11px*var(--font-scale))] text-tertiary"
                        data-testid="kb-scanning"
                      >
                        {t("kb.scanning")}
                      </span>
                    )}
                    <FieldError
                      message={scanError}
                      testId="kb-scan-error"
                    />
                  </div>
                  {/* 第二段结果：可索引数 + 跳过原因计数 */}
                  {preview && (
                    <div
                      className="mt-1 px-2.5 py-2 rounded-md text-[calc(11px*var(--font-scale))]"
                      style={{
                        background: "var(--canvas)",
                        border: "1px solid var(--hairline)",
                      }}
                      data-testid="kb-preview"
                    >
                      <span
                        className="font-semibold"
                        style={{ color: "var(--success)" }}
                        data-testid="kb-preview-indexable"
                      >
                        {t("kb.indexableCount", { count: preview.totalFiles })}
                      </span>
                      {preview.skippable.length > 0 && (
                        <div
                          className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-tertiary"
                          data-testid="kb-preview-skips"
                        >
                          <span>
                            {t("kb.skipTotal", {
                              count: preview.skippable.length,
                            })}
                          </span>
                          {skipCounts.map(([reason, count]) => (
                            <span
                              key={reason}
                              data-testid={`kb-skip-${reason}`}
                            >
                              {`${t(SKIP_REASON_KEYS[reason])} ${count}`}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
              <FieldError message={inlineError} testId="kb-folder-error" />
            </Field>

            <Field label={t("kb.nameLabel")}>
              <input
                className={`w-full ${INPUT_CLASS}`}
                style={INPUT_STYLE}
                placeholder={editing ? t("kb.namePlaceholderEdit") : t("kb.namePlaceholder")}
                value={name}
                onChange={(e) => setName(e.target.value)}
                data-testid="kb-name-input"
              />
            </Field>

            <Field label={t("kb.descLabel")}>
              <input
                className={`w-full ${INPUT_CLASS}`}
                style={INPUT_STYLE}
                placeholder={editing ? t("kb.descPlaceholderEdit") : t("kb.descPlaceholder")}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                data-testid="kb-desc-input"
              />
            </Field>

            <FieldError message={formError} testId="kb-form-error" />

            {/* 操作行 */}
            <div className="flex justify-end gap-2 mt-1">
              <button
                type="button"
                onClick={close}
                className="text-[calc(11px*var(--font-scale))] font-semibold px-3 py-1.5 rounded-md"
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--hairline)",
                  color: "var(--text-secondary)",
                }}
                data-testid="kb-cancel"
              >
                {t("kb.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={saving}
                className="text-[calc(11px*var(--font-scale))] font-semibold px-3 py-1.5 rounded-md text-white"
                style={{ background: "var(--accent)", border: "none" }}
                data-testid="kb-save"
              >
                {editing ? t("kb.saveEdit") : t("kb.saveNew")}
              </button>
            </div>
          </div>
        </div>
      </Modal>
      {/* DirTreePicker 自带 portal 到 body 顶层（层级高于 Modal 遮罩），直接挂即可 */}
      {pickerOpen && (
        <DirTreePicker
          showFiles={false}
          onPick={(p) => {
            setPickerOpen(false);
            changeFolder(p);
            void runScan(p);
          }}
          onCancel={() => setPickerOpen(false)}
        />
      )}
    </>
  );
}
