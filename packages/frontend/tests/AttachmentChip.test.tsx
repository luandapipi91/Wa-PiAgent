import { test, expect, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { AttachmentChip } from "../src/components/ui/AttachmentChip";
import type { AttachmentDraft } from "@wa-pi/shared";

test("renders file name and calls onRemove", () => {
	const onRemove = mock();
	render(
		<AttachmentChip
			attachment={{
				kind: "file",
				name: "a.txt",
				path: "/tmp/a.txt",
				size: 100,
			}}
			onRemove={onRemove}
		/>,
	);
	expect(screen.getByText("a.txt")).toBeTruthy();
	fireEvent.click(screen.getByTestId("attachment-remove"));
	expect(onRemove).toHaveBeenCalled();
});

test("snippet content is truncated beyond 20 characters", () => {
	const onRemove = mock();
	const longContent =
		"this is a very long snippet text that should be truncated";
	render(
		<AttachmentChip
			attachment={{
				kind: "snippet",
				name: "long-snippet",
				content: longContent,
			}}
			onRemove={onRemove}
		/>,
	);
	expect(screen.getByText(longContent.slice(0, 20) + "…")).toBeTruthy();
});

test("folder attachment renders folder icon", () => {
	const onRemove = mock();
	render(
		<AttachmentChip
			attachment={{ kind: "folder", name: "docs", path: "/tmp/docs" }}
			onRemove={onRemove}
		/>,
	);
	const chip = screen.getByText("docs").parentElement;
	// 图标已 SVG 化（Icon 组件），不再渲染 emoji
	expect(chip?.querySelector("svg")).toBeTruthy();
	expect(chip?.textContent).not.toContain("📁");
});

test("image attachment renders camera icon", () => {
	const onRemove = mock();
	render(
		<AttachmentChip
			attachment={{
				kind: "image",
				name: "cat.png",
				path: "/tmp/cat.png",
				size: 1024,
			}}
			onRemove={onRemove}
		/>,
	);
	const chip = screen.getByText("cat.png").parentElement;
	// 图标已 SVG 化（Icon 组件），不再渲染 emoji
	expect(chip?.querySelector("svg")).toBeTruthy();
	expect(chip?.textContent).not.toContain("📷");
});

test("remove button has accessible label and type button", () => {
	const onRemove = mock();
	render(
		<AttachmentChip
			attachment={{
				kind: "file",
				name: "a.txt",
				path: "/tmp/a.txt",
				size: 100,
			}}
			onRemove={onRemove}
		/>,
	);
	const removeButton = screen.getByLabelText("移除附件");
	expect(removeButton.tagName).toBe("BUTTON");
	expect((removeButton as HTMLButtonElement).type).toBe("button");
});

test("audio chip 渲染文件名 + 麦克风图标 + 移除按钮，不渲染 <audio>", () => {
	const a: AttachmentDraft = {
		kind: "audio",
		name: "录音 0:02.webm",
		path: "/p/.wa-pi/uploads/rec.webm",
		size: 10,
		durationMs: 2000,
	};
	const onRemove = () => {};
	render(<AttachmentChip attachment={a} onRemove={onRemove} />);
	expect(screen.getByText("录音 0:02.webm")).toBeTruthy();
	const chip = screen.getByTestId("attachment-chip");
	// 图标已 SVG 化（Icon 组件），不再渲染 emoji
	expect(chip.querySelector("svg")).toBeTruthy();
	expect(chip.textContent).not.toContain("🎤");
	expect(document.querySelector("audio")).toBeNull();
	expect(screen.getByLabelText("移除附件")).toBeTruthy();
});

test("非 audio（file）chip 不渲染 <audio>", () => {
	const a: AttachmentDraft = {
		kind: "file",
		name: "a.txt",
		path: "/p/a.txt",
		size: 1,
	};
	render(<AttachmentChip attachment={a} onRemove={() => {}} />);
	expect(document.querySelector("audio")).toBeNull();
});

// === 点击 chip 打开文件预览 ===

test("传入 onClick 时，点击 chip 本体触发 onClick", () => {
	const onClick = mock();
	render(
		<AttachmentChip
			attachment={{
				kind: "file",
				name: "a.txt",
				path: "/tmp/a.txt",
				size: 100,
			}}
			onRemove={mock()}
			onClick={onClick}
		/>,
	);
	fireEvent.click(screen.getByTestId("attachment-chip"));
	expect(onClick).toHaveBeenCalled();
});

// === 图片缩略图 + i18n 编号 ===
// 系统剪贴板位图被浏览器统一命名为 image.png，多张重名时分不清；
// 图片附件改为按顺序显示「图片N」，并渲染真实缩略图。

test("图片附件显示 i18n 编号与缩略图，不再显示 image.png", () => {
	render(
		<AttachmentChip
			attachment={{
				kind: "image",
				name: "image.png",
				path: "/tmp/image.png",
				size: 1,
			}}
			imageOrdinal={2}
			thumbnailSrc="/file?path=%2Ftmp%2Fimage.png"
			onRemove={() => {}}
		/>,
	);
	const chip = screen.getByTestId("attachment-chip");
	expect(chip.textContent).toContain("图片2");
	expect(chip.textContent).not.toContain("image.png");
	// 原始文件名保留在 title 里可查
	expect(chip.getAttribute("title")).toBe("image.png");
	const img = screen.getByTestId("attachment-thumb") as HTMLImageElement;
	expect(img.tagName).toBe("IMG");
	expect(img.getAttribute("src")).toBe("/file?path=%2Ftmp%2Fimage.png");
	expect(img.getAttribute("alt")).toBe("图片2");
	// 缩略图模式下不再渲染占位图标
	expect(chip.querySelector("svg")).toBeNull();
});

test("缩略图加载失败回退为图标，编号保留", () => {
	render(
		<AttachmentChip
			attachment={{
				kind: "image",
				name: "image.png",
				path: "/tmp/image.png",
				size: 1,
			}}
			imageOrdinal={1}
			thumbnailSrc="/file?path=%2Ftmp%2Fmissing.png"
			onRemove={() => {}}
		/>,
	);
	fireEvent.error(screen.getByTestId("attachment-thumb"));
	expect(screen.queryByTestId("attachment-thumb")).toBeNull();
	const chip = screen.getByTestId("attachment-chip");
	expect(chip.querySelector("svg")).toBeTruthy();
	expect(chip.textContent).toContain("图片1");
});

test("无缩略图地址的图片仍回退图标 + 文件名，并可移除", () => {
	const onRemove = mock();
	render(
		<AttachmentChip
			attachment={{
				kind: "image",
				name: "cat.png",
				path: "/tmp/cat.png",
				size: 1,
			}}
			onRemove={onRemove}
		/>,
	);
	expect(screen.getByText("cat.png")).toBeTruthy();
	expect(document.querySelector("img")).toBeNull();
	fireEvent.click(screen.getByTestId("attachment-remove"));
	expect(onRemove).toHaveBeenCalled();
});

test("点击删除按钮不触发 chip 的 onClick", () => {
	const onClick = mock();
	const onRemove = mock();
	render(
		<AttachmentChip
			attachment={{
				kind: "file",
				name: "a.txt",
				path: "/tmp/a.txt",
				size: 100,
			}}
			onRemove={onRemove}
			onClick={onClick}
		/>,
	);
	fireEvent.click(screen.getByTestId("attachment-remove"));
	expect(onRemove).toHaveBeenCalled();
	expect(onClick).not.toHaveBeenCalled();
});
