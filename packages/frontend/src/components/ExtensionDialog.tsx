import { useState } from "react";
import { api } from "../api-client";
import { Modal } from "./ui/Modal";
import { useExtDialogStore, type ExtDialogRequest } from "../store/ext-dialog";
import { useTranslation } from "../i18n/useTranslation";

// pi 扩展 dialog 弹窗（select/confirm/input/editor）：kernel 把 pi 的 extension_ui_request
// 桥接为 sdk:event(extension_dialog) 写入 ext-dialog store 队列，本组件逐个展示队首；
// 应答统一 POST /api/extensions/dialog/respond（失败静默：pi 侧请求自带 timeout 兜底）。
export function ExtensionDialog() {
    const current = useExtDialogStore((s) => s.queue[0]);
    if (!current) return null;

    // 先弹出队列再 POST：同一请求绝不重复应答（双击与按钮竞态）
    const respond = async (fields: {
        value?: unknown;
        confirmed?: boolean;
        cancelled?: boolean;
    }) => {
        const cur = useExtDialogStore.getState().queue[0];
        useExtDialogStore.getState().resolveCurrent();
        if (!cur) return;
        await api
            .post("/api/extensions/dialog/respond", {
                requestId: cur.requestId,
                ...fields,
            })
            .catch(() => {});
    };

    // 遮罩点击/ESC 不取消：pi handler 在等应答，误触关闭会让扩展拿到意外的 cancelled；
    // 只有显式点「取消」按钮才取消（产品决策）
    return (
        <Modal
            onClose={() => void respond({ cancelled: true })}
            width={480}
            closeOnOverlayClick={false}
            closeOnEsc={false}
            data-testid="ext-dialog"
        >
            {/* key=requestId：下一个请求展示时重置内部输入状态 */}
            <DialogBody
                key={current.requestId}
                req={current}
                respond={respond}
            />
        </Modal>
    );
}

function DialogBody({
    req,
    respond,
}: {
    req: ExtDialogRequest;
    respond: (fields: {
        value?: unknown;
        confirmed?: boolean;
        cancelled?: boolean;
    }) => Promise<void>;
}) {
    // editor 用 prefill 预填；input 从空开始（placeholder 仅提示）
    const [text, setText] = useState(
        req.method === "editor" ? (req.prefill ?? "") : "",
    );
    const { t } = useTranslation();

    const footer = (
        <div className="flex justify-end gap-2 p-3 border-t border-hairline">
            <button
                onClick={() => void respond({ cancelled: true })}
                className="px-3 py-1.5 rounded-sm text-sm bg-surface-hover text-secondary border border-hairline transition-colors hover:text-primary"
                data-testid="ext-dialog-cancel"
            >
                {t("common.cancel")}
            </button>
            <button
                onClick={() =>
                    void respond(
                        req.method === "confirm"
                            ? { confirmed: true }
                            : { value: text },
                    )
                }
                className="px-3 py-1.5 rounded-sm text-sm border-0 cursor-pointer"
                style={{ background: "var(--brand)", color: "var(--on-brand)" }}
                data-testid="ext-dialog-ok"
            >
                {t("common.confirm")}
            </button>
        </div>
    );

    return (
        <>
            <div className="p-4 border-b border-hairline flex items-center justify-between">
                <div className="text-primary font-bold text-sm">
                    {req.title ?? ""}
                </div>
                <button
                    onClick={() => void respond({ cancelled: true })}
                    className="text-tertiary text-xs"
                    data-testid="ext-dialog-close"
                    aria-label={t("common.close")}
                >
                    ✕
                </button>
            </div>
            <div className="p-4 text-sm text-secondary leading-relaxed flex flex-col gap-3">
                {req.message && <div>{req.message}</div>}
                {req.method === "select" && (
                    <div className="flex flex-col gap-2">
                        {(req.options ?? []).map((opt) => (
                            <button
                                key={opt}
                                onClick={() => void respond({ value: opt })}
                                className="px-3 py-2 rounded-sm text-sm text-left bg-surface-hover text-secondary border border-hairline transition-colors hover:text-primary"
                                data-testid="ext-dialog-option"
                            >
                                {opt}
                            </button>
                        ))}
                    </div>
                )}
                {req.method === "input" && (
                    <input
                        value={text}
                        placeholder={req.placeholder}
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter")
                                void respond({ value: text });
                        }}
                        className="px-2 py-1.5 rounded-sm text-sm bg-surface text-primary border border-hairline outline-none"
                        data-testid="ext-dialog-input"
                        autoFocus
                    />
                )}
                {req.method === "editor" && (
                    <textarea
                        value={text}
                        placeholder={req.placeholder}
                        onChange={(e) => setText(e.target.value)}
                        rows={10}
                        className="px-2 py-1.5 rounded-sm text-sm bg-surface text-primary border border-hairline outline-none resize-y font-mono"
                        data-testid="ext-dialog-editor"
                        autoFocus
                    />
                )}
            </div>
            {/* select 无「确认」（点选项即应答），但仍需「取消」——遮罩/ESC 已禁用，这是唯一取消路径 */}
            {req.method === "select" ? (
                <div className="flex justify-end gap-2 p-3 border-t border-hairline">
                    <button
                        onClick={() => void respond({ cancelled: true })}
                        className="px-3 py-1.5 rounded-sm text-sm bg-surface-hover text-secondary border border-hairline transition-colors hover:text-primary"
                        data-testid="ext-dialog-cancel"
                    >
                        {t("common.cancel")}
                    </button>
                </div>
            ) : (
                footer
            )}
        </>
    );
}
