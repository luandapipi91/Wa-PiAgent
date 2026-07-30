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
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const base64 = btoa(binary);
    window.waPiClipboard.writeImage(base64);
  } else {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
  }
}
