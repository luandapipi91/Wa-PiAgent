// KbFailedModal — 失败文件清单弹窗（任务 B4）。
//
// 挂载即 GET /api/knowledge/:id/failed（kernel 进程内最近一轮索引的失败清单），
// 渲染路径 + 原因两列；KbList 的失败徽章点击（onShowFailed，B2 占位回调）由
// KnowledgePage 接入打开本弹窗。请求失败在弹窗内回显错误（局部错误局部显示）。
import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { api } from "../../api-client";
import { formatApiError } from "../../util/kernel-error";
import { useTranslation } from "../../i18n/useTranslation";

/** kernel KbFailure：抽取阶段失败的文件路径 + 原因摘要 */
interface KbFailure {
  path: string;
  reason: string;
}

interface Props {
  kbId: string;
  /** 弹窗标题里的库名（取不到时调用方回退 kbId） */
  kbName: string;
  onClose: () => void;
}

export function KbFailedModal({ kbId, kbName, onClose }: Props) {
  const { t } = useTranslation();
  // null = 加载中；[] = 无失败；非空 = 清单
  const [failures, setFailures] = useState<KbFailure[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .get(`/api/knowledge/${encodeURIComponent(kbId)}/failed`)
      .then((data: any) => {
        if (alive)
          setFailures(Array.isArray(data?.failures) ? data.failures : []);
      })
      .catch((e) => {
        if (alive) setError(formatApiError(e));
      });
    return () => {
      alive = false;
    };
  }, [kbId]);

  return (
    <Modal onClose={onClose} width={560} data-testid="kb-failed-modal">
      <div
        className="px-4 py-3 flex items-center justify-between"
        style={{ borderBottom: "1px solid var(--hairline)" }}
      >
        <span className="text-primary font-bold text-sm">
          {t("kb.failedTitle", { name: kbName })}
        </span>
        <button
          onClick={onClose}
          className="text-[calc(11px*var(--font-scale))] font-medium px-2 py-0.5 rounded-md"
          style={{
            background: "transparent",
            border: "1px solid var(--hairline)",
            color: "var(--text-secondary)",
            cursor: "pointer",
          }}
        >
          {t("kb.close")}
        </button>
      </div>
      <div
        className="px-4 py-3 overflow-y-auto"
        style={{ maxHeight: "60vh" }}
        data-testid="kb-failed-list"
      >
        {error ? (
          <div
            className="text-[calc(12px*var(--font-scale))]"
            style={{ color: "var(--danger)" }}
            data-testid="kb-failed-error"
          >
            {error}
          </div>
        ) : failures === null ? (
          <div className="text-center text-tertiary text-[calc(12.5px*var(--font-scale))] py-6">
            {t("kb.loading")}
          </div>
        ) : failures.length === 0 ? (
          <div
            className="text-center text-tertiary text-[calc(12.5px*var(--font-scale))] py-6"
            data-testid="kb-failed-empty"
          >
            {t("kb.failedEmpty")}
          </div>
        ) : (
          <ul className="m-0 p-0 list-none">
            {failures.map((f) => (
              <li
                key={f.path}
                className="mb-2 p-2.5 rounded-md"
                style={{
                  background: "var(--canvas)",
                  border: "1px solid var(--hairline)",
                }}
                data-testid="kb-failed-item"
              >
                <div
                  className="text-[calc(11.5px*var(--font-scale))] text-primary font-medium truncate"
                  title={f.path}
                >
                  📄 {f.path}
                </div>
                <div
                  className="text-[calc(11px*var(--font-scale))] mt-0.5"
                  style={{ color: "var(--warning)" }}
                >
                  {f.reason}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
