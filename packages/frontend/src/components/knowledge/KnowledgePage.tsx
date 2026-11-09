// 知识库管理页（任务 B2：列表填充；B3：新建/编辑表单弹窗接入）
import { useEffect, useState } from "react";
import type { KbInfo } from "@wa-pi/shared";
import { useTranslation } from "../../i18n/useTranslation";
import { api } from "../../api-client";
import { formatApiError } from "../../util/kernel-error";
import { useKnowledgeStore } from "../../store/knowledge";
import { KbList } from "./KbList";
import {
  KbFormModal,
  type KbFormPayload,
  type KbFormSaveResult,
} from "./KbFormModal";
import { KbFailedModal } from "./KbFailedModal";

/** 弹窗目标：null=关闭；"new"=新建；KbInfo=编辑该库 */
type KbFormTarget = KbInfo | "new" | null;

export function KnowledgePage() {
  const { t } = useTranslation();
  const { kbs, loading, listKbs } = useKnowledgeStore();
  const [formTarget, setFormTarget] = useState<KbFormTarget>(null);
  /** 失败清单弹窗目标（null=关闭；kbId=展示该库最近一轮的失败文件） */
  const [failedKbId, setFailedKbId] = useState<string | null>(null);

  // 挂载即拉清单（B4+ 的失败清单/进度亦经本 store 的 SSE 订阅回流）
  useEffect(() => {
    listKbs();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** 弹窗保存：新建发 POST（自动触发索引），编辑发 PUT 只更名称/描述；
   *  成功后刷新清单并关闭弹窗（POST 返回即落库，索引进度走 SSE 刷新徽章） */
  const handleFormSave = async (
    payload: KbFormPayload,
  ): Promise<KbFormSaveResult> => {
    try {
      if (formTarget === "new") {
        await api.post("/api/knowledge", payload);
      } else if (formTarget) {
        await api.put(`/api/knowledge/${encodeURIComponent(formTarget.id)}`, {
          name: payload.name,
          description: payload.description,
        });
      }
      listKbs();
      setFormTarget(null);
      return { ok: true };
    } catch (e) {
      // 失败不关弹窗：错误文案回显表单（如「目录不存在」）
      return { ok: false, message: formatApiError(e) };
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden" data-testid="kb-page">
      {/* 标题栏（样式对齐 McpPage，修复 B1 遗留：占位 h2 无样式类） */}
      <div
        className="flex items-center px-5 py-3.5"
        style={{
          background: "var(--surface)",
          borderBottom: "1px solid var(--hairline)",
        }}
      >
        <h2 className="text-base font-extrabold text-primary m-0">
          {t("settings.nav.knowledge")}
        </h2>
      </div>

      {/* 工具栏：新建按钮（B3 接 KbFormModal） */}
      <div
        className="flex items-center justify-end gap-2.5 px-5 py-2.5"
        style={{
          background: "var(--surface)",
          borderBottom: "1px solid var(--hairline)",
        }}
      >
        <button
          onClick={() => setFormTarget("new")}
          className="text-[calc(11px*var(--font-scale))] font-semibold px-3 py-1.5 rounded-md text-white shrink-0"
          style={{ background: "var(--accent)", border: "none" }}
          data-testid="kb-add-button"
        >
          {t("kb.addButton")}
        </button>
      </div>

      {/* 列表内容 */}
      <div className="flex-1 overflow-y-auto px-5 py-3.5">
        {loading ? (
          <div className="text-center text-tertiary text-[calc(12.5px*var(--font-scale))] py-8">
            {t("kb.loading")}
          </div>
        ) : (
          <KbList
            kbs={kbs}
            // B3：编辑入口接 KbFormModal（只更名称/描述）
            onEdit={(kb) => setFormTarget(kb)}
            // B4：失败徽章点击接失败清单弹窗（B2 占位回调的落点）
            onShowFailed={(id) => setFailedKbId(id)}
            // 占位（重建链路不在 B3 范围，弹窗不含重建操作）：按钮可渲染，点击暂无动作
            onReindex={() => {
              /* 重建索引：后续任务接 POST /api/knowledge/:id/index */
            }}
          />
        )}
      </div>

      {/* 新建/编辑弹窗 */}
      {formTarget !== null && (
        <KbFormModal
          kb={formTarget === "new" ? undefined : formTarget}
          onSave={handleFormSave}
          onClose={() => setFormTarget(null)}
        />
      )}

      {/* 失败文件清单弹窗（B4）：库名从当前清单取，取不到（已删）回退 kbId */}
      {failedKbId && (
        <KbFailedModal
          kbId={failedKbId}
          kbName={kbs.find((k) => k.id === failedKbId)?.name ?? failedKbId}
          onClose={() => setFailedKbId(null)}
        />
      )}
    </div>
  );
}
