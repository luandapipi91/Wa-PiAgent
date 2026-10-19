// kind-label.ts — 记忆层级（L1 画像 / L2 知识 / L3 执行）的展示映射
// 供 MemoryCard 的层标签与 MemoryPage 的层筛选共用，避免两处各写一份。
import type { MemoryKind } from "@wa-pi/shared";

/** 层级 → i18n key（文案见 locales/zh.ts 与 en.ts 的 memory.kind*） */
export const KIND_I18N_KEY: Record<MemoryKind, string> = {
	profile: "memory.kindProfile",
	knowledge: "memory.kindKnowledge",
	execution: "memory.kindExecution",
};

/** 层筛选 chip 的渲染顺序：L1 → L2 → L3 */
export const MEMORY_KINDS: MemoryKind[] = ["profile", "knowledge", "execution"];
