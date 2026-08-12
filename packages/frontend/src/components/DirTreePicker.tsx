// 目录树选择器：ControlledTreeEnvironment + onMissingItems 懒加载 + 预展开 home。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ControlledTreeEnvironment,
  Tree,
  type TreeItem,
  type TreeItemIndex,
} from "react-complex-tree";
import "react-complex-tree/lib/style-modern.css";
import { useTranslation } from "../i18n/useTranslation";
import { getHome, getRoots, listDir, searchFilesStream, type SearchMatch } from "../fs-client";
import { Icon } from "./ui/Icon";

// 覆盖 react-complex-tree 默认样式：全部使用项目 token，自动跟随深浅色与 6 色主题
const TREE_STYLES = `
.rct-tree-item-title-container {
  background: transparent !important;
}
.rct-tree-item-title-container-selected,
.rct-tree-item-title-container-focused,
.rct-tree-item-title-container-selected.rct-tree-item-title-container-focused {
  background: var(--accent-soft) !important;
}
.rct-tree-item-title-container-selected .rct-tree-item-button,
.rct-tree-item-title-container-focused .rct-tree-item-button {
  background-color: transparent !important;
}
.rct-tree-item-button:hover {
  background-color: var(--surface-hover) !important;
  color: inherit !important;
}
.rct-tree-item-title-container-selected .rct-tree-item-button::before {
  background-color: var(--accent) !important;
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
  showFiles?: boolean;
}

function join(parent: string, name: string): string {
  if (parent.endsWith("\\") || parent.endsWith("/")) return parent + name;
  const sep = parent.includes("\\") ? "\\" : "/";
  return parent + sep + name;
}

// 占位符前缀：`__ld__<parentId>` → onMissingItems 中解析出 parentId 做懒加载
const LD = "__ld__";

function isPlaceholderId(id: TreeItemIndex): boolean {
  return typeof id === "string" && id.startsWith(LD);
}

// 在 treeItems 中查找某个 childId 的父节点 ID
function findParentId(
  childId: TreeItemIndex,
  items: Record<TreeItemIndex, TreeItem<FsNodeData>>,
): TreeItemIndex | null {
  for (const [id, item] of Object.entries(items)) {
    if (item.children?.includes(childId)) return id;
  }
  return null;
}

// 在非搜索状态下按 showFiles 过滤：false 时隐藏文件节点，只保留目录
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
      children: item.children?.filter((cid) => keepIds.has(cid) || isPlaceholderId(cid)),
    };
  }
  return items;
}

// 根据搜索关键字过滤 treeItems，返回过滤后的 items 和需要展开的节点 ID 列表
function filterTreeItems(
  allItems: Record<TreeItemIndex, TreeItem<FsNodeData>>,
  query: string,
  showFiles: boolean,
): { items: Record<TreeItemIndex, TreeItem<FsNodeData>>; expandIds: TreeItemIndex[] } {
  const lowerQuery = query.toLowerCase();

  // 收集所有名称匹配关键字的节点（包括文件，用于定位其父目录）
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

  // 从匹配节点向上追溯到根，收集所有祖先
  const keepIds = new Set(matchingIds);
  keepIds.add("root");
  for (const matchId of matchingIds) {
    let current: TreeItemIndex | null = matchId;
    while ((current = findParentId(current, allItems))) {
      keepIds.add(current);
    }
  }

  // 不显示文件时，把匹配的文件节点从保留列表中移除（其父目录链仍保留）
  if (!showFiles) {
    for (const id of matchingIds) {
      const item = allItems[id];
      if (item && !item.data.isDir) {
        keepIds.delete(id);
      }
    }
  }

  // 构建过滤后的 items，更新 children 数组只保留白名单内的子节点，但保留占位符 ID 以便目录可继续懒加载展开
  const items: Record<TreeItemIndex, TreeItem<FsNodeData>> = {};
  for (const id of keepIds) {
    const item = allItems[id];
    items[id] = {
      ...item,
      children: item.children?.filter((cid) => keepIds.has(cid) || isPlaceholderId(cid)),
    };
  }

  // 自动展开所有有子节点的已保留节点
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
  rootName: string,
): Record<TreeItemIndex, TreeItem<FsNodeData>> {
  const items: Record<TreeItemIndex, TreeItem<FsNodeData>> = {
    root: { index: "root", children: [], isFolder: true, data: { path: "", name: rootName, isDir: true } },
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

export function DirTreePicker({ onPick, onCancel, showFiles = false }: Props) {
  const { t } = useTranslation();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [focusedItem, setFocusedItem] = useState<TreeItemIndex | undefined>();
  const [selectedItems, setSelectedItems] = useState<TreeItemIndex[]>([]);
  const [expandedItems, setExpandedItems] = useState<TreeItemIndex[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [treeItems, setTreeItems] = useState<Record<TreeItemIndex, TreeItem<FsNodeData>>>({
    root: { index: "root", children: [], isFolder: true, data: { path: "", name: t("filePicker.loading"), isDir: true } },
  });
  const [searchTreeItems, setSearchTreeItems] = useState<Record<TreeItemIndex, TreeItem<FsNodeData>> | null>(null);
  const [searchDuration, setSearchDuration] = useState<number | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const treeItemsRef = useRef(treeItems);
  treeItemsRef.current = treeItems;
  const searchTreeItemsRef = useRef(searchTreeItems);
  searchTreeItemsRef.current = searchTreeItems;
  const showHiddenRef = useRef(showHidden);
  showHiddenRef.current = showHidden;
  const selectedPathRef = useRef(selectedPath);
  selectedPathRef.current = selectedPath;
  // 记录已自动展开的搜索结果节点：增量更新时只展开新出现的，不重展开用户已折叠的
  const autoExpandedRef = useRef<Set<TreeItemIndex>>(new Set());
  // 记录搜索态下已加载过真实子目录的目录路径，避免重复展开时重复 listDir
  const loadedDirsRef = useRef<Set<string>>(new Set());
  const rootsRef = useRef<string[]>([]);

  // 加载根节点 + 预加载 home 路径 + 批量展开
  useEffect(() => {
    (async () => {
      const roots = await getRoots();
      rootsRef.current = roots;
      const rootChildren: TreeItemIndex[] = roots.map((_, i) => `root_${i}`);
      const items: Record<TreeItemIndex, TreeItem<FsNodeData>> = {
        root: { index: "root", children: rootChildren, isFolder: true, data: { path: "", name: t("filePicker.thisPc"), isDir: true } },
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
      if (expandIds.length > 1) {
        setFocusedItem(expandIds[expandIds.length - 1]);
        setSelectedItems([expandIds[expandIds.length - 1]]);
      }
    })();
  }, [showHidden]);

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

  // onExpandItem / onCollapseItem：管理 expandedItems；搜索态下展开结果目录时
  // 额外加载其真实子目录合并进搜索树（匹配子项保留在前，未匹配的追加在后）
  const handleExpandItem = useCallback((item: TreeItem<FsNodeData>) => {
    setExpandedItems((prev) => (prev.includes(item.index) ? prev : [...prev, item.index]));

    if (!item.isFolder || !item.data?.path) return;
    const path = item.data.path;
    if (!searchTreeItemsRef.current || loadedDirsRef.current.has(path)) return;
    loadedDirsRef.current.add(path);
    void (async () => {
      const entries = (await listDir(path, showHiddenRef.current))
        .filter(e => (showFiles || e.isDir) && (showHiddenRef.current || !e.name.startsWith(".")));
      const src = searchTreeItemsRef.current;
      const parent = src?.[path];
      if (!src || !parent) return; // 搜索已清空或结果被重建，放弃合并
      const next = { ...src };
      const existing = new Set(parent.children ?? []);
      const merged = [...(parent.children ?? [])];
      for (const e of entries) {
        const childId = join(path, e.name);
        if (!next[childId]) {
          next[childId] = {
            index: childId,
            children: e.isDir ? [] : undefined,
            isFolder: e.isDir,
            data: { path: childId, name: e.name, isDir: e.isDir },
          };
        }
        if (!existing.has(childId)) merged.push(childId);
      }
      next[path] = { ...parent, children: merged };
      setSearchTreeItems(next);
    })();
  }, [showFiles]);

  const handleCollapseItem = useCallback((item: TreeItem<FsNodeData>) => {
    setExpandedItems((prev) => prev.filter((id) => id !== item.index));
  }, []);

  const handleSelectItems = useCallback((ids: TreeItemIndex[]) => {
    if (ids.length > 0) {
      setSelectedItems(ids);
      setFocusedItem(ids[0]);
      // 搜索态下 item id 属于搜索树命名空间（id 即 path），优先从搜索树取，
      // 否则搜索结果/下钻出的目录点击后无法更新选中路径
      const src = searchTreeItemsRef.current ?? treeItemsRef.current;
      const item = src[ids[0]];
      if (item?.data?.path) {
        if (item.data.isDir) {
          setSelectedPath(item.data.path);
        } else {
          const parentId = findParentId(ids[0], src);
          const parent = parentId ? src[parentId] : null;
          setSelectedPath(parent?.data?.path ?? item.data.path);
        }
      }
    } else {
      setSelectedItems([]);
      setFocusedItem(undefined);
    }
  }, []);

  const handleFocusItem = useCallback((item: TreeItem<FsNodeData>) => {
    setFocusedItem(item.index);
  }, []);

  // 搜索过滤：本地已加载节点过滤 + 后端全文搜索
  const { displayItems, isSearching } = useMemo(() => {
    const searching = searchQuery.trim().length > 0;
    if (!searching) {
      const items = showFiles ? treeItems : hideFileItems(treeItems);
      return { displayItems: items, isSearching: false };
    }
    if (searchTreeItems) {
      return { displayItems: searchTreeItems, isSearching: true };
    }
    const result = filterTreeItems(treeItems, searchQuery.trim(), showFiles);
    return { displayItems: result.items, isSearching: true };
  }, [treeItems, searchQuery, showFiles, searchTreeItems]);

  // 后端全文搜索：debounce 300ms，流式接收进度并增量渲染
  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) {
      setSearchTreeItems(null);
      setSearchDuration(null);
      setSearchLoading(false);
      return;
    }

    // 新搜索：重置自动展开记录与已加载目录记录，让新结果可被自动展开/重新加载
    autoExpandedRef.current = new Set();
    loadedDirsRef.current.clear();

    // 搜索范围限定到当前选中文件夹的子树（无选中时退化为所有盘符根）
    const searchRoots = selectedPathRef.current ? [selectedPathRef.current] : rootsRef.current;

    setSearchLoading(true);
    const allMatches = new Map<string, SearchMatch>();
    const rebuild = () => {
      const matches = Array.from(allMatches.values());
      const filtered = showFiles ? matches : matches.filter((m) => m.isDir);
      setSearchTreeItems(buildSearchTree(filtered, searchRoots, t("filePicker.thisPc")));
    };

    let cleanup: (() => void) | null = null;
    const timer = setTimeout(() => {
      cleanup = searchFilesStream(
        query,
        {
          roots: searchRoots,
          maxResults: showFiles ? 50 : 200,
          showHidden: showHiddenRef.current,
          onlyDirs: !showFiles,
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
    // 依赖 searchQuery / showFiles / showHidden：搜索中切换「显示隐藏目录」也要以
    // 新的 showHidden 重新触发搜索（showHiddenRef 在流启动时读取，effect 不重跑则用旧值）。
  }, [searchQuery, showFiles, showHidden]);

  // 搜索结果出现时，把有子节点的节点合并到 expandedItems 中（允许用户后续折叠）。
  // 仅展开「首次出现」的可展开节点：增量更新时已被自动展开过的节点不重展开，
  // 避免用户折叠后被下一批结果重置。
  useEffect(() => {
    if (!searchTreeItems) return;
    const needExpand: TreeItemIndex[] = [];
    for (const [id, item] of Object.entries(searchTreeItems)) {
      if (item.children && item.children.length > 0 && item.isFolder && !autoExpandedRef.current.has(id)) {
        needExpand.push(id);
        autoExpandedRef.current.add(id);
      }
    }
    if (needExpand.length === 0) return;
    setExpandedItems(prev => Array.from(new Set([...prev, ...needExpand])));
  }, [searchTreeItems]);

  const hasSearchResults = isSearching
    ? Object.keys(displayItems).length > 1
    : true;

  const viewState = useMemo(() => ({
    "dir-tree": {
      expandedItems,
      focusedItem,
      selectedItems,
    },
  }), [expandedItems, focusedItem, selectedItems]);

  return (
    <>
      <style>{TREE_STYLES}</style>
      <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" data-testid="dir-picker">
      <div className="bg-surface w-[600px] max-h-[80vh] rounded-lg flex flex-col border border-hairline shadow-lg">
        <div className="p-4 border-b border-hairline flex items-center justify-between gap-3">
          <div className="text-primary font-medium truncate">
            {t("dirPicker.title")}
            {selectedPath && <span className="ml-3 text-xs text-brand font-mono">{selectedPath}</span>}
          </div>
          <div className="relative flex items-center">
            <input
              type="text"
              className="w-48 px-3 py-1.5 text-sm border border-hairline rounded bg-surface-elevated text-primary placeholder:text-tertiary focus:outline-none focus:border-brand pr-8"
              placeholder={t("filePicker.searchPlaceholder")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              data-testid="dir-search"
            />
            {searchLoading && (
              <span
                className="absolute right-2 w-3.5 h-3.5 border-2 border-hairline border-t-brand rounded-full animate-spin"
                data-testid="dir-search-loading"
              />
            )}
          </div>
        </div>
        <div className="flex-1 overflow-auto p-2 text-primary" style={{ minHeight: 320 }}>
          {isSearching && searchLoading && !hasSearchResults ? (
            <div className="flex items-center justify-center h-32 text-sm text-tertiary">{t("filePicker.searching")}</div>
          ) : isSearching && !hasSearchResults ? (
            <div className="flex items-center justify-center h-32 text-sm text-tertiary">{t("filePicker.noMatch")}</div>
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
              <span className="inline-flex items-center gap-1"><Icon name={item.isFolder ? "folder" : "file"} size={12} />{item.data?.name}</span>
            )}
          >
            <Tree treeId="dir-tree" rootItem="root" treeLabel={t("dirPicker.treeLabel")} />
          </ControlledTreeEnvironment>
          )}
        </div>
        <div className="p-3 border-t border-hairline flex gap-2 justify-between items-center">
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
            {t("filePicker.showHidden")}
          </label>
          <div className="flex gap-2">
          <button onClick={onCancel} className="px-3 py-1 text-sm text-secondary hover:text-primary" data-testid="dir-cancel">{t("common.cancel")}</button>
          <button
            onClick={() => selectedPath && onPick(selectedPath)}
            disabled={!selectedPath}
            className="px-3 py-1 text-sm rounded bg-brand text-white disabled:opacity-40"
            data-testid="dir-pick"
          >{t("dirPicker.pick")}</button>
          </div>
        </div>
      </div>
    </div>
    </>
  );
}
