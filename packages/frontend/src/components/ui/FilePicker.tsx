// 通用文件/文件夹多选组件
// 基于 kernel fs:listDir 浏览文件系统，支持同时选择多个文件和文件夹。
// 文件会被复制到项目 .wa-pi/uploads 下；文件夹直接返回其真实路径，不再创建软链接。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ControlledTreeEnvironment,
  Tree,
  type TreeEnvironmentRef,
  type TreeItem,
  type TreeItemIndex,
} from "react-complex-tree";
import "react-complex-tree/lib/style-modern.css";
import { useTranslation } from "../../i18n/useTranslation";
import { getHome, getRoots, listDir, searchFilesStream, type SearchMatch } from "../../fs-client";
import { Icon } from "./Icon";

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
/* 让标题按钮撑满行宽，复选框才能推到最右侧 */
.rct-tree-item-button {
  flex: 1;
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

// 目录项排序：文件夹在前、文件在后；同类内按名称升序（大小写不敏感、数字自然序）。
// 选择器展示顺序以此为准。
function sortEntries<T extends { name: string; isDir: boolean }>(entries: readonly T[]): T[] {
  const byName = (a: string, b: string): number =>
    a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return byName(a.name, b.name);
  });
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
    const entries = sortEntries(
      (await listDir(currentPath, showHidden)).filter(e => showHidden || !e.name.startsWith(".")),
    );
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

  // 搜索结果同样按「先文件夹后文件」排序每个目录的子项
  const byName = (a: string, b: string): number =>
    a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
  for (const item of Object.values(items)) {
    if (item.children && item.children.length > 1) {
      item.children.sort((aId, bId) => {
        const a = items[aId]?.data;
        const b = items[bId]?.data;
        if (!a || !b) return 0;
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return byName(a.name, b.name);
      });
    }
  }

  return items;
}

