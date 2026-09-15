// compaction-guard.extension.ts —— 压缩守卫扩展入口（静态扩展文件）
//
// 本文件由 deployCompactionGuardExtension() 复制到
// GENERATED_DIR/compaction-guard.ts，pi 子进程经 -e 加载。
//
// 为什么接管压缩：pi 内置摘要的输出预算是 `0.8 × reserveTokens`（默认 16384 → 13107），
// 长会话写详尽摘要必然被输出上限截断，而 pi ≥0.85 把 `stopReason === "length"` 判为失败、
// 整份作废且每轮重试，表现为「压缩失败」刷屏死循环（pi issue #8371 / #8196）。
//
// 本扩展改为：按模型能力动态算输出预算；输入超窗口时裁剪；被截断时按上限采用。
// 任何无法可靠完成的情形都回退 pi 内置压缩（返回 undefined）。
// 行为逻辑在 ./compaction-guard-core.ts（纯逻辑，便于单测）。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	convertToLlm,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { createCompactionGuardHandler } from "./compaction-guard-core.ts";

export default function (pi: ExtensionAPI) {
	pi.on(
		"session_before_compact",
		createCompactionGuardHandler({
			serialize: (messages) =>
				serializeConversation(convertToLlm(messages as never)),
		}) as never,
	);
}
