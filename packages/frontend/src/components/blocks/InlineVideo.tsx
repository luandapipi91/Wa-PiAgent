import { useState } from "react";
import { useSessionStore } from "../../store/session";
import { useTranslation } from "../../i18n/useTranslation";
import { Icon } from "../ui/Icon";
import { FilePill } from "./FilePill";
import { MarkdownLink } from "./markdown-components";
import { resolveMediaSrc, type MediaItem } from "./media-utils";

// ⚠️ 循环依赖约束同 MarkdownImage 头部注释。

/** 视频段落内联播放器：原生 <video controls preload="metadata"> 限高 320px + 右上角放大按钮；
 *  加载失败降级 FilePill（本地）/普通链接（远程）。 */
export function InlineVideo({
	src,
	name,
	sessionId,
	items,
}: {
	src: string;
	name: string;
	sessionId: string;
	items: MediaItem[];
}) {
	const [failed, setFailed] = useState(false);
	const { t } = useTranslation();
	const isRemote = /^(https?:|data:|blob:)/i.test(src);
	if (failed) {
		return isRemote ? (
			<MarkdownLink href={src}>{name}</MarkdownLink>
		) : (
			<FilePill rawText={src} sessionId={sessionId} />
		);
	}
	const open = () => {
		const idx = items.findIndex((it) => it.src === src && it.kind === "video");
		const list = idx >= 0 ? items : [{ src, kind: "video" as const, name }];
		useSessionStore
			.getState()
			.openMediaPreview(list, idx >= 0 ? idx : 0, sessionId);
	};
	return (
		<span className="group relative block max-w-full my-1" data-testid="inline-video">
			<video
				controls
				preload="metadata"
				src={resolveMediaSrc(src, sessionId)}
				onError={() => setFailed(true)}
				className="max-h-[320px] max-w-full rounded-md border border-hairline bg-black"
			/>
			<button
				type="button"
				title={t("blocks.fileViewer.zoomIn")}
				data-testid="inline-video-zoom"
				onClick={open}
				className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center justify-center w-6 h-6 rounded bg-black/55 text-white hover:bg-black/70"
			>
				<Icon name="plus" size={13} />
			</button>
		</span>
	);
}