export function FilePicker({ onPick, onCancel, multiSelect = true, defaultPath }: Props) {
  const { t } = useTranslation();
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
  const showHiddenRef = useRef(showHidden);
  showHiddenRef.current = showHidden;
  const rootsRef = useRef<string[]>([]);
  const envRef = useRef<TreeEnvironmentRef>(null);
  // 定位到的目录节点 id：树渲染后据此 focusItem（高亮 + 滚动到可见），执行一次后清空
  const focusTargetRef = useRef<TreeItemIndex | null>(null);
  // 当前展示数据源（搜索态用搜索树，否则浏览树）：供手风琴折叠时查找父子关系
  const displaySourceRef = useRef(treeItems);
  displaySourceRef.current = searchTreeItems ?? treeItems;
  // 用户最近聚焦的目录路径：作为搜索根的最高优先级来源
  const activeDirRef = useRef<string | null>(null);
  // 搜索词 ref：用于在事件回调中判断是否处于搜索态，避免闭包过期
  const searchQueryRef = useRef(searchQuery);
  searchQueryRef.current = searchQuery;
  const expandedItemsRef = useRef(expandedItems);
  expandedItemsRef.current = expandedItems;
  // 记录已自动展开的搜索结果节点：增量更新时只展开新出现的，不重展开用户已折叠的
  const autoExpandedRef = useRef<Set<TreeItemIndex>>(new Set());
  // 搜索树 ref + 已加载真实子目录的目录路径记录：供搜索态下展开结果目录时合并懒加载
  const searchTreeItemsRef = useRef(searchTreeItems);
  searchTreeItemsRef.current = searchTreeItems;
  const loadedDirsRef = useRef<Set<string>>(new Set());

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
      const entries = sortEntries(
        (await listDir(parent.data.path, showHiddenRef.current)).filter(e => showHiddenRef.current || !e.name.startsWith(".")),
      );
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

  // 手风琴展开：展开 item 时，折叠其同级兄弟文件夹（同一父节点下只保留一个展开）
  const handleExpandItem = useCallback((item: TreeItem<FsNodeData>) => {
    setExpandedItems((prev) => {
      const src = displaySourceRef.current;
      const parentId = findParentId(item.index, src);
      if (parentId == null) {
        return prev.includes(item.index) ? prev : [...prev, item.index];
      }
      // 同级兄弟文件夹（排除当前 item）→ 折叠
      const siblingFolders = (src[parentId].children ?? []).filter(
        (cid) => cid !== item.index && src[cid]?.isFolder,
      );
      const remove = new Set(siblingFolders);
      const kept = prev.filter((id) => !remove.has(id));
      return kept.includes(item.index) ? kept : [...kept, item.index];
    });

    // 搜索态：展开结果目录时加载其真实子目录合并进搜索树（匹配子项在前，其余追加）
    if (!item.isFolder || !item.data?.path) return;
    const path = item.data.path;
    if (!searchTreeItemsRef.current || loadedDirsRef.current.has(path)) return;
    loadedDirsRef.current.add(path);
    void (async () => {
      const entries = (await listDir(path, showHiddenRef.current))
        .filter(e => showHiddenRef.current || !e.name.startsWith("."));
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
  }, []);

  const handleCollapseItem = useCallback((item: TreeItem<FsNodeData>) => {
    setExpandedItems((prev) => prev.filter((id) => id !== item.index));
  }, []);

  // 标题点击仅聚焦/导航，不再自动选中。选中由每行右侧复选框独立控制。
  const handleSelectItems = useCallback((ids: TreeItemIndex[]) => {
    if (ids.length === 0) {
      setFocusedItem(undefined);
      return;
    }
    setFocusedItem(ids[0]);
    // 搜索过程中锁定搜索范围：不更新活动目录，避免搜索结果里的目录点击
    // 意外改写搜索根，导致后续输入跑到错误的子树去搜。
    if (searchQueryRef.current.trim()) return;
    const it = displaySourceRef.current[ids[0]];
    if (it?.data?.isDir && it.data.path) activeDirRef.current = it.data.path;
  }, []);

  const handleFocusItem = useCallback((item: TreeItem<FsNodeData>) => {
    setFocusedItem(item.index);
    // 搜索过程中锁定搜索范围，同上
    if (searchQueryRef.current.trim()) return;
    if (item.data?.isDir && item.data.path) activeDirRef.current = item.data.path;
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

  // 树渲染提交后滚动并聚焦到定位目录（effects 在 DOM 提交后运行，节点已在视口；仅执行一次）
  useEffect(() => {
    const id = focusTargetRef.current;
    if (!id) return;
    focusTargetRef.current = null;
    // 环境实际渲染的是 displayItems：搜索态为搜索树/过滤树（id 命名空间与浏览定位
    // id 不同）。id 不在其中时 focusItem 会让 react-complex-tree 读到 undefined.index
    // 抛错（Cannot read properties of undefined (reading 'index')），直接跳过。
    if (!displayItems[id]) return;
    envRef.current?.focusItem(id, "file-picker");
  }, [treeItems, displayItems]);

  // 确定搜索根：聚焦目录 > 展开链最深目录 > defaultPath > 所有盘符根
  // 用 ref 读取最新值，不作为 effect 依赖，避免搜索 effect 因引用变化重跑
  const determineSearchRootsRef = useRef<() => string[]>(() => []);
  determineSearchRootsRef.current = () => {
    if (activeDirRef.current) return [activeDirRef.current];
    const src = treeItemsRef.current;
    let deepest: string | null = null;
    for (const id of expandedItemsRef.current) {
      const it = src[id];
      if (it?.data?.isDir && (!deepest || it.data.path.length > deepest.length)) {
        deepest = it.data.path;
      }
    }
    if (deepest) return [deepest];
    if (defaultPath && defaultPath.trim()) return [defaultPath.trim()];
    return rootsRef.current;
  };

  // 后端全文搜索：debounce 300ms，流式接收进度并增量渲染。
  // 搜索范围限定到活动目录子树，搜索过程中不随聚焦变化重搜。
  // 注意：autoExpandedRef 仅在 query 真正变化时重置，避免 effect 因依赖
  //（如 determineSearchRoots 引用变化 / StrictMode 双执行）重跑时清空已展开记录，
  // 导致用户折叠的节点被下一批增量结果重新展开。
  const lastQueryRef = useRef("");
  const lastShowHiddenRef = useRef(showHidden);
  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) {
      lastQueryRef.current = "";
      lastShowHiddenRef.current = showHidden;
      setSearchTreeItems(null);
      setSearchDuration(null);
      setSearchLoading(false);
      return;
    }

    // query 或 showHidden 变化都视为新一轮搜索：重置自动展开记录，使重建时重新
    // 展开结果目录（切换隐藏开关会触发 mount effect 用浏览 id 覆盖 expandedItems，
    // 需靠重建把以 path 作 id 的搜索结果目录重新展开）。
    const queryChanged = lastQueryRef.current !== query;
    if (queryChanged || lastShowHiddenRef.current !== showHidden) {
      autoExpandedRef.current = new Set();
      loadedDirsRef.current.clear();
      lastQueryRef.current = query;
      lastShowHiddenRef.current = showHidden;
      // 仅查询文本变化才清空旧结果；隐藏开关变化保留旧结果直到新结果到达，避免闪烁
      if (queryChanged) {
        setSearchTreeItems(null);
        setSearchDuration(null);
      }
    }
    // 搜索开始时一次性确定 roots，过程中不再变化
    const searchRoots = determineSearchRootsRef.current();

    setSearchLoading(true);
    const allMatches = new Map<string, SearchMatch>();
    const rebuild = () => {
      const tree = buildSearchTree(Array.from(allMatches.values()), searchRoots, t("filePicker.thisPc"));
      // 搜索树中有子节点的目录首次出现时即标记为「已自动展开」并加入 expandedItems，
      // 使结果立即可见；同时避免后续 autoExpand effect 因 searchTreeItems 与
      // expandedItems 的 setState 批处理时序，在用户折叠后又把节点重新展开。
      const newFolderIds: TreeItemIndex[] = [];
      for (const [id, item] of Object.entries(tree)) {
        if (id !== "root" && item.children && item.children.length > 0 && item.isFolder) {
          const tid = id as TreeItemIndex;
          if (!autoExpandedRef.current.has(tid)) {
            autoExpandedRef.current.add(tid);
            newFolderIds.push(tid);
          }
        }
      }
      setSearchTreeItems(tree);
      if (newFolderIds.length > 0) {
        setExpandedItems(prev => Array.from(new Set([...prev, ...newFolderIds])));
      }
    };

    let cleanup: (() => void) | null = null;
    const timer = setTimeout(() => {
      cleanup = searchFilesStream(
        query,
        {
          roots: searchRoots,
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
    // 依赖 searchQuery 与 showHidden：搜索中切换「显示隐藏目录」也要以新的
    // showHidden 重新触发搜索（showHiddenRef 在流启动时读取，effect 不重跑则用旧值）。
  }, [searchQuery, showHidden]);

  // autoExpand effect 已被 rebuild 内联接管（rebuild 在构建搜索树时同步标记并展开新目录），
  // 此处不再重复处理，避免与 rebuild 的 setState 产生批处理时序竞态。
  // 用户折叠的节点因已在 autoExpandedRef 中记录，后续增量 rebuild 不会重新展开。

  const hasSearchResults = isSearching
    ? Object.keys(displayItems).length > 1
    : true;

  // 当前搜索范围（用于 UI 提示）：与 determineSearchRoots 同一优先级链
  const currentSearchRoot = useMemo(() => {
    if (activeDirRef.current) return activeDirRef.current;
    const src = treeItemsRef.current;
    let deepest: string | null = null;
    for (const id of expandedItems) {
      const it = src[id];
      if (it?.data?.isDir && (!deepest || it.data.path.length > deepest.length)) {
        deepest = it.data.path;
      }
    }
    if (deepest) return deepest;
    if (defaultPath && defaultPath.trim()) return defaultPath.trim();
    return rootsRef.current.length > 0 ? rootsRef.current.join(", ") : "";
  }, [expandedItems, defaultPath]);

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
        <div className="bg-surface w-[680px] max-h-[85vh] rounded-lg flex flex-col border border-hairline shadow-lg">
          <div className="p-4 border-b border-hairline flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1 min-w-0">
              <div className="text-primary font-medium truncate">
                {t("filePicker.title")}
                {selections.length > 0 && (
                  <span className="ml-3 text-xs text-brand font-mono">
                    {t("filePicker.selected", { count: selections.length })}
                  </span>
                )}
              </div>
              {currentSearchRoot && (
                <span className="text-[calc(11px*var(--font-scale))] text-tertiary max-w-[340px] truncate" data-testid="search-scope-hint" title={currentSearchRoot}>
                  {t("filePicker.searchScope", { root: currentSearchRoot })}
                </span>
              )}
            </div>
            <div className="flex flex-col items-end gap-1 shrink-0">
              <div className="relative flex items-center">
                <input
                  type="text"
                  className="w-48 px-3 py-1.5 text-sm border border-hairline rounded bg-surface-elevated text-primary placeholder:text-tertiary focus:outline-none focus:border-brand pr-8"
                  placeholder={t("filePicker.searchPlaceholder")}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  data-testid="file-picker-search"
                />
                {searchLoading && (
                  <span
                    className="absolute right-2 w-3.5 h-3.5 border-2 border-hairline border-t-brand rounded-full animate-spin"
                    data-testid="file-picker-search-loading"
                  />
                )}
              </div>
              {isSearching && searchDuration !== null && (
                <span className="text-[calc(11px*var(--font-scale))] text-tertiary" data-testid="search-duration">
                  {t("filePicker.searchDuration", { ms: searchDuration })}
                </span>
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
                  <span className="flex items-center justify-between w-full gap-3">
                    <span className="inline-flex items-center gap-1">
                      <Icon name={item.isFolder ? "folder" : "file"} size={12} />
                      {item.data?.name}
                    </span>
                    <input
                      type="checkbox"
                      data-testid="file-picker-checkbox"
                      className="w-3.5 h-3.5 accent-brand cursor-pointer shrink-0"
                      checked={selectedItems.includes(item.index)}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedItems((prev) =>
                          prev.includes(item.index)
                            ? prev.filter((id) => id !== item.index)
                            : [...prev, item.index],
                        );
                      }}
                      onChange={() => {}}
                    />
                  </span>
                )}
              >
                <Tree treeId="file-picker" rootItem="root" treeLabel={t("filePicker.treeLabel")} />
              </ControlledTreeEnvironment>
            )}
          </div>
          <div className="p-3 border-t border-hairline flex gap-2 justify-between items-center">
            <label className="flex items-center gap-2 text-xs text-tertiary cursor-pointer select-none">
              <input
                type="checkbox"
                data-testid="show-hidden-toggle"
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
              <button onClick={onCancel} className="px-3 py-1 text-sm text-secondary hover:text-primary" data-testid="file-picker-cancel">{t("common.cancel")}</button>
              <button
                onClick={() => onPick(selections)}
                disabled={selections.length === 0}
                className="px-3 py-1 text-sm rounded bg-brand text-white disabled:opacity-40"
                data-testid="file-picker-ok"
              >{t("filePicker.add")} {selections.length > 0 ? `(${selections.length})` : ""}</button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
