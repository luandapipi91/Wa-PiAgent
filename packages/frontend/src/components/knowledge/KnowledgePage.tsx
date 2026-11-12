// 知识库管理页（任务 B2：列表填充；B3：新建/编辑表单弹窗接入）
import { useEffect, useState, useRef } from "react";
import type { KbInfo } from "@wa-pi/shared";
import { useTranslation } from "../../i18n/useTranslation";
import { api } from "../../api-client";
import { formatApiError } from "../../util/kernel-error";
import { useKnowledgeStore } from "../../store/knowledge";
import { useToastStore } from "../../store/toast";
import { KbList } from "./KbList";
import {
  KbFormModal,
  type KbFormPayload,
  type KbFormSaveResult,
} from "./KbFormModal";
import { KbFailedModal } from "./KbFailedModal";
import { DoctorModal } from "./DoctorModal";
import { KbAgentsModal } from "./KbAgentsModal";

/** 弹窗目标：null=关闭；"new"=新建；KbInfo=编辑该库 */
type KbFormTarget = KbInfo | "new" | null;

/** 重排状态轮询上限（次）：1.5s × 40 ≈ 1 分钟，够启动恢复加载模型 */
export const RERANK_IDLE_POLL_MAX = 40;

/**
 * 重排状态是否需要继续轮询。
 * - downloading：跟下载进度，不设上限（慢网大模型可能很久）
 * - 已开启但仍 idle：kernel 重启后正在按开关恢复加载模型，得跟着等终态；
 *   设上限避免「内核不加载」时无限请求
 */
export function shouldPollRerank(
  state: { enabled: boolean; status: string },
  polls: number,
): boolean {
  if (state.status === "downloading") return true;
  if (state.status === "idle" && state.enabled) return polls < RERANK_IDLE_POLL_MAX;
  return false;
}

