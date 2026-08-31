// 任务完成青蛙动画的全局状态：MessageList 订阅 current 渲染，触发方写入。
// 仅依赖 util/frog 的类型（纯 type import，运行时无环形依赖）。
import { create } from "zustand";
import type { FrogSpot, FrogVariant } from "../util/frog";

/** 一次青蛙动画的完整参数（随机变体 + 随机聊天区位置 + 触发会话）。 */
export interface FrogBurst {
	id: number;
	/** 动画变体（19 种之一）。 */
	variant: FrogVariant;
	/** 聊天区出现位置（8 处之一）。 */
	spot: FrogSpot;
	/** 触发的会话 ID：用于判断是否只在当前会话的聊天区显示。 */
	sessionId: string;
	createdAt: number;
}

interface FrogState {
	/** 当前待展示的青蛙；null = 无。 */
	current: FrogBurst | null;
	setCurrent: (b: FrogBurst) => void;
	clear: () => void;
}

export const useFrogStore = create<FrogState>()((set) => ({
	current: null,
	setCurrent: (b) => set({ current: b }),
	clear: () => set({ current: null }),
}));
