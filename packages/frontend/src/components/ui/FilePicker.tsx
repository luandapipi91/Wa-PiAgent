// 通用文件/文件夹多选组件
// 基于 kernel fs:listDir 浏览文件系统，支持同时选择多个文件和文件夹。
// 文件会被复制到项目 .hiagent/uploads 下；文件夹直接返回其真实路径，不再创建软链接。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ControlledTreeEnvironment,
  Tree,
  type TreeItem,
  type TreeItemIndex,
} from "react-complex-tree";
import "react-complex-tree/lib/style-modern.css";
import { getHome, getRoots, listDir } from "../../fs-client";

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

export interface FilePickerSelection {
  path: string;
  isDir: boolean;
  name: string;
}

interface Props {
  onPick: (selections: FilePickerSelection[]) => void;
  onCancel: () => void;
  multiSelect?: boolean;
}

function join(parent: string, name: string): string {
  if (parent.endsWith("\\") || parent.endsWith("/")) return parent + name;
  const sep = parent.includes("\\") ? "\\" : "/";
  return parent + sep + name;
}

const LD = "__ld__";

function isPlaceholderId(id: TreeItemIndex): boolean {
  return typeof id === "string" && id.startsWith(LD);
}

function findParentId(
  childId: TreeItemIndex,
  items: Record<TreeItemIndex, TreeItem<FsNodeData>>,
): TreeItemIndex | null {
  for (const [id, item] of Object.entries(items)) {
    if (item.children?.includes(childId)) return id;
  }
  return null;
}

function hideFileItems(
  allItems: Record<TreeItemIndex, TreeItem<FsNodeData>>,
): Record<TreeItemIndex, TreeItem<FsNodeData>> {
  const keepIds = new Set<TreeItemIndex>(["root"]);
  for (const [id, item] of Object.entries(allItems)) {
    if (item.data.isDir) keepIds.add(id);
  }

  const items: Record<TreeItemIndex, TreeItem<FsNodeData>> = {};
  for (const id of keepIds) {
    const item = allItems[id];
    items[id] = {
      ...item,
      children: item.children?.filter((cid) => keepIds.has(cid)),
    };
  }
  return items;
}

function filterTreeItems(
  allItems: Record<TreeItemIndex, TreeItem<FsNodeData>>,
  query: string,
): { items: Record<TreeItemIndex, TreeItem<FsNodeData>>; expandIds: TreeItemIndex[] } {
  const lowerQuery = query.toLowerCase();

  const matchingIds = new Set<TreeItemIndex>();
  for (const [id, item] of Object.entries(allItems)) {
    if (id === "root") continue;
    if (item.data.name.toLowerCase().includes(lowerQuery)) {
      matchingIds.add(id);
    }
  }

  if (matchingIds.size === 0) {
    return { items: { root: allItems.root }, expandIds: [] };
  }

  const keepIds = new Set(matchingIds);
  keepIds.add("root");
  for (const matchId of matchingIds) {
    let current: TreeItemIndex | null = matchId;
    while ((current = findParentId(current, allItems))) {
      keepIds.add(current);
    }
  }

  const items: Record<TreeItemIndex, TreeItem<FsNodeData>> = {};
  for (const id of keepIds) {
    const item = allItems[id];
    items[id] = {
      ...item,
      children: item.children?.filter((cid) => keepIds.has(cid) || isPlaceholderId(cid)),
    };
  }

  const expandIds: TreeItemIndex[] = [];
  for (const id of keepIds) {
    const item = items[id];
    if (item.children && item.children.length > 0 && item.isFolder) {
      expandIds.push(id);
    }
  }

  return { items, expandIds };
}

