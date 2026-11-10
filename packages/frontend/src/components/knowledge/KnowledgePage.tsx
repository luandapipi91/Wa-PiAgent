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
  const { kbs, loading, error, loaded, listKbs, reindex } = useKnowledgeStore();
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
      {/* 标题栏：页面标题与「+ 新建知识库」同一行（样式对齐 MemoryPage 的标题栏 + 右侧控件） */}
      <div
        className="flex items-center justify-between px-5 py-3.5"
        style={{
          background: "var(--surface)",
          borderBottom: "1px solid var(--hairline)",
        }}
      >
        <h2 className="text-base font-extrabold text-primary m-0">
          {t("settings.nav.knowledge")}
        </h2>
        <button
          onClick={() => setFormTarget("new")}
          className="text-[calc(11px*var(--font-scale))] font-semibold px-3 py-1.5 rounded-md text-white shrink-0"
          style={{ background: "var(--accent)", border: "none" }}
          data-testid="kb-add-button"
        >
          {t("kb.addButton")}
        </button>
      </div>

      {/* 列表内容：三态（加载失败/加载中/列表含真空态）*/}
      <div className="flex-1 overflow-y-auto px-5 py-3.5">
        {error && !loaded ? (
          // 拉取失败且从未成功过 = 清单未知态：不能渲染成「暂无知识库」（那是已知为空）
          <div className="text-center py-8" data-testid="kb-load-error">
            <p className="text-[calc(12.5px*var(--font-scale))] text-tertiary m-0">
              {t("kb.loadFailed")}
            </p>
            <p className="text-[calc(11px*var(--font-scale))] text-tertiary mt-1 mb-3">
              {error}
            </p>
            {/* 请求进行中置灰：错误块刻意不清空，不置灰会被当成没反应而连点 */}
            <button
              onClick={() => listKbs()}
              disabled={loading}
              className="text-[calc(11px*var(--font-scale))] font-semibold px-3 py-1.5 rounded-md text-white disabled:opacity-60"
              style={{ background: "var(--accent)", border: "none" }}
              data-testid="kb-retry"
            >
              {loading ? t("kb.loading") : t("kb.retry")}
            </button>
          </div>
        ) : !loaded ? (
          // 用 loaded（而非 loading 初值）判定「还没成功加载过」：否则首帧会先闪一次空态
          <div
            className="text-center text-tertiary text-[calc(12.5px*var(--font-scale))] py-8"
            data-testid="kb-loading"
          >
            {t("kb.loading")}
          </div>
        ) : (
          <>
            {/* 刷新失败（已有清单）：弱提示不阻断列表——旧数据仍比空白有用 */}
            {error && (
              <div
                className="text-[calc(11px*var(--font-scale))] text-tertiary mb-2"
                data-testid="kb-refresh-warn"
              >
                {t("kb.refreshWarn")}
              </div>
            )}
            <KbList
              kbs={kbs}
              // B3：编辑入口接 KbFormModal（只更名称/描述）
              onEdit={(kb) => setFormTarget(kb)}
              // B4：失败徽章点击接失败清单弹窗（B2 占位回调的落点）
              onShowFailed={(id) => setFailedKbId(id)}
              // 重建索引：接 store.reindex（POST :id/index，重复索引 400 由 store toast 提示）
              onReindex={(id) => reindex(id)}
            />
          </>
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
