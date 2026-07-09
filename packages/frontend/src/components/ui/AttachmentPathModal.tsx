import { useState } from "react";
import { Modal } from "./Modal";

interface Props {
  fileName: string;
  onConfirm: (path: string) => void;
  onCancel: () => void;
}

export function AttachmentPathModal({ fileName, onConfirm, onCancel }: Props) {
  const [path, setPath] = useState("");

  return (
    <Modal onClose={onCancel} width={480}>
      <div className="p-4">
        <h3 className="text-sm font-bold text-primary mb-2">补填文件绝对路径</h3>
        <p className="text-xs text-secondary mb-3">浏览器无法直接获取本地路径，请填写 {fileName} 的完整路径。</p>
        <input
          data-testid="path-input"
          value={path}
          onChange={e => setPath(e.target.value)}
          placeholder="/Users/xxx/project/a.txt"
          className="w-full px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none mb-3"
        />
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-xs border border-hairline rounded-sm">取消</button>
          <button
            data-testid="confirm-path"
            disabled={!path.trim()}
            onClick={() => onConfirm(path.trim())}
            className="px-3 py-1.5 text-xs border-0 rounded-sm disabled:opacity-50"
            style={{ background: "var(--brand)", color: "var(--on-brand)" }}
          >确认</button>
        </div>
      </div>
    </Modal>
  );
}
