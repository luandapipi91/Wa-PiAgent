// 目录树选择器：react-complex-tree + kernel fs:listDir 懒加载。
import { useMemo, useState } from "react";
import {
  UncontrolledTreeEnvironment,
  Tree,
  type TreeItem,
  type TreeItemIndex,
} from "react-complex-tree";
import "react-complex-tree/lib/style-modern.css";
import { getRoots, listDir } from "../fs-client";

interface FsNodeData {
  path: string;
  name: string;
  isDir: boolean;
}

interface Props {
  onPick: (cwd: string) => void;
  onCancel: () => void;
}

function join(parent: string, name: string): string {
  if (parent.endsWith("\\") || parent.endsWith("/")) return parent + name;
  const sep = parent.includes("\\") ? "\\" : "/";
  return parent + sep + name;
}

export function DirTreePicker({ onPick, onCancel }: Props) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const dataProvider = useMemo(() => {
    const items: Record<TreeItemIndex, TreeItem<FsNodeData>> = {};
    let rootLoading: Promise<void> | null = null;

    // 确保 root item 已初始化（懒加载 + 去重）
    const ensureRoot = async () => {
      if (items["root"]) return;
      if (!rootLoading) {
        rootLoading = (async () => {
          const roots = await getRoots();
          const rootChildren: TreeItemIndex[] = roots.map((_, i) => `root_${i}`);
          items["root"] = { index: "root", children: rootChildren, isFolder: true, data: { path: "", name: "此电脑", isDir: true } };
          roots.forEach((r, i) => {
            const idx = `root_${i}`;
            items[idx] = { index: idx, children: undefined, isFolder: true, data: { path: r, name: r, isDir: true } };
          });
        })();
      }
      await rootLoading;
    };

    return {
      async getTreeItem(itemId: TreeItemIndex): Promise<TreeItem<FsNodeData>> {
        // root item：懒加载（等待异步初始化完成）
        if (itemId === "root") {
          await ensureRoot();
          return items["root"];
        }
        const existing = items[itemId];
        if (existing) {
          if (existing.children === undefined && existing.data?.isDir) {
            const entries = (await listDir(existing.data.path)).filter(e => e.isDir);
            existing.children = entries.map((_, i) => `${itemId}_${i}`);
            entries.forEach((e, i) => {
              items[`${itemId}_${i}`] = {
                index: `${itemId}_${i}`,
                children: e.isDir ? undefined : [],
                isFolder: e.isDir,
                data: { path: join(existing.data.path, e.name), name: e.name, isDir: e.isDir },
              };
            });
          }
          return existing;
        }
        return { index: itemId, children: [], data: { path: "", name: "?", isDir: false } };
      },
      onDidChangeTreeData() { return { dispose: () => {} }; },
    };
  }, []);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" data-testid="dir-picker">
      <div className="bg-base w-[600px] max-h-[80vh] rounded-lg flex flex-col">
        <div className="p-4 border-b border-surface0 text-text font-medium">
          选择项目目录
          {selectedPath && <span className="ml-3 text-xs text-blue font-mono">{selectedPath}</span>}
        </div>
        <div className="flex-1 overflow-auto p-2 text-text" style={{ minHeight: 320 }}>
          <UncontrolledTreeEnvironment<FsNodeData>
            dataProvider={dataProvider}
            viewState={{}}
            getItemTitle={(item) => item.data.name}
            canDragAndDrop={false}
            canReorderItems={false}
            canDropOnFolder={false}
            onSelectItems={(ids) => {
              if (ids.length > 0) {
                void (async () => {
                  const item = await dataProvider.getTreeItem(ids[0]);
                  if (item.data?.isDir) setSelectedPath(item.data.path);
                  else setSelectedPath(null);
                })();
              }
            }}
            renderItemTitle={({ item }) => (
              <span>{item.data?.isDir ? "📁 " : "📄 "}{item.data?.name}</span>
            )}
          >
            <Tree treeId="dir-tree" rootItem="root" treeLabel="目录" />
          </UncontrolledTreeEnvironment>
        </div>
        <div className="p-3 border-t border-surface0 flex gap-2 justify-end">
          <button onClick={onCancel} className="px-3 py-1 text-sm text-subtext hover:text-text" data-testid="dir-cancel">取消</button>
          <button
            onClick={() => selectedPath && onPick(selectedPath)}
            disabled={!selectedPath}
            className="px-3 py-1 text-sm bg-blue text-white rounded disabled:opacity-40"
            data-testid="dir-pick"
          >选择</button>
        </div>
      </div>
    </div>
  );
}
