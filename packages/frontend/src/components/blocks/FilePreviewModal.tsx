import { useSessionStore } from "../../store/session";
import { Modal } from "../ui/Modal";
import { FileViewer } from "./FileViewer";

/** 全局文件预览弹窗：渲染在 App 根（常驻挂载点），从 session store 读取 filePreview。
 *  状态提升到 store 而非 FilePill/SessionView 本地 useState——宿主组件（消息行、委派卡、
 *  轮级折叠段）在流式结束/折叠/卸载时销毁，预览窗不会被连带关闭；
 *  只有用户手动关闭（✕ / ESC / 遮罩点击）才消失。 */
export function FilePreviewModal() {
 const preview = useSessionStore((s) => s.filePreview);
 if (!preview) return null;
 const close = () => useSessionStore.getState().closeFilePreview();
 return (
  <Modal
   onClose={close}
   width="80vw"
   height="80vh"
   closeOnOverlayClick
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
