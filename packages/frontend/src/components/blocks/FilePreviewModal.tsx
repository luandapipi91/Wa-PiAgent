import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { readFile, revealFile } from "../../fs-client";
import { useToastStore } from "../../store/toast";

/** kernel fs:readFile 的 content 为 base64（二进制安全），文本预览需解码为 UTF-8 */
function decodeBase64(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** 文件只读预览：经 kernel fs 读取内容，可复制路径。若后端 ENOENT 搜索命中，使用解析后路径。 */
export function FilePreviewModal({ absPath, onClose }: { absPath: string; onClose: () => void }) {
  const [state, setState] = useState<{ loading: boolean; content?: string; error?: string; resolvedPath?: string }>({ loading: true });
  const addToast = useToastStore(s => s.add);

  useEffect(() => {
    let alive = true;
    readFile(absPath)
      .then(r => { if (alive) setState({ loading: false, content: decodeBase64(r.content), resolvedPath: r.resolvedPath }); })
      .catch((err: unknown) => { if (alive) setState({ loading: false, error: `无法读取文件：${absPath}（${err instanceof Error ? err.message : '未知错误'}）` }); });
    return () => { alive = false; };
  }, [absPath]);

  const displayPath = state.resolvedPath ?? absPath;

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(displayPath);
      addToast("已复制路径", "success");
    } catch {
      addToast("复制失败", "error");
    }
  };

  return (
    <Modal onClose={onClose} width={640}>
      {/* Modal 无 title prop：路径作为头部渲染在 children 内 */}
      <div data-testid="file-preview-modal" className="p-3">
        <div className="text-[12px] font-mono text-secondary break-all mb-2">{displayPath}</div>
        {state.loading && <div className="text-tertiary text-[12px]">加载中…</div>}
        {state.error && <div className="text-danger text-[12px]">{state.error}</div>}
        {state.content != null && (
          <pre className="text-[12px] font-mono whitespace-pre-wrap max-h-[60vh] overflow-auto m-0">{state.content}</pre>
        )}
        <div className="flex justify-end mt-2 gap-2">
          <button type="button" onClick={() => { revealFile(displayPath).catch(() => addToast("打开失败", "error")); }} className="text-[12px] text-secondary hover:text-primary border border-hairline rounded-pill px-2 py-0.5" style={{ cursor: "pointer" }}>
            查看文件
          </button>
          <button type="button" onClick={copyPath} className="text-[12px] text-secondary hover:text-primary border border-hairline rounded-pill px-2 py-0.5" style={{ cursor: "pointer" }}>
            复制路径
          </button>
        </div>
      </div>
    </Modal>
  );
}
