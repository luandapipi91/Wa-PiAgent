import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "../../i18n/useTranslation";

interface Props {
    /** 目标编辑区元素引用：mousedown 时读取其实际高度作为拖拽起始值 */
    targetRef: React.RefObject<HTMLDivElement | null>;
    /** 拖拽中实时回调新高度（未 clamp；clamp/持久化由调用方负责） */
    onResize: (height: number) => void;
    testId?: string;
}

/**
 * 输入框顶部拖拽手柄（纵向版 SidebarResizer 模式）：
 * mousedown 记录 startY/startHeight → window 级 mousemove 实时回调
 * startHeight + (startY - clientY)（向上拖变高）→ mouseup 清理。
 * 视觉为圆角盒上边框中央的胶囊小横条，平时浅灰、hover 变主题色。
 */
export function ComposerResizeHandle({ targetRef, onResize, testId }: Props) {
    const { t } = useTranslation();
    const startY = useRef(0);
    const startHeight = useRef(0);

    const onMouseMove = useCallback(
        (e: MouseEvent) => {
            onResize(startHeight.current + (startY.current - e.clientY));
        },
        [onResize],
    );

    const onMouseUp = useCallback(() => {
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
    }, [onMouseMove]);

    const onMouseDown = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            const el = targetRef.current;
            if (!el) return;
            startY.current = e.clientY;
            startHeight.current = el.getBoundingClientRect().height;
            document.body.style.userSelect = "none";
            document.body.style.cursor = "row-resize";
            window.addEventListener("mousemove", onMouseMove);
            window.addEventListener("mouseup", onMouseUp);
        },
        [targetRef, onMouseMove, onMouseUp],
    );

    // 组件卸载时兜底清理（拖拽中卸载的极端场景；正常路径 mouseup 已移除）
    useEffect(
        () => () => {
            window.removeEventListener("mousemove", onMouseMove);
            window.removeEventListener("mouseup", onMouseUp);
        },
        [onMouseMove, onMouseUp],
    );

    return (
        <div
            data-testid={testId}
            title={t("composer.resizeHint")}
            onMouseDown={onMouseDown}
            className="group absolute -top-[5px] left-1/2 z-10 flex h-[10px] w-14 -translate-x-1/2 cursor-row-resize items-center justify-center"
        >
            <div className="h-1 w-9 rounded-full bg-hairline transition-colors group-hover:bg-accent" />
        </div>
    );
}
