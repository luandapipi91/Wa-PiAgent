import { test, expect } from "bun:test";
import type { AttachmentDraft } from "@wa-pi/shared";
import { imageOrdinals } from "../src/components/ui/attachment-labels";

const img = (name: string, path = `/u/${name}`): AttachmentDraft => ({
	kind: "image",
	name,
	path,
	size: 1,
});

const file = (name: string): AttachmentDraft => ({
	kind: "file",
	name,
	path: `/u/${name}`,
	size: 1,
});

test("图片按出现顺序编号，非图片项不占号", () => {
	const list: AttachmentDraft[] = [
		img("image.png", "/u/image.png"),
		file("a.txt"),
		img("image.png", "/u/image-1.png"),
	];
	expect(imageOrdinals(list)).toEqual([1, undefined, 2]);
});

test("删除中间图片后剩余图片连续重新编号", () => {
	const list: AttachmentDraft[] = [
		img("image.png", "/u/image.png"),
		img("image.png", "/u/image-1.png"),
		img("image.png", "/u/image-2.png"),
	];
	// 删掉第 2 张（模拟 removeAttachment(1)）
	const afterRemove = [list[0], list[2]];
	expect(imageOrdinals(afterRemove)).toEqual([1, 2]);
});

test("没有图片时全部为 undefined（不改变其它附件展示）", () => {
	expect(imageOrdinals([file("a.txt"), file("b.txt")])).toEqual([
		undefined,
		undefined,
	]);
});

test("空列表返回空数组", () => {
	expect(imageOrdinals([])).toEqual([]);
});
