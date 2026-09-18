import { useState } from "react";
import { api } from "../api-client";
import { Modal } from "./ui/Modal";
import { Markdown } from "./blocks/Markdown";
import { normalizeDialogText } from "../lib/ext-dialog-text";
import { useExtDialogStore, type ExtDialogRequest } from "../store/ext-dialog";
import { useTranslation } from "../i18n/useTranslation";

// pi 扩展 dialog 弹窗（select/confirm/input/editor）：kernel 把 pi 的 extension_ui_request
// 桥接为 sdk:event(extension_dialog) 写入 ext-dialog store 队列（带 sessionId），本组件挂在 SessionView 内只展示当前会话的请求（与 ask 同款会话锁定）；
// 应答统一 POST /api/extensions/dialog/respond（失败静默：pi 侧请求自带 timeout 兜底）。
export function ExtensionDialog({ sessionId }: { sessionId: string }) {
    const current = useExtDialogStore((s) =>
        s.queue.find((d) => d.sessionId === sessionId),
    );
    if (!current) return null;

    // 先弹出队列再 POST：同一请求绝不重复应答（双击与按钮竞态）
    const respond = async (fields: {
        value?: unknown;
        confirmed?: boolean;
        cancelled?: boolean;
    }) => {
        const store = useExtDialogStore.getState();
        // guard: already resolved (double click) - resolve by id, keep other sessions pending
        if (!store.queue.some((d) => d.requestId === current.requestId)) return;
        store.resolveById(current.requestId);
        await api
            .post("/api/extensions/dialog/respond", {
                requestId: current.requestId,
                ...fields,
            })
            .catch(() => {});
    };

    // 遮罩点击/ESC 不取消：pi handler 在等应答，误触关闭会让扩展拿到意外的 cancelled；
    // 只有显式点「取消」按钮才取消（产品决策）
    return (
        <Modal
            onClose={() => void respond({ cancelled: true })}
            width="60%"
            // 限高视口 80%：长消息/长选项列表在卡内滚动，不再垂直溢出屏幕
            maxHeight="80vh"
            closeOnOverlayClick={false}
            closeOnEsc={false}
            data-testid="ext-dialog"
        >
            {/* key=requestId：下一个请求展示时重置内部输入状态 */}
            <DialogBody
                key={current.requestId}
                req={current}
                sessionId={sessionId}
                respond={respond}
            />
        </Modal>
    );
}

function DialogBody({
    req,
    sessionId,
    respond,
}: {
    req: ExtDialogRequest;
    sessionId: string;
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
        <div className="flex justify-end gap-2 p-3 border-t border-hairline shrink-0">
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
            <div className="p-4 border-b border-hairline flex items-start justify-between gap-2 shrink-0">
                {/*
                 * 头部标题同样限高自滚：pi 的 select 把长长的 prompt 就放在 title 里
                 * （截图里那坨几十行目标草案），不限高就会把卡片撑满、把选项与按钮
                 * 整个挤出卡片（卡片 overflow-hidden，滚都滚不到）。
                 */}
                <div
                    data-testid="ext-dialog-title"
                    className="text-primary font-bold text-sm max-h-[40vh] overflow-y-auto break-words whitespace-pre-wrap"
                >
                    {/* 统一 markdown 组件：transformText 把 pi 的终端排版（`│   ` 前缀 /
                        `─── X ───` 分节线）还原成 markdown，否则被前缀挡住的表格/清单/标题
                        一个都解析不出来；sessionId 让链接/图片经会话内预览组件才点得动。 */}
                    <Markdown
                        text={req.title ?? ""}
                        sessionId={sessionId}
                        transformText={normalizeDialogText}
                        testId={null}
                    />
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
            {/*
             * 正文区 = 卡片里**唯一**的滚动区（flex-1 + min-h-0 + overflow-y-auto）。
             * 正文是唯一可让出高度的东西：它再长也只压自己、内部滚动，
             * 不会把下面的选项/按钮推出视野，也不会把按钮压成一条缝
             * （flex 列容器里默认 flex-shrink:1，不隔离就会两个一起被挤）。
             */}
            {req.message && (
                <div
                    data-testid="ext-dialog-message"
                    className="p-4 text-sm text-secondary leading-relaxed flex-1 min-h-0 overflow-y-auto whitespace-pre-wrap"
                >
                    <Markdown
                        text={req.message}
                        sessionId={sessionId}
                        transformText={normalizeDialogText}
                        testId={null}
                    />
                </div>
            )}
            {/*
             * 决策区：选项 / 输入框 / 编辑器，固定在底部按钮上方。
             * shrink-0：正文再长也不参与压缩；选项本身超长时由列表自己滚（带限高），
             * 不让「取消」被挤出卡片。
             */}
            <div
                data-testid="ext-dialog-actions"
                className="px-4 pb-3 pt-3 flex flex-col gap-2 shrink-0"
            >
                {req.method === "select" && (
                    <div
                        data-testid="ext-dialog-options"
                        className="flex flex-col gap-2 max-h-[40vh] overflow-y-auto"
                    >
                        {(req.options ?? []).map((opt) => (
                            <button
                                key={opt}
                                onClick={() => void respond({ value: opt })}
                                className="px-3 py-2 rounded-sm text-sm text-left bg-surface-hover text-secondary border border-hairline transition-colors hover:text-primary shrink-0"
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
                        className="px-2 py-1.5 rounded-sm text-sm bg-surface text-primary border border-hairline outline-none resize-y font-mono max-h-[40vh] overflow-y-auto"
                        data-testid="ext-dialog-editor"
                        autoFocus
                    />
                )}
            </div>
            {/* select 无「确认」（点选项即应答），但仍需「取消」——遮罩/ESC 已禁用，这是唯一取消路径 */}
            {req.method === "select" ? (
                <div className="flex justify-end gap-2 p-3 border-t border-hairline shrink-0">
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
