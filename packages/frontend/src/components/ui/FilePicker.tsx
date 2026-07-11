// 通用文件/文件夹多选组件
// 基于 kernel fs:listDir 浏览文件系统，支持同时选择多个文件和文件夹。
// 文件会被复制到项目 .hiagent/uploads 下；文件夹直接返回其真实路径，不再创建软链接。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ControlledTreeEnvironment,
  Tree,
  type TreeEnvironmentRef,
  type TreeItem,
  type TreeItemIndex,
} from "react-complex-tree";
import "react-complex-tree/lib/style-modern.css";
import { getHome, getRoots, listDir, searchFilesStream, type SearchMatch } from "../../fs-client";

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
  // 打开时默认定位并展开到此路径（通常传当前项目 cwd）；为空则回退到用户主目录
  defaultPath?: string;
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

// 沿 targetPath 逐级 listDir，把从盘符根到目标路径的每一层展开并载入到 items（原地修改）。
// 返回需展开的节点 id 列表与是否成功定位到目标（路径不在任何根下/中途不存在时 ok=false）。
// Windows 盘符与目录名大小写无关比较：项目 cwd 可能以小写盘符存库，而根目录返回大写。
async function walkToTarget(
  items: Record<TreeItemIndex, TreeItem<FsNodeData>>,
  targetPath: string,
  showHidden: boolean,
): Promise<{ expandIds: TreeItemIndex[]; ok: boolean; targetId?: TreeItemIndex }> {
  const sep = targetPath.includes("\\") ? "\\" : "/";
  const isWin = sep === "\\";
  const pathsEqual = (a: string, b: string): boolean =>
    isWin ? a.toLowerCase() === b.toLowerCase() : a === b;
  const allSegments = targetPath.split(sep).filter(Boolean);
  const expandIds: TreeItemIndex[] = ["root"];

  let currentId: TreeItemIndex | undefined;
  const lowerTarget = targetPath.toLowerCase();
  for (const [id, item] of Object.entries(items)) {
    if (id === "root") continue;
    const rootPath = item.data.path;
    if (isWin ? lowerTarget.startsWith(rootPath.toLowerCase()) : targetPath.startsWith(rootPath)) {
      currentId = id;
      break;
    }
  }
  if (!currentId) return { expandIds, ok: false };
  expandIds.push(currentId);

  let currentPath = items[currentId].data.path;
  let segIdx = 0;
  if (currentPath && currentPath !== "/") {
    segIdx = currentPath.split(sep).filter(Boolean).length;
  }

  while (segIdx < allSegments.length) {
    const entries = (await listDir(currentPath, showHidden)).filter(e => showHidden || !e.name.startsWith("."));
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
      if (pathsEqual(citem.data.path, expected)) {
        expandIds.push(cid);
        currentId = cid;
        currentPath = citem.data.path;
        found = true;
        break;
      }
    }
    if (!found) return { expandIds, ok: false };
    segIdx++;
  }

  return { expandIds, ok: true, targetId: currentId };
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

// 根据后端搜索结果构建一棵只包含匹配项及其父目录链的树
function buildSearchTree(
  matches: { name: string; isDir: boolean; path: string }[],
  roots: string[],
): Record<TreeItemIndex, TreeItem<FsNodeData>> {
  const items: Record<TreeItemIndex, TreeItem<FsNodeData>> = {
    root: { index: "root", children: [], isFolder: true, data: { path: "", name: "此电脑", isDir: true } },
  };

  for (const [i, r] of roots.entries()) {
    const rootId = `root_${i}`;
    items.root.children!.push(rootId);
    items[rootId] = { index: rootId, children: [], isFolder: true, data: { path: r, name: r, isDir: true } };
  }

  for (const match of matches) {
    const rootIdx = roots.findIndex(r => match.path.startsWith(r));
    if (rootIdx < 0) continue;

    const rootId = `root_${rootIdx}`;
    const rootPath = roots[rootIdx];
    const rel = match.path.slice(rootPath.length).replace(/^[/\\]/, "");
    const segments = rel.split(/[/\\]/).filter(Boolean);
    let currentPath = rootPath;
    let parentId = rootId;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const nextPath = join(currentPath, seg);
      const isLast = i === segments.length - 1;
      const isDir = isLast ? match.isDir : true;

      if (!items[nextPath]) {
        items[nextPath] = {
          index: nextPath,
          children: isDir ? [] : undefined,
          isFolder: isDir,
          data: { path: nextPath, name: seg, isDir: isDir },
        };
      }
      const parent = items[parentId];
      if (parent.children && !parent.children.includes(nextPath)) {
        parent.children.push(nextPath);
      }

      currentPath = nextPath;
      parentId = nextPath;
    }
  }

  return items;
}

