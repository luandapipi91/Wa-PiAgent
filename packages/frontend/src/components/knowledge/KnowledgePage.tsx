// 知识库管理页（任务 B2：列表填充；新建/编辑表单由 B3 接入）
import { useEffect } from "react";
import { useTranslation } from "../../i18n/useTranslation";
import { useKnowledgeStore } from "../../store/knowledge";
import { KbList } from "./KbList";

export function KnowledgePage() {
  const { t } = useTranslation();
  const { kbs, loading, listKbs } = useKnowledgeStore();

  // 挂载即拉清单（B4+ 的失败清单/进度亦经本 store 的 SSE 订阅回流）
  useEffect(() => {
    listKbs();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

      {/* 工具栏：新建按钮占位（B3 接新建表单） */}
      <div
        className="flex items-center justify-end gap-2.5 px-5 py-2.5"
        style={{
          background: "var(--surface)",
          borderBottom: "1px solid var(--hairline)",
        }}
      >
        <button
          onClick={() => {
            /* B3：打开新建表单 */
          }}
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
            // 占位（B3 接表单/重建链路）：保证卡片的更新/重建按钮先渲染出来
            onEdit={() => {
              /* B3：打开编辑表单 */
            }}
            onReindex={() => {
              /* B3：触发重建索引 */
            }}
          />
        )}
      </div>
    </div>
  );
}
