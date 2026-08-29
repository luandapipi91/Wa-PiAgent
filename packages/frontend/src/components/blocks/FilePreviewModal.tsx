import { useState } from "react";
import { useSessionStore } from "../../store/session";
import { Modal } from "../ui/Modal";
import { FileViewer } from "./FileViewer";

/** 全局文件预览弹窗：渲染在 App 根（常驻挂载点），从 session store 读取 filePreview。
 *  状态提升到 store 而非 FilePill/SessionView 本地 useState——宿主组件（消息行、委派卡、
 *  轮级折叠段）在流式结束/折叠/卸载时销毁，预览窗不会被连带关闭；
 *  只有用户手动关闭（✕ / ESC）才消失。点遮罩不关闭（防预览时误触阴影丢窗口）。
 *  右下角手柄可拖动调整大小，尺寸持久化到 localStorage，重开保持。 */

// 窗口尺寸持久化（参考浮动预览窗 floatRect 的 localStorage 持久化）
const SIZE_KEY = "hiagent.filePreview.size";

function readSavedSize(): { width: number | string; height: number | string } {
 try {
  const raw = localStorage.getItem(SIZE_KEY);
  if (!raw) return { width: "80vw", height: "80vh" };
  const s = JSON.parse(raw);
  if (typeof s?.width === "number" && typeof s?.height === "number") {
   return { width: s.width, height: s.height };
  }
 } catch {
  // 坏数据回落默认
 }
 return { width: "80vw", height: "80vh" };
}

function saveSize(size: { width: number; height: number }) {
 try {
  localStorage.setItem(SIZE_KEY, JSON.stringify(size));
 } catch {
  // localStorage 不可用（隐私模式等）时静默降级：本次会话内仍可拖动
 }
}

export function FilePreviewModal() {
 const preview = useSessionStore((s) => s.filePreview);
 // 尺寸在每次挂载（打开弹窗）时读一次，挂载期间保持稳定引用
 const [size] = useState(readSavedSize);
 if (!preview) return null;
 const close = () => useSessionStore.getState().closeFilePreview();
 return (
  <Modal
   onClose={close}
   width={size.width}
   height={size.height}
   resizable
   onResize={saveSize}
   data-testid="file-preview-modal"
  >
   <FileViewer
    path={preview.path}
    sessionId={preview.sessionId}
    onClose={close}
   />
  </Modal>
 );
}
