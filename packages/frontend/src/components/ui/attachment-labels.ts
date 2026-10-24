import type { AttachmentDraft } from "@wa-pi/shared";

/** 图片附件在列表中的序号（1-based，仅对图片计数）；非图片项为 undefined。
 *
 *  用途：系统剪贴板里的位图被浏览器统一命名成 image.png，一次粘贴多张时全部重名，
 *  展示层无法区分。图片改为按出现顺序显示 i18n「图片N」，原始文件名保留在 chip 的 title。 */
export function imageOrdinals(
	attachments: AttachmentDraft[],
): (number | undefined)[] {
	let n = 0;
	return attachments.map((a) => (a.kind === "image" ? (n += 1) : undefined));
}