export function KnowledgePage() {
  const { t } = useTranslation();
  const { kbs, loading, error, loaded, listKbs, reindex } = useKnowledgeStore();
  const [formTarget, setFormTarget] = useState<KbFormTarget>(null);
  /** 失败清单弹窗目标（null=关闭；kbId=展示该库最近一轮的失败文件） */
  const [failedKbId, setFailedKbId] = useState<string | null>(null);
  /** 体检弹窗开关 */
  const [doctorOpen, setDoctorOpen] = useState(false);
  /** 页头「更多」菜单（深度重排等次要开关收在这里） */
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  /** 「关联智能体」弹窗目标库 */
  const [agentsKb, setAgentsKb] = useState<KbInfo | null>(null);
  const rerank = useKnowledgeStore((s) => s.rerank);
  const setRerankEnabled = useKnowledgeStore((s) => s.setRerankEnabled);
  const retryRerank = useKnowledgeStore((s) => s.retryRerank);
  const loadRerank = useKnowledgeStore((s) => s.loadRerank);

  // 挂载即拉清单（B4+ 的失败清单/进度亦经本 store 的 SSE 订阅回流）
  useEffect(() => {
    listKbs();
    loadRerank();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 下载中 / 已开启但仍在 idle（kernel 重启恢复中）每 1.5s 轮询一次状态，直到终态
  const rerankPolls = useRef(0);
  useEffect(() => {
    if (!shouldPollRerank(rerank, rerankPolls.current)) {
      rerankPolls.current = 0;
      return;
    }
    const timer = setInterval(() => {
      rerankPolls.current += 1;
      loadRerank();
      if (!shouldPollRerank(useKnowledgeStore.getState().rerank, rerankPolls.current)) {
        clearInterval(timer);
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [rerank.status, rerank.enabled, loadRerank]);

  /** 弹窗保存：新建发 POST（自动触发索引），编辑发 PUT 只更名称/描述；
   *  成功后刷新清单并关闭弹窗（POST 返回即落库，索引进度走 SSE 刷新徽章） */
  const handleFormSave = async (
    payload: KbFormPayload,
  ): Promise<KbFormSaveResult> => {
    try {
      if (formTarget === "new") {
        const res = (await api.post("/api/knowledge", payload)) as {
          planChanged?: { added: string[]; removed: string[] };
        };
        // 预览后目录有变动（用户在两段式里停留、外部程序写文件）：库照建，
        // 只提示「看到的预览已过期，已按最新内容索引」
        const changed = res?.planChanged;
        if (changed && (changed.added.length > 0 || changed.removed.length > 0)) {
          useToastStore.getState().add(
            t("kb.planChangedHint", {
              added: changed.added.length,
              removed: changed.removed.length,
            }),
            "info",
          );
        }
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

  // 「更多」菜单：点击外部关闭（Esc 同样关闭）
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

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
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setFormTarget("new")}
            className="text-[calc(11px*var(--font-scale))] font-semibold px-3 py-1.5 rounded-md text-white"
            style={{ background: "var(--accent)", border: "none" }}
            data-testid="kb-add-button"
          >
            {t("kb.addButton")}
          </button>
          {/* 「更多」菜单：深度重排等次要开关，点开 popup 后操作 */}
          <div className="relative" ref={moreRef}>
            <button
              type="button"
              onClick={() => setMoreOpen((v) => !v)}
              aria-label={t("kb.moreButton")}
              title={t("kb.moreButton")}
              aria-expanded={moreOpen}
              className="w-8 h-8 flex items-center justify-center rounded-full"
              style={{ border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--text-secondary)" }}
              data-testid="kb-more-menu"
            >
              ⋮
            </button>
            {moreOpen && (
              <div
                className="absolute right-0 z-50 mt-1.5 rounded-lg p-3"
                style={{
                  top: "100%",
                  width: 300,
                  background: "var(--surface-elevated)",
                  border: "1px solid var(--hairline)",
                  boxShadow: "0 6px 20px rgba(0,0,0,.12)",
                }}
                data-testid="kb-more-popup"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[calc(12px*var(--font-scale))] text-primary">
                    {t("kb.rerankLabel")}
                  </span>
                  <RerankSwitch
                    enabled={rerank.enabled}
                    onChange={(next) => void setRerankEnabled(next)}
                  />
                </div>
                <div className="flex items-center justify-between gap-2 mt-1.5">
                  <span
                    className="text-[calc(10.5px*var(--font-scale))]"
                    style={{
                      color:
                        rerank.status === "failed"
                          ? "var(--danger)"
                          : rerank.status === "ready"
                            ? "var(--success)"
                            : "var(--text-tertiary)",
                    }}
                    data-testid="kb-rerank-status"
                  >
                    {rerank.status === "downloading"
                      ? t("kb.rerankDownloading", { progress: rerank.progress ?? 0 })
                      : rerank.status === "ready"
                        ? t("kb.rerankReady")
                        : rerank.status === "failed"
                          ? t("kb.rerankFailed")
                          : rerank.enabled
                            ? // 开关已开但模型尚未加载（重启后恢复中）：idle 不能读作「未开启」，
                              // 否则与旁边的开关自身矛盾
                              t("kb.rerankPending")
                            : t("kb.rerankIdle")}
                  </span>
                  {rerank.status === "failed" && (
                    <button
                      type="button"
                      onClick={() => void retryRerank()}
                      className="px-1.5 py-0.5 rounded text-[calc(10.5px*var(--font-scale))]"
                      style={{ border: "1px solid var(--hairline)" }}
                      data-testid="kb-rerank-retry"
                    >
                      {t("kb.rerankRetry")}
                    </button>
                  )}
                </div>
                <div className="text-tertiary text-[calc(10px*var(--font-scale))] mt-2">
                  {t("kb.rerankHint")}
                </div>
                <div style={{ borderTop: "1px solid var(--hairline)", marginTop: 8, paddingTop: 6 }}>
                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false);
                      setDoctorOpen(true);
                    }}
                    className="w-full text-left px-1 py-1.5 rounded-md text-[calc(12px*var(--font-scale))] text-primary hover:bg-surface"
                    style={{ border: "none", background: "transparent", cursor: "pointer" }}
                    data-testid="kb-doctor-open"
                  >
                    {t("kb.doctorOpen")}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
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
            onManageAgents={(kb) => setAgentsKb(kb)}
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
      {doctorOpen && <DoctorModal onClose={() => setDoctorOpen(false)} />}
      {agentsKb && <KbAgentsModal kb={agentsKb} onClose={() => setAgentsKb(null)} />}

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

/** 深度重排开关（页头「更多」菜单内）：role=switch 的原生按钮，状态由外部的 rerank.enabled 驱动 */
function RerankSwitch({ enabled, onChange }: { enabled: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={() => onChange(!enabled)}
      className="relative shrink-0"
      style={{
        width: 34,
        height: 20,
        borderRadius: 9999,
        background: enabled ? "var(--brand)" : "var(--hairline-strong)",
        transition: "background 0.2s",
        border: "none",
        padding: 0,
        cursor: "pointer",
      }}
      data-testid="kb-rerank-toggle"
    >
      <span
        className="absolute rounded-full bg-white transition-all"
        style={{
          width: 16,
          height: 16,
          top: 2,
          left: enabled ? undefined : 2,
          right: enabled ? 2 : undefined,
          boxShadow: "0 1px 2px rgba(0,0,0,.1)",
        }}
      />
    </button>
  );
}