export function FilePicker({ onPick, onCancel, multiSelect = true, defaultPath }: Props) {
  const [focusedItem, setFocusedItem] = useState<TreeItemIndex | undefined>();
  const [selectedItems, setSelectedItems] = useState<TreeItemIndex[]>([]);
  const [expandedItems, setExpandedItems] = useState<TreeItemIndex[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [treeItems, setTreeItems] = useState<Record<TreeItemIndex, TreeItem<FsNodeData>>>({
    root: { index: "root", children: [], isFolder: true, data: { path: "", name: "加载中…", isDir: true } },
  });
  const [searchTreeItems, setSearchTreeItems] = useState<Record<TreeItemIndex, TreeItem<FsNodeData>> | null>(null);
  const [searchDuration, setSearchDuration] = useState<number | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const treeItemsRef = useRef(treeItems);
  treeItemsRef.current = treeItems;
  const showHiddenRef = useRef(showHidden);
  showHiddenRef.current = showHidden;
  const rootsRef = useRef<string[]>([]);
  const envRef = useRef<TreeEnvironmentRef>(null);
  // 定位到的目录节点 id：树渲染后据此 focusItem（高亮 + 滚动到可见），执行一次后清空
  const focusTargetRef = useRef<TreeItemIndex | null>(null);

  useEffect(() => {
    (async () => {
      const roots = await getRoots();
      rootsRef.current = roots;
      const rootChildren: TreeItemIndex[] = roots.map((_, i) => `root_${i}`);
      const items: Record<TreeItemIndex, TreeItem<FsNodeData>> = {
        root: { index: "root", children: rootChildren, isFolder: true, data: { path: "", name: "此电脑", isDir: true } },
      };
      for (const [i, r] of roots.entries()) {
        items[`root_${i}`] = { index: `root_${i}`, children: [`${LD}root_${i}`], isFolder: true, data: { path: r, name: r, isDir: true } };
      }

      const home = await getHome();
      const targetPath = defaultPath && defaultPath.trim() ? defaultPath.trim() : home;
      let result = await walkToTarget(items, targetPath, showHiddenRef.current);
      // 指定了 defaultPath 但定位失败（路径不存在/不在任何根下）时回退到主目录
      if (!result.ok && targetPath !== home) {
        result = await walkToTarget(items, home, showHiddenRef.current);
      }

      setTreeItems({ ...items });
      setExpandedItems(result.expandIds);
      // 默认聚焦定位到的目录节点：设 focusedItem 触发高亮，并记下待滚动聚焦目标
      if (result.targetId) {
        setFocusedItem(result.targetId);
        focusTargetRef.current = result.targetId;
      }
    })();
  }, [showHidden, defaultPath]);

  // 树渲染提交后滚动并聚焦到定位目录（effects 在 DOM 提交后运行，节点已在视口；仅执行一次）
  useEffect(() => {
    const id = focusTargetRef.current;
    if (!id) return;
    envRef.current?.focusItem(id, "file-picker");
    focusTargetRef.current = null;
  }, [treeItems]);

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

  const { displayItems, isSearching } = useMemo(() => {
    const searching = searchQuery.trim().length > 0;
    if (!searching) {
      return { displayItems: treeItems, isSearching: false };
    }
    if (searchTreeItems) {
      return { displayItems: searchTreeItems, isSearching: true };
    }
    const result = filterTreeItems(treeItems, searchQuery.trim());
    return { displayItems: result.items, isSearching: true };
  }, [treeItems, searchQuery, searchTreeItems]);

  // 后端全文搜索：debounce 300ms，流式接收进度并增量渲染
  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) {
      setSearchTreeItems(null);
      setSearchDuration(null);
      setSearchLoading(false);
      return;
    }

    setSearchLoading(true);
    const allMatches = new Map<string, SearchMatch>();
    const rebuild = () => {
      const roots = rootsRef.current;
      setSearchTreeItems(buildSearchTree(Array.from(allMatches.values()), roots));
    };

    let cleanup: (() => void) | null = null;
    const timer = setTimeout(() => {
      cleanup = searchFilesStream(
        query,
        {
          roots: rootsRef.current,
          maxResults: 200,
          showHidden: showHiddenRef.current,
        },
        {
          onProgress: (ms) => {
            for (const m of ms) allMatches.set(m.path, m);
            rebuild();
          },
          onDone: (r) => {
            setSearchDuration(r.durationMs);
            setSearchLoading(false);
          },
        },
      );
    }, 300);

    return () => {
      clearTimeout(timer);
      cleanup?.();
      setSearchLoading(false);
    };
  }, [searchQuery]);

  // 搜索结果出现时，把有子节点的节点合并到 expandedItems 中（允许用户后续折叠）
  useEffect(() => {
    if (!searchTreeItems) return;
    const needExpand: TreeItemIndex[] = [];
    for (const [id, item] of Object.entries(searchTreeItems)) {
      if (item.children && item.children.length > 0 && item.isFolder) {
        needExpand.push(id);
      }
    }
    if (needExpand.length === 0) return;
    setExpandedItems(prev => Array.from(new Set([...prev, ...needExpand])));
  }, [searchTreeItems]);

  const hasSearchResults = isSearching
    ? Object.keys(displayItems).length > 1
    : true;

  const selections = useMemo(() => {
    return selectedItems
      .map((id) => (searchTreeItems?.[id] ?? treeItems[id])?.data)
      .filter(Boolean) as FilePickerSelection[];
  }, [selectedItems, treeItems, searchTreeItems]);

  const viewState = useMemo(() => ({
    "file-picker": {
      expandedItems,
      focusedItem,
      selectedItems,
    },
  }), [expandedItems, focusedItem, selectedItems]);

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
            <div className="flex flex-col items-end gap-1">
              <div className="relative flex items-center">
                <input
                  type="text"
                  className="w-48 px-3 py-1.5 text-sm border border-hairline rounded bg-surface0 text-text placeholder:text-tertiary focus:outline-none focus:border-blue pr-8"
                  placeholder="搜索文件名…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  data-testid="file-picker-search"
                />
                {searchLoading && (
                  <span
                    className="absolute right-2 w-3.5 h-3.5 border-2 border-hairline border-t-blue rounded-full animate-spin"
                    data-testid="file-picker-search-loading"
                  />
                )}
              </div>
              {isSearching && searchDuration !== null && (
                <span className="text-[11px] text-tertiary" data-testid="search-duration">
                  搜索耗时 {searchDuration}ms
                </span>
              )}
            </div>
          </div>
          <div className="flex-1 overflow-auto p-2 text-text" style={{ minHeight: 320 }}>
            {isSearching && searchLoading && !hasSearchResults ? (
              <div className="flex items-center justify-center h-32 text-sm text-tertiary">搜索中…</div>
            ) : isSearching && !hasSearchResults ? (
              <div className="flex items-center justify-center h-32 text-sm text-tertiary">无匹配结果</div>
            ) : (
              <ControlledTreeEnvironment<FsNodeData>
                ref={envRef}
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
                  <span>{item.isFolder ? "📁 " : "📄 "}{item.data?.name}</span>
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