export function FilePicker({ onPick, onCancel, multiSelect = true }: Props) {
  const [focusedItem, setFocusedItem] = useState<TreeItemIndex | undefined>();
  const [selectedItems, setSelectedItems] = useState<TreeItemIndex[]>([]);
  const [expandedItems, setExpandedItems] = useState<TreeItemIndex[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [treeItems, setTreeItems] = useState<Record<TreeItemIndex, TreeItem<FsNodeData>>>({
    root: { index: "root", children: [], isFolder: true, data: { path: "", name: "加载中…", isDir: true } },
  });
  const treeItemsRef = useRef(treeItems);
  treeItemsRef.current = treeItems;
  const showHiddenRef = useRef(showHidden);
  showHiddenRef.current = showHidden;

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
      const sep = home.includes("\\") ? "\\" : "/";
      const allSegments = home.split(sep).filter(Boolean);
      const expandIds: TreeItemIndex[] = ["root"];

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

      while (segIdx < allSegments.length) {
        const entries = (await listDir(currentPath, showHiddenRef.current)).filter(e => showHiddenRef.current || !e.name.startsWith("."));
        const childList: TreeItemIndex[] = [];
        const newChildren: Record<string, TreeItem<FsNodeData>> = {};

        for (const e of entries) {
          const childId = `${currentId}_${childList.length}`;
          childList.push(childId);
          newChildren[childId] = {
            index: childId,
            children: e.isDir ? [`${LD}${childId}`] : undefined,
            isFolder: e.isDir,
            data: { path: join(currentPath, e.name), name: e.name, isDir: e.isDir },
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
    })();
  }, [showHidden]);

  const handleMissingItems = useCallback(async (missingIds: TreeItemIndex[]) => {
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
      const entries = (await listDir(parent.data.path, showHiddenRef.current)).filter(e => showHiddenRef.current || !e.name.startsWith("."));
      const realChildren: TreeItemIndex[] = [];
      for (const [i, e] of entries.entries()) {
        const childId = `${parentId}_${i}`;
        realChildren.push(childId);
        next[childId] = {
          index: childId,
          children: e.isDir ? [`${LD}${childId}`] : undefined,
          isFolder: e.isDir,
          data: { path: join(parent.data.path, e.name), name: e.name, isDir: e.isDir },
        };
      }
      next[parentId] = { ...parent, children: realChildren };
      changed = true;
    }

    if (changed) setTreeItems(next);
  }, []);

  const handleExpandItem = useCallback((item: TreeItem<FsNodeData>) => {
    setExpandedItems((prev) => (prev.includes(item.index) ? prev : [...prev, item.index]));
  }, []);

  const handleCollapseItem = useCallback((item: TreeItem<FsNodeData>) => {
    setExpandedItems((prev) => prev.filter((id) => id !== item.index));
  }, []);

  const handleSelectItems = useCallback((ids: TreeItemIndex[]) => {
    if (ids.length === 0) {
      setSelectedItems([]);
      setFocusedItem(undefined);
      return;
    }
    const nextIds = multiSelect ? ids : [ids[ids.length - 1]];
    setSelectedItems(nextIds);
    setFocusedItem(nextIds[0]);
  }, [multiSelect]);

  const handleFocusItem = useCallback((item: TreeItem<FsNodeData>) => {
    setFocusedItem(item.index);
  }, []);

  const { displayItems, searchExpandIds } = useMemo(() => {
    if (!searchQuery.trim()) {
      return { displayItems: treeItems, searchExpandIds: null };
    }
    const result = filterTreeItems(treeItems, searchQuery.trim());
    return { displayItems: result.items, searchExpandIds: result.expandIds };
  }, [treeItems, searchQuery]);

  const isSearching = searchQuery.trim().length > 0;
  const hasSearchResults = isSearching
    ? Object.keys(displayItems).length > 1
    : true;

  const selections = useMemo(() => {
    return selectedItems
      .map((id) => treeItems[id]?.data)
      .filter(Boolean) as FilePickerSelection[];
  }, [selectedItems, treeItems]);

  const viewState = useMemo(() => ({
    "file-picker": {
      expandedItems: searchExpandIds ?? expandedItems,
      focusedItem,
      selectedItems,
    },
  }), [expandedItems, searchExpandIds, focusedItem, selectedItems]);

  return (
    <>
      <style>{TREE_STYLES}</style>
      <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" data-testid="file-picker">
        <div className="bg-surface w-[680px] max-h-[85vh] rounded-lg flex flex-col border border-hairline shadow-lg" style={{ background: "#FFFFFF" }}>
          <div className="p-4 border-b border-surface0 flex items-center justify-between gap-3">
            <div className="text-text font-medium truncate">
              选择文件或文件夹
              {selections.length > 0 && (
                <span className="ml-3 text-xs text-blue font-mono">
                  已选 {selections.length} 项
                </span>
              )}
            </div>
            <input
              type="text"
              className="w-48 px-3 py-1.5 text-sm border border-hairline rounded bg-surface0 text-text placeholder:text-tertiary focus:outline-none focus:border-blue"
              placeholder="搜索文件名…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              data-testid="file-picker-search"
            />
          </div>
          <div className="flex-1 overflow-auto p-2 text-text" style={{ minHeight: 320 }}>
            {isSearching && !hasSearchResults ? (
              <div className="flex items-center justify-center h-32 text-sm text-tertiary">无匹配结果</div>
            ) : (
              <ControlledTreeEnvironment<FsNodeData>
                items={displayItems}
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
                <Tree treeId="file-picker" rootItem="root" treeLabel="文件" />
              </ControlledTreeEnvironment>
            )}
          </div>
          <div className="p-3 border-t border-surface0 flex gap-2 justify-between items-center">
            <label className="flex items-center gap-2 text-xs text-tertiary cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(e) => setShowHidden(e.target.checked)}
                className="sr-only"
              />
              <span className="relative inline-block" style={{ width: 32, height: 18 }}>
                <span
                  className="absolute inset-0 rounded-full transition-colors"
                  style={{ background: showHidden ? "var(--brand)" : "var(--hairline-strong)" }}
                />
                <span
                  className="absolute rounded-full bg-white shadow-sm transition-transform"
                  style={{
                    width: 14, height: 14, top: 2, left: 2,
                    transform: showHidden ? "translateX(14px)" : "translateX(0)",
                  }}
                />
              </span>
              显示隐藏目录
            </label>
            <div className="flex gap-2">
              <button onClick={onCancel} className="px-3 py-1 text-sm text-subtext hover:text-text" data-testid="file-picker-cancel">取消</button>
              <button
                onClick={() => onPick(selections)}
                disabled={selections.length === 0}
                className="px-3 py-1 text-sm rounded disabled:opacity-40"
                style={{ background: "#1D1D1F", color: "#FFFFFF" }}
                data-testid="file-picker-ok"
              >添加 {selections.length > 0 ? `(${selections.length})` : ""}</button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
