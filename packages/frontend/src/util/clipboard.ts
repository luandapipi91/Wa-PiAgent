// 跨平台复制：Electron 用原生 clipboard API，浏览器用 navigator.clipboard
// window.waPiClipboard 由桌面 preload.cjs 通过 contextBridge 注入

declare global {
	interface Window {
		waPiClipboard?: {
			writeText: (text: string) => void;
			writeImage: (base64Png: string) => void;
		};
		// 桌面 preload 注入：大文件附件降级为路径引用时取 File 真实路径
		waPiApp?: {
			getPathForFile?: (file: File) => string;
			getLoginItem?: () => Promise<boolean>;
			setLoginItem?: (enabled: boolean) => Promise<boolean>;
			showOpenFileDialog?: () => Promise<string[]>;
			showOpenDirectoryDialog?: () => Promise<string | null>;
			showItemInFolder?: (filePath: string) => Promise<boolean>;
		};
	}
}

export async function copyToClipboard(text: string): Promise<void> {
	if (window.waPiClipboard) {
		// Electron 原生 clipboard（同步，最可靠）
		window.waPiClipboard.writeText(text);
	} else {
		await navigator.clipboard.writeText(text);
	}
}

export async function copyImageToClipboard(pngBlob: Blob): Promise<void> {
	if (window.waPiClipboard) {
		// 转 base64 后通过 Electron 原生 clipboard
		const buf = await pngBlob.arrayBuffer();
		const bytes = new Uint8Array(buf);
		let binary = "";
		for (let i = 0; i < bytes.length; i++)
			binary += String.fromCharCode(bytes[i]);
		const base64 = btoa(binary);
		window.waPiClipboard.writeImage(base64);
	} else {
		await navigator.clipboard.write([
			new ClipboardItem({ "image/png": pngBlob }),
		]);
	}
}

/** 任意图片 URL（http/data/blob）→ PNG Blob：非 PNG 经 canvas 重编码（剪贴板只保证支持 PNG）。
 *  SVG/跨域受限图片 canvas 可能失败，由调用方 catch 后 toast 提示。 */
export async function imageUrlToPngBlob(src: string): Promise<Blob> {
	const blob = await (await fetch(src)).blob();
	if (blob.type === "image/png") return blob;
	const bitmap = await createImageBitmap(blob);
	const canvas = document.createElement("canvas");
	canvas.width = bitmap.width;
	canvas.height = bitmap.height;
	canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
	bitmap.close();
	return await new Promise<Blob>((resolve, reject) =>
		canvas.toBlob(
			(b) => (b ? resolve(b) : reject(new Error("canvas 转 PNG 失败"))),
			"image/png",
		),
	);
}
