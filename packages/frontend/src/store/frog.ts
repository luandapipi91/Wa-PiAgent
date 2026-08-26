// 任务完成青蛙动画的全局状态：MessageList 订阅 current 渲染，触发方写入。
// 仅依赖 util/frog 的类型（纯 type import，运行时无环形依赖）。
import { create } from "zustand";
import type { FrogCorner, FrogPose } from "../util/frog";

/** 一次青蛙动画的完整参数（随机姿势 + 随机聊天区角落 + 触发会话）。 */
export interface FrogBurst {
	id: number;
	pose: FrogPose;
	corner: FrogCorner;
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
