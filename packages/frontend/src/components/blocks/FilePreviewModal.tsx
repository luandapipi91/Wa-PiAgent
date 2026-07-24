import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { readFile } from "../../fs-client";
import { useToastStore } from "../../store/toast";

/** 文件只读预览：经 kernel fs 读取内容，可复制路径 */
export function FilePreviewModal({ absPath, onClose }: { absPath: string; onClose: () => void }) {
  const [state, setState] = useState<{ loading: boolean; content?: string; error?: string }>({ loading: true });
  const addToast = useToastStore(s => s.add);

  useEffect(() => {
    let alive = true;
    readFile(absPath)
      .then(r => { if (alive) setState({ loading: false, content: r.content }); })
      .catch(() => { if (alive) setState({ loading: false, error: `无法读取文件：${absPath}` }); });
    return () => { alive = false; };
  }, [absPath]);

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(absPath);
      addToast("已复制路径", "success");
    } catch {
      addToast("复制失败", "error");
    }
  };

  return (
    <Modal onClose={onClose} width={640}>
      {/* Modal 无 title prop：路径作为头部渲染在 children 内 */}
      <div data-testid="file-preview-modal" className="p-3">
        <div className="text-[12px] font-mono text-secondary break-all mb-2">{absPath}</div>
        {state.loading && <div className="text-tertiary text-[12px]">加载中…</div>}
        {state.error && <div className="text-danger text-[12px]">{state.error}</div>}
        {state.content != null && (
          <pre className="text-[12px] font-mono whitespace-pre-wrap max-h-[60vh] overflow-auto m-0">{state.content}</pre>
        )}
        <div className="flex justify-end mt-2">
          <button type="button" onClick={copyPath} className="text-[12px] text-secondary hover:text-primary border border-hairline rounded-pill px-2 py-0.5" style={{ cursor: "pointer" }}>
            复制路径
          </button>
        </div>
      </div>
    </Modal>
  );
}
