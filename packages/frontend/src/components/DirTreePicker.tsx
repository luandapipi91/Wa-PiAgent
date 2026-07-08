// 目录树选择器：ControlledTreeEnvironment + onMissingItems 懒加载 + 预展开 home。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ControlledTreeEnvironment,
  Tree,
  type TreeItem,
  type TreeItemIndex,
} from "react-complex-tree";
import "react-complex-tree/lib/style-modern.css";
import { getHome, getRoots, listDir } from "../fs-client";

// 覆盖 react-complex-tree 默认选中样式：浅色选中背景 + 继承文字颜色
const TREE_STYLES = `
.rct-tree-item-title-container {
  background: transparent !important;
}
.rct-tree-item-title-container-selected,
.rct-tree-item-title-container-focused,
.rct-tree-item-title-container-selected.rct-tree-item-title-container-focused {
  background: rgba(59, 130, 246, 0.15) !important;
}
.rct-tree-item-button,
.rct-tree-item-arrow {
  color: inherit !important;
}
`;

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

// 占位符前缀：`__ld__<parentId>` → onMissingItems 中解析出 parentId 做懒加载
const LD = "__ld__";

export function DirTreePicker({ onPick, onCancel }: Props) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [focusedItem, setFocusedItem] = useState<TreeItemIndex | undefined>();
  const [selectedItems, setSelectedItems] = useState<TreeItemIndex[]>([]);
  const [expandedItems, setExpandedItems] = useState<TreeItemIndex[]>([]);
  const [treeItems, setTreeItems] = useState<Record<TreeItemIndex, TreeItem<FsNodeData>>>({
    root: { index: "root", children: [], isFolder: true, data: { path: "", name: "加载中…", isDir: true } },
  });
  const treeItemsRef = useRef(treeItems);
  treeItemsRef.current = treeItems;

  // 加载根节点 + 预加载 home 路径 + 批量展开
  useEffect(() => {
    (async () => {
      const roots = await getRoots();
      const rootChildren: TreeItemIndex[] = roots.map((_, i) => `root_${i}`);
      const items: Record<TreeItemIndex, TreeItem<FsNodeData>> = {
        root: { index: "root", children: rootChildren, isFolder: true, data: { path: "", name: "此电脑", isDir: true } },
      };
      for (const [i, r] of roots.entries()) {
        items[`root_${i}`] = { index: `root_${i}`, children: [`${LD}root_${i}`], isFolder: true, data: { path: r, name: r, isDir: true } };
      }

      const home = await getHome();
      setSelectedPath(home);

      const sep = home.includes("\\") ? "\\" : "/";
      const allSegments = home.split(sep).filter(Boolean);
      const expandIds: TreeItemIndex[] = ["root"];

      // 找到 home 所在的 OS 根并懒加载它的子目录
      let currentId: TreeItemIndex | undefined;
      for (const [id, item] of Object.entries(items)) {
        if (id === "root") continue;
        if (home.startsWith(item.data.path)) { currentId = id; break; }
      }
      if (!currentId) { setTreeItems({ ...items }); return; }
      expandIds.push(currentId);

      let currentPath = items[currentId].data.path;
      let segIdx = 0;
      if (currentPath && currentPath !== "/") {
        segIdx = currentPath.split(sep).filter(Boolean).length;
      }

      // 逐层预加载到 home
      while (segIdx < allSegments.length) {
        const entries = (await listDir(currentPath)).filter(e => e.isDir);
        const childList: TreeItemIndex[] = [];
        const newChildren: Record<string, TreeItem<FsNodeData>> = {};

        for (const e of entries) {
          const childId = `${currentId}_${childList.length}`;
          childList.push(childId);
          newChildren[childId] = {
            index: childId,
            children: [`${LD}${childId}`],
            isFolder: true,
            data: { path: join(currentPath, e.name), name: e.name, isDir: true },
          };
        }

        items[currentId] = { ...items[currentId], children: childList };
        Object.assign(items, newChildren);

        const expected = join(currentPath, allSegments[segIdx]);
        let found = false;
        for (const [cid, citem] of Object.entries(newChildren)) {
          if (citem.data.path === expected) {
            expandIds.push(cid);
            currentId = cid;
            currentPath = expected;
            found = true;
            break;
          }
        }
        if (!found) break;
        segIdx++;
      }

      setTreeItems({ ...items });
      setExpandedItems(expandIds);
      if (expandIds.length > 1) {
        setFocusedItem(expandIds[expandIds.length - 1]);
        setSelectedItems([expandIds[expandIds.length - 1]]);
      }
    })();
  }, []);

  // onMissingItems：树发现 children 中有不存在的 ID → 懒加载该目录的子节点
  const handleMissingItems = useCallback(async (missingIds: TreeItemIndex[]) => {
    // 从占位符 __ld__<parentId> 中解析出父节点 ID
    const needLoad = new Set<TreeItemIndex>();
    for (const mid of missingIds) {
      if (typeof mid === "string" && mid.startsWith(LD)) {
        needLoad.add(mid.slice(LD.length));
      }
    }
    if (needLoad.size === 0) return;

    const items = treeItemsRef.current;
    let changed = false;
    const next = { ...items };

    for (const parentId of needLoad) {
      const parent = items[parentId];
      if (!parent) continue;
      const entries = (await listDir(parent.data.path)).filter(e => e.isDir);
      const realChildren: TreeItemIndex[] = [];
      for (const [i, e] of entries.entries()) {
        const childId = `${parentId}_${i}`;
        realChildren.push(childId);
        next[childId] = {
          index: childId,
          children: [`${LD}${childId}`],
          isFolder: true,
          data: { path: join(parent.data.path, e.name), name: e.name, isDir: true },
        };
      }
      next[parentId] = { ...parent, children: realChildren };
      changed = true;
    }

    if (changed) setTreeItems(next);
  }, []);

  // onExpandItem / onCollapseItem：仅管理 expandedItems
  const handleExpandItem = useCallback((item: TreeItem<FsNodeData>) => {
    setExpandedItems((prev) => (prev.includes(item.index) ? prev : [...prev, item.index]));
  }, []);

  const handleCollapseItem = useCallback((item: TreeItem<FsNodeData>) => {
    setExpandedItems((prev) => prev.filter((id) => id !== item.index));
  }, []);

  const handleSelectItems = useCallback((ids: TreeItemIndex[]) => {
    if (ids.length > 0) {
      setSelectedItems(ids);
      setFocusedItem(ids[0]);
      const item = treeItemsRef.current[ids[0]];
      if (item?.data?.path) setSelectedPath(item.data.path);
    } else {
      setSelectedItems([]);
      setFocusedItem(undefined);
    }
  }, []);

  const handleFocusItem = useCallback((item: TreeItem<FsNodeData>) => {
    setFocusedItem(item.index);
  }, []);

  const viewState = useMemo(() => ({
    "dir-tree": { expandedItems, focusedItem, selectedItems },
  }), [expandedItems, focusedItem, selectedItems]);

  return (
    <>
      <style>{TREE_STYLES}</style>
      <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" data-testid="dir-picker">
      <div className="bg-base w-[600px] max-h-[80vh] rounded-lg flex flex-col">
        <div className="p-4 border-b border-surface0 text-text font-medium">
          选择项目目录
          {selectedPath && <span className="ml-3 text-xs text-blue font-mono">{selectedPath}</span>}
        </div>
        <div className="flex-1 overflow-auto p-2 text-text" style={{ minHeight: 320 }}>
          <ControlledTreeEnvironment<FsNodeData>
            items={treeItems}
            viewState={viewState}
            getItemTitle={(item) => item.data.name}
            canDragAndDrop={false}
            canReorderItems={false}
            canDropOnFolder={false}
            onExpandItem={handleExpandItem}
            onCollapseItem={handleCollapseItem}
            onMissingItems={handleMissingItems}
            onSelectItems={handleSelectItems}
            onFocusItem={handleFocusItem}
            renderItemTitle={({ item }) => (
              <span>{item.data?.isDir ? "📁 " : "📄 "}{item.data?.name}</span>
            )}
          >
            <Tree treeId="dir-tree" rootItem="root" treeLabel="目录" />
          </ControlledTreeEnvironment>
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
    </>
  );
}
