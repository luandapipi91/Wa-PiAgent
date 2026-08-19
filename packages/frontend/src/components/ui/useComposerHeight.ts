import { useState, useCallback } from "react";

/** localStorage 键：手动调整后的输入框高度（全局，所有会话共用） */
export const COMPOSER_HEIGHT_KEY = "wa-pi:composer-height";
/** 手动高度下限（px），避免误拖成一条缝 */
export const COMPOSER_MIN_HEIGHT = 120;
/** 手动高度上限占视口比例（保证消息区与 ask 浮层始终可见） */
export const COMPOSER_MAX_RATIO = 0.5;

export function clampComposerHeight(
    h: number,
    viewportHeight: number = window.innerHeight,
): number {
    const max = Math.floor(viewportHeight * COMPOSER_MAX_RATIO);
    return Math.max(COMPOSER_MIN_HEIGHT, Math.min(max, Math.round(h)));
}

/** 读取持久化高度；无记录或非法值返回 null（回落自然生长） */
export function loadComposerHeight(): number | null {
    try {
        const raw = localStorage.getItem(COMPOSER_HEIGHT_KEY);
        if (raw == null) return null;
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) return null;
        return clampComposerHeight(n);
    } catch {
        return null; // localStorage 不可用时静默降级
    }
}

/**
 * 输入框手动高度。height 为 null 表示用户未调整过，保持 CSS 自然生长；
 * setHeight 立即 clamp、更新 state 并写穿 localStorage（写穿而非拖拽结束才写，
 * 行为等价且实现更简单）。
 */
export function useComposerHeight() {
    const [height, setHeightState] = useState<number | null>(() =>
        loadComposerHeight(),
    );
    const setHeight = useCallback((h: number) => {
        const v = clampComposerHeight(h);
        setHeightState(v);
        try {
            localStorage.setItem(COMPOSER_HEIGHT_KEY, String(v));
        } catch {
            /* localStorage 不可用时静默降级 */
        }
    }, []);
    // 双击手柄重置：清除手动高度，回到自然生长（minHeight 60 / maxHeight 300）
    const resetHeight = useCallback(() => {
        setHeightState(null);
        try {
            localStorage.removeItem(COMPOSER_HEIGHT_KEY);
        } catch {
            /* localStorage 不可用时静默降级 */
        }
    }, []);
    return { height, setHeight, resetHeight };
}
