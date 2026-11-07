import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Cloud,
  Eye,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  LayoutGrid,
  List,
  Maximize2,
  Minimize2,
  PanelRight,
  Pencil,
  Plus,
  Search,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { DriveSource, FmItem } from "./adapters";
import { FolderDialog } from "./FolderDialog";
import { FileGlyph, PreviewBody, fileKind, formatBytes, formatFinderDate } from "./filePreview";

// The Drive as a Finder window: a sidebar of locations, a toolbar (back /
// forward, view, new folder, rename, archive, preview, search, full screen),
// a list or icon view, a preview pane, Quick Look, and a path bar. One
// component serves the page and the full-screen viewer, so browsing and
// reading work the same way in both. Every surface is opaque (tethr-window).
//
// Keys: arrows select · Return / Cmd+Down / double-click open · Cmd+Up or
// Backspace go up · Space Quick Look · Cmd+[ / Cmd+] back / forward · Esc.

export interface FinderLocation {
  id: string;
  label: string;
  /** Sidebar section heading. */
  group: string;
  icon: "cloud" | "drive" | "folder";
  source: DriveSource;
  /** Shown in the status bar, e.g. "Syncs to Google Drive". */
  note?: string;
  /** Present for user-added folders: removes it from the sidebar (the folder itself is untouched). */
  onRemove?: () => void;
}

interface Crumb {
  ref: string;
  name: string;
}
interface Place {
  locId: string;
  crumbs: Crumb[];
}
type SortKey = "name" | "modified" | "size" | "kind";
type ViewMode = "list" | "grid";
type MenuEntry = "sep" | { label: string; icon?: ReactNode; hint?: string; checked?: boolean; onSelect: () => void };

const VIEW_PREF = "tethr.finder.view";
const PREVIEW_PREF = "tethr.finder.preview";
const LOCATION_ICONS = { cloud: Cloud, drive: HardDrive, folder: Folder } as const;

// List columns collapse by the list's own width (container queries), not the
// viewport, because the sidebar and preview pane eat into it.
const LIST_COLS =
  "grid-cols-[minmax(0,1fr)] @md/list:grid-cols-[minmax(0,1fr)_160px] @xl/list:grid-cols-[minmax(0,1fr)_160px_72px] @3xl/list:grid-cols-[minmax(0,1fr)_160px_72px_150px]";

function readPref<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const v = window.localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function writePref(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage blocked: the preference just isn't remembered */
  }
}

function rootPlace(l: FinderLocation): Place {
  return { locId: l.id, crumbs: [{ ref: "", name: l.label }] };
}

export function Finder(props: {
  locations: FinderLocation[];
  onAddLocation?: () => void;
  /** Sidebar group the "Add folder…" row sits in. */
  addLocationGroup?: string;
  fullscreen: boolean;
  onFullscreenChange: (next: boolean) => void;
}) {
  if (!props.locations.length) return null;
  return <FinderWindow {...props} />;
}

function FinderWindow({
  locations,
  onAddLocation,
  addLocationGroup,
  fullscreen,
  onFullscreenChange,
}: {
  locations: FinderLocation[];
  onAddLocation?: () => void;
  addLocationGroup?: string;
  fullscreen: boolean;
  onFullscreenChange: (next: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const firstLoc = locations[0];

  // ---- navigation: a back/forward history of places ----------------------
  const [history, setHistory] = useState<Place[]>(() => [rootPlace(firstLoc)]);
  const [hIndex, setHIndex] = useState(0);
  const navigated = useRef(false);
  const locIds = locations.map((l) => l.id).join("|");

  // Until the user navigates, follow the default location (00 Tethr arrives
  // once status loads). If the open location disappears, fall back to it.
  useEffect(() => {
    const placeNow = history[hIndex];
    const exists = locations.some((l) => l.id === placeNow?.locId);
    if (!exists || (!navigated.current && placeNow.locId !== firstLoc.id)) {
      setHistory([rootPlace(firstLoc)]);
      setHIndex(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstLoc.id, locIds]);

  const place = history[hIndex] ?? rootPlace(firstLoc);
  const loc = locations.find((l) => l.id === place.locId) ?? firstLoc;
  const crumbs = place.crumbs;
  const current = crumbs[crumbs.length - 1];
  const source = loc.source;

  const go = (next: Place) => {
    navigated.current = true;
    setHistory((h) => [...h.slice(0, hIndex + 1), next]);
    setHIndex(hIndex + 1);
  };
  const canBack = hIndex > 0;
  const canForward = hIndex < history.length - 1;
  const back = () => canBack && setHIndex(hIndex - 1);
  const forward = () => canForward && setHIndex(hIndex + 1);
  const goToCrumb = (index: number) => {
    if (index >= 0 && index < crumbs.length - 1) go({ locId: loc.id, crumbs: crumbs.slice(0, index + 1) });
  };
  const goUp = () => goToCrumb(crumbs.length - 2);
  const goLocation = (l: FinderLocation) => {
    if (l.id !== loc.id || crumbs.length > 1) go(rootPlace(l));
  };
  const openFolder = (item: FmItem) =>
    go({ locId: loc.id, crumbs: [...crumbs, { ref: item.key, name: item.name }] });

  // ---- view state ---------------------------------------------------------
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [view, setViewState] = useState<ViewMode>(() => readPref<ViewMode>(VIEW_PREF, "list", ["list", "grid"]));
  const [showPreview, setShowPreviewState] = useState(
    () => readPref<"on" | "off">(PREVIEW_PREF, "on", ["on", "off"]) === "on",
  );
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const [quickLook, setQuickLook] = useState(false);
  const [dialog, setDialog] = useState<{ type: "newFolder" } | { type: "rename"; item: FmItem } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; item: FmItem | null } | null>(null);
  const [dragItem, setDragItem] = useState<FmItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const coarse = useMemo(
    () => typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches,
    [],
  );

  const setView = (v: ViewMode) => {
    setViewState(v);
    writePref(VIEW_PREF, v);
  };
  const setShowPreview = (v: boolean) => {
    setShowPreviewState(v);
    writePref(PREVIEW_PREF, v ? "on" : "off");
  };

  const placeKey = `${loc.id}::${current.ref}`;
  useEffect(() => {
    setSelectedKey(null);
    setQuery("");
    setQuickLook(false);
  }, [placeKey]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(t);
  }, [notice]);

  // Entering full screen: put keyboard focus in the file list.
  useEffect(() => {
    if (!fullscreen) return;
    const raf = requestAnimationFrame(() => contentRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(raf);
  }, [fullscreen]);

  // ---- data ----------------------------------------------------------------
  const { data: items, isLoading, error } = useQuery({
    queryKey: source.listKey(current.ref),
    queryFn: () => source.list(current.ref),
  });

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (items ?? []).filter((i) => !q || i.name.toLowerCase().includes(q));
    const byName = (a: FmItem, b: FmItem) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    const cmp = (a: FmItem, b: FmItem): number => {
      switch (sort.key) {
        case "modified":
          return (Date.parse(a.modifiedAt ?? "") || 0) - (Date.parse(b.modifiedAt ?? "") || 0);
        case "size":
          return (a.size ?? -1) - (b.size ?? -1);
        case "kind":
          return fileKind(a).localeCompare(fileKind(b));
        default:
          return byName(a, b);
      }
    };
    return [...list].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1; // folders on top
      return cmp(a, b) * sort.dir || byName(a, b);
    });
  }, [items, query, sort]);

  const selected = visible.find((i) => i.key === selectedKey) ?? null;
  const archiveName = source.isFs ? "99 Archive" : "the archive";

  const refresh = () => queryClient.invalidateQueries({ queryKey: source.invalidateKey });
  const fail = (e: unknown) => setNotice(e instanceof Error ? e.message : "That didn't work.");
  const moveMut = useMutation({
    mutationFn: ({ key, toRef }: { key: string; toRef: string }) => source.move(key, toRef),
    onSuccess: refresh,
    onError: fail,
  });
  const archiveMut = useMutation({
    mutationFn: (key: string) => source.archive(key),
    onSuccess: (_r, key) => {
      if (selectedKey === key) setSelectedKey(null);
      setQuickLook(false);
      setNotice(`Moved to ${archiveName}`);
      refresh();
    },
    onError: fail,
  });

  // ---- actions ---------------------------------------------------------------
  const open = (item: FmItem) => {
    if (item.kind === "folder") openFolder(item);
    else {
      setSelectedKey(item.key);
      setQuickLook(true);
    }
  };
  const rename = (item: FmItem | null) => item && setDialog({ type: "rename", item });
  const archive = (item: FmItem | null) => item && archiveMut.mutate(item.key);

  const scrollToKey = (key: string) =>
    requestAnimationFrame(() =>
      contentRef.current
        ?.querySelector(`[data-key="${CSS.escape(key)}"]`)
        ?.scrollIntoView({ block: "nearest" }),
    );
  const moveSelection = (delta: number) => {
    if (!visible.length) return;
    const i = visible.findIndex((x) => x.key === selectedKey);
    const next = i === -1 ? (delta > 0 ? 0 : visible.length - 1) : Math.min(visible.length - 1, Math.max(0, i + delta));
    setSelectedKey(visible[next].key);
    scrollToKey(visible[next].key);
  };
  const gridColumns = () => {
    const el = gridRef.current;
    if (!el) return 1;
    return Math.max(1, getComputedStyle(el).gridTemplateColumns.split(" ").filter(Boolean).length);
  };
  const closeMenu = useCallback(() => setMenu(null), []);
  const escape = () => {
    if (menu) setMenu(null);
    else if (quickLook) setQuickLook(false);
    else if (fullscreen) onFullscreenChange(false);
    else setSelectedKey(null);
  };

  function onContentKey(e: React.KeyboardEvent) {
    if ((e.target as HTMLElement).closest("input, textarea, select")) return;
    const meta = e.metaKey || e.ctrlKey;
    const step = view === "grid" ? gridColumns() : 1;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (meta) {
          if (selected) open(selected);
        } else moveSelection(step);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (meta) goUp();
        else moveSelection(-step);
        break;
      case "ArrowRight":
        if (view === "grid") {
          e.preventDefault();
          moveSelection(1);
        }
        break;
      case "ArrowLeft":
        if (view === "grid") {
          e.preventDefault();
          moveSelection(-1);
        }
        break;
      case "Enter":
        if (selected) {
          e.preventDefault();
          open(selected);
        }
        break;
      case "Backspace":
        e.preventDefault();
        goUp();
        break;
      case " ":
        if (selected?.kind === "file") {
          e.preventDefault();
          setQuickLook((v) => !v);
        }
        break;
      case "Escape":
        e.preventDefault();
        escape();
        break;
      case "[":
        if (meta) {
          e.preventDefault();
          back();
        }
        break;
      case "]":
        if (meta) {
          e.preventDefault();
          forward();
        }
        break;
      case "o":
        if (meta && selected) {
          e.preventDefault();
          open(selected);
        }
        break;
    }
  }

  // Keys that arrive while focus is outside the file list (Quick Look open,
  // full screen just opened, a toolbar button focused).
  const outsideKey = useRef<(e: KeyboardEvent) => void>(() => {});
  outsideKey.current = (e: KeyboardEvent) => {
    if (contentRef.current?.contains(document.activeElement)) return;
    if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      escape();
    } else if (quickLook && e.key === " ") {
      e.preventDefault();
      setQuickLook(false);
    } else if (quickLook && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      moveSelection(e.key === "ArrowDown" ? 1 : -1);
    }
  };
  const listening = quickLook || fullscreen || !!menu;
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => outsideKey.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [listening]);

  // ---- pointer ---------------------------------------------------------------
  const onItemClick = (item: FmItem) => {
    setSelectedKey(item.key);
    contentRef.current?.focus({ preventScroll: true });
    if (coarse) open(item); // touch: a tap opens, there is no double-click
  };
  const openMenu = (e: React.MouseEvent, item: FmItem | null) => {
    e.preventDefault();
    e.stopPropagation();
    if (item) setSelectedKey(item.key);
    contentRef.current?.focus({ preventScroll: true });
    setMenu({ x: e.clientX, y: e.clientY, item });
  };

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 8 } }),
  );
  const onDragStart = (e: DragStartEvent) => setDragItem(visible.find((i) => i.key === e.active.id) ?? null);
  const onDragEnd = (e: DragEndEvent) => {
    setDragItem(null);
    if (!e.over) return;
    const key = String(e.active.id);
    const overId = String(e.over.id);
    const toRef = overId.startsWith("up:") ? overId.slice(3) : overId;
    if (toRef === key || toRef === current.ref) return;
    moveMut.mutate({ key, toRef });
  };

  const menuEntries = (item: FmItem | null): MenuEntry[] =>
    item
      ? [
          item.kind === "folder"
            ? { label: "Open", icon: <FolderOpen className="h-3.5 w-3.5" />, hint: "↩", onSelect: () => open(item) }
            : { label: "Quick Look", icon: <Eye className="h-3.5 w-3.5" />, hint: "Space", onSelect: () => open(item) },
          "sep",
          { label: "Rename…", icon: <Pencil className="h-3.5 w-3.5" />, onSelect: () => rename(item) },
          { label: `Move to ${archiveName}`, icon: <Archive className="h-3.5 w-3.5" />, onSelect: () => archive(item) },
        ]
      : [
          { label: "New folder…", icon: <FolderPlus className="h-3.5 w-3.5" />, onSelect: () => setDialog({ type: "newFolder" }) },
          "sep",
          { label: "as List", icon: <List className="h-3.5 w-3.5" />, checked: view === "list", onSelect: () => setView("list") },
          { label: "as Icons", icon: <LayoutGrid className="h-3.5 w-3.5" />, checked: view === "grid", onSelect: () => setView("grid") },
          "sep",
          {
            label: showPreview ? "Hide preview" : "Show preview",
            icon: <PanelRight className="h-3.5 w-3.5" />,
            onSelect: () => setShowPreview(!showPreview),
          },
        ];

  // ---- render ----------------------------------------------------------------
  const LocIcon = LOCATION_ICONS[loc.icon];
  const groups = useMemo(() => {
    const map = new Map<string, FinderLocation[]>();
    for (const l of locations) map.set(l.group, [...(map.get(l.group) ?? []), l]);
    if (onAddLocation && addLocationGroup && !map.has(addLocationGroup)) map.set(addLocationGroup, []);
    return [...map.entries()];
  }, [locations, onAddLocation, addLocationGroup]);

  const search = (className: string) => (
    <label className={cn("relative flex items-center", className)}>
      <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 tethr-text-3" />
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setQuery("");
            contentRef.current?.focus();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            contentRef.current?.focus();
            moveSelection(1);
          }
        }}
        placeholder="Search"
        aria-label="Search this folder"
        className="h-7 w-full min-w-0 rounded-[8px] border border-[var(--tethr-rim-strong)] bg-[var(--tethr-window)] pl-7 pr-2 text-[12.5px] outline-none placeholder:text-[var(--tethr-text-3)] focus:border-[var(--foreground)]"
      />
    </label>
  );

  const windowEl = (
    <div
      className={cn(
        "tethr-finder tethr-window @container/win flex min-h-0 min-w-0 flex-col overflow-hidden",
        fullscreen ? "tethr-window-lifted h-full w-full" : "h-[min(74vh,760px)] min-h-[440px]",
      )}
    >
      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        {/* Toolbar */}
        <div className="tethr-window-bar flex h-12 shrink-0 items-center gap-1 border-b tethr-rule px-2 @lg/win:px-3">
          <ToolButton title="Back (Cmd+[)" onClick={back} disabled={!canBack}>
            <ChevronLeft className="h-4 w-4" />
          </ToolButton>
          <ToolButton title="Forward (Cmd+])" onClick={forward} disabled={!canForward}>
            <ChevronRight className="h-4 w-4" />
          </ToolButton>
          <span className="ml-1.5 min-w-0 flex-1 truncate text-[13.5px] font-medium tracking-[-0.01em]">
            {current.name}
          </span>
          <div className="mr-1 flex items-center rounded-full p-0.5 shadow-[inset_0_0_0_1px_var(--tethr-rim-strong)]">
            <ToolButton title="View as list" onClick={() => setView("list")} active={view === "list"} small>
              <List className="h-3.5 w-3.5" />
            </ToolButton>
            <ToolButton title="View as icons" onClick={() => setView("grid")} active={view === "grid"} small>
              <LayoutGrid className="h-3.5 w-3.5" />
            </ToolButton>
          </div>
          <ToolButton title="New folder" onClick={() => setDialog({ type: "newFolder" })}>
            <FolderPlus className="h-4 w-4" />
          </ToolButton>
          <ToolButton title="Rename" onClick={() => rename(selected)} disabled={!selected}>
            <Pencil className="h-3.5 w-3.5" />
          </ToolButton>
          <ToolButton title={`Move to ${archiveName}`} onClick={() => archive(selected)} disabled={!selected}>
            <Archive className="h-3.5 w-3.5" />
          </ToolButton>
          <span className="hidden @4xl/win:inline-flex">
            <ToolButton
              title={showPreview ? "Hide preview" : "Show preview"}
              onClick={() => setShowPreview(!showPreview)}
              active={showPreview}
            >
              <PanelRight className="h-4 w-4" />
            </ToolButton>
          </span>
          {search("ml-1 hidden w-44 @2xl/win:flex")}
          <ToolButton
            title={fullscreen ? "Exit full screen (Esc)" : "Full screen"}
            onClick={() => onFullscreenChange(!fullscreen)}
          >
            {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </ToolButton>
        </div>

        {/* Narrow windows: the sidebar becomes a location picker beside search. */}
        <div className="tethr-window-bar flex shrink-0 items-center gap-2 border-b tethr-rule px-2 py-1.5 @2xl/win:hidden">
          <select
            value={loc.id}
            onChange={(e) => {
              const l = locations.find((x) => x.id === e.target.value);
              if (l) goLocation(l);
            }}
            aria-label="Location"
            className="h-7 min-w-0 flex-1 rounded-[8px] border border-[var(--tethr-rim-strong)] bg-[var(--tethr-window)] px-2 text-[12.5px] outline-none"
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
          {search("w-[45%]")}
        </div>

        <div className="flex min-h-0 flex-1">
          {/* Sidebar */}
          <nav
            aria-label="Locations"
            className="tethr-window-side hidden w-[184px] shrink-0 flex-col gap-4 overflow-y-auto border-r tethr-rule px-2 py-3 @2xl/win:flex"
          >
            {groups.map(([group, locs]) => (
              <div key={group} className="flex flex-col gap-px">
                <p className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">{group}</p>
                {locs.map((l) => (
                  <SidebarLocation
                    key={l.id}
                    location={l}
                    active={l.id === loc.id}
                    onSelect={() => goLocation(l)}
                  />
                ))}
                {onAddLocation && group === addLocationGroup ? (
                  <button
                    onClick={onAddLocation}
                    className="flex h-7 items-center gap-2 rounded-md px-2 text-left text-[13px] text-muted-foreground transition-colors hover:bg-[var(--tethr-select-blur)] hover:text-foreground"
                  >
                    <Plus className="h-4 w-4 shrink-0" strokeWidth={1.5} />
                    Add folder…
                  </button>
                ) : null}
              </div>
            ))}
          </nav>

          {/* Files */}
          <div
            ref={contentRef}
            tabIndex={0}
            role="listbox"
            aria-label={`Files in ${current.name}`}
            onKeyDown={onContentKey}
            onMouseDown={(e) => {
              if (!(e.target as HTMLElement).closest("[data-key], button")) setSelectedKey(null);
            }}
            onContextMenu={(e) => openMenu(e, null)}
            className="@container/list flex min-h-0 min-w-0 flex-1 flex-col outline-none"
          >
            {view === "list" ? (
              <div
                className={cn(
                  "grid h-7 shrink-0 items-center gap-3 border-b tethr-rule px-3 text-[11.5px] text-muted-foreground",
                  LIST_COLS,
                )}
              >
                <HeaderCell label="Name" k="name" sort={sort} onSort={setSortKey} />
                <HeaderCell label="Date Modified" k="modified" sort={sort} onSort={setSortKey} className="hidden @md/list:flex" />
                <HeaderCell label="Size" k="size" sort={sort} onSort={setSortKey} className="hidden justify-end @xl/list:flex" />
                <HeaderCell label="Kind" k="kind" sort={sort} onSort={setSortKey} className="hidden @3xl/list:flex" />
              </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
              {isLoading ? (
                <p className="px-3 py-6 font-mono text-[11px] tethr-text-3">Loading…</p>
              ) : error ? (
                <p className="px-3 py-10 text-center text-[13px] text-muted-foreground">
                  Couldn't read this folder.{source.isFs ? " Is Google Drive for desktop running?" : ""}
                </p>
              ) : !visible.length ? (
                <p className="px-3 py-10 text-center text-[13px] text-muted-foreground">
                  {query ? `Nothing here matches “${query}”.` : "This folder is empty."}
                </p>
              ) : view === "list" ? (
                <div>
                  {visible.map((item, index) => (
                    <ListRow
                      key={item.key}
                      item={item}
                      striped={index % 2 === 1}
                      selected={item.key === selectedKey}
                      onClick={() => onItemClick(item)}
                      onDoubleClick={() => open(item)}
                      onContextMenu={(e) => openMenu(e, item)}
                    />
                  ))}
                </div>
              ) : (
                <div ref={gridRef} className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-1 p-2">
                  {visible.map((item) => (
                    <GridTile
                      key={item.key}
                      item={item}
                      selected={item.key === selectedKey}
                      onClick={() => onItemClick(item)}
                      onDoubleClick={() => open(item)}
                      onContextMenu={(e) => openMenu(e, item)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Preview pane: the reader in full screen, a glance on the page. */}
          {showPreview ? (
            <aside
              aria-label="Preview"
              className={cn(
                "hidden min-h-0 shrink-0 flex-col border-l tethr-rule bg-[var(--tethr-window)]",
                fullscreen ? "w-[50%] @3xl/win:flex" : "w-[340px] @4xl/win:flex",
              )}
            >
              <PreviewPane
                location={loc}
                item={selected}
                count={visible.length}
                full={fullscreen}
                onOpen={() => selected && open(selected)}
              />
            </aside>
          ) : null}
        </div>

        {/* Path bar + status */}
        <div className="tethr-window-bar flex h-8 shrink-0 items-center gap-3 border-t tethr-rule px-3 text-[11.5px]">
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
            <LocIcon className="mr-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.5} />
            {crumbs.map((crumb, index) => (
              <PathCrumb
                key={`${crumb.ref}-${index}`}
                crumb={crumb}
                isLast={index === crumbs.length - 1}
                showChevron={index > 0}
                onClick={() => goToCrumb(index)}
              />
            ))}
          </div>
          <span className={cn("shrink-0 truncate", notice ? "text-foreground" : "tethr-text-3")}>
            {notice ??
              `${visible.length} ${visible.length === 1 ? "item" : "items"}${selected ? ", 1 selected" : ""}${
                loc.note ? ` · ${loc.note}` : ""
              }`}
          </span>
        </div>

        <DragOverlay>
          {dragItem ? (
            <div className="tethr-window tethr-window-lifted flex items-center gap-2 px-3 py-1.5 text-[13px]">
              <FileGlyph item={dragItem} className="h-4 w-4 text-muted-foreground" />
              {dragItem.name}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );

  function setSortKey(k: SortKey) {
    setSort((s) => (s.key === k ? { key: k, dir: s.dir === 1 ? -1 : 1 } : { key: k, dir: k === "modified" ? -1 : 1 }));
  }

  return (
    <>
      {fullscreen ? (
        <>
          <div className="tethr-empty flex h-[min(74vh,760px)] min-h-[440px] items-center justify-center text-[13px] text-muted-foreground">
            Open in full screen. Press Esc to come back.
          </div>
          {createPortal(
            <div
              className="tethr-scrim fixed inset-0 z-[70] flex p-2 md:p-5"
              onMouseDown={(e) => e.target === e.currentTarget && onFullscreenChange(false)}
            >
              {windowEl}
            </div>,
            document.body,
          )}
        </>
      ) : (
        windowEl
      )}

      {quickLook && selected?.kind === "file" ? (
        <QuickLook
          source={source}
          item={selected}
          onClose={() => {
            setQuickLook(false);
            contentRef.current?.focus({ preventScroll: true });
          }}
          onRename={() => rename(selected)}
          onArchive={() => archive(selected)}
          archiveName={archiveName}
        />
      ) : null}

      {menu ? <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.item)} onClose={closeMenu} /> : null}

      {dialog?.type === "newFolder" ? (
        <FolderDialog
          title="New folder"
          confirmLabel="Create"
          hint={`In ${current.name}`}
          initial="untitled folder"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            await source.createFolder(current.ref, name);
            refresh();
            setDialog(null);
          }}
        />
      ) : null}
      {dialog?.type === "rename" ? (
        <FolderDialog
          title="Rename"
          confirmLabel="Rename"
          initial={dialog.item.name}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            await source.rename(dialog.item.key, current.ref, name);
            setSelectedKey(null);
            setQuickLook(false);
            refresh();
            setDialog(null);
          }}
        />
      ) : null}
    </>
  );
}

// ---- pieces ---------------------------------------------------------------

function ToolButton({
  title,
  onClick,
  disabled,
  active,
  small,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  small?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full text-foreground/80 transition-colors hover:bg-[var(--tethr-select-blur)] hover:text-foreground disabled:pointer-events-none disabled:opacity-30",
        small ? "h-6 w-7" : "h-7 w-7",
        active && "bg-[var(--tethr-select-blur)] text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function SidebarLocation({
  location,
  active,
  onSelect,
}: {
  location: FinderLocation;
  active: boolean;
  onSelect: () => void;
}) {
  const Icon = LOCATION_ICONS[location.icon];
  return (
    <div
      className={cn(
        "group flex h-7 items-center rounded-md transition-colors",
        active ? "bg-[var(--tethr-select-blur)]" : "hover:bg-[var(--tethr-select-blur)]",
      )}
    >
      <button
        onClick={onSelect}
        className={cn("flex h-full min-w-0 flex-1 items-center gap-2 px-2 text-left text-[13px]", active && "font-medium")}
        title={location.label}
      >
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
        <span className="truncate">{location.label}</span>
      </button>
      {location.onRemove ? (
        <button
          onClick={location.onRemove}
          title="Remove from sidebar (the folder stays in Google Drive)"
          aria-label={`Remove ${location.label} from sidebar`}
          className="mr-1 hidden h-5 w-5 shrink-0 items-center justify-center rounded-full tethr-text-3 hover:text-foreground group-hover:flex"
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  );
}

function HeaderCell({
  label,
  k,
  sort,
  onSort,
  className,
}: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; dir: 1 | -1 };
  onSort: (k: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === k;
  return (
    <button
      type="button"
      onClick={() => onSort(k)}
      className={cn("flex min-w-0 items-center gap-1 truncate text-left hover:text-foreground", active && "text-foreground", className)}
    >
      {label}
      {active ? (
        sort.dir === 1 ? (
          <ChevronUp className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronDown className="h-3 w-3 shrink-0" />
        )
      ) : null}
    </button>
  );
}

interface ItemProps {
  item: FmItem;
  selected: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

/** Shared drag (every item) + drop (folders) wiring for rows and tiles. */
function useItemDnd(item: FmItem) {
  const drag = useDraggable({ id: item.key });
  const drop = useDroppable({ id: item.key, disabled: item.kind !== "folder" });
  const setRef = useCombinedRefs(drag.setNodeRef, item.kind === "folder" ? drop.setNodeRef : null);
  return {
    setRef,
    // Spread dnd-kit's listeners/attributes, then take rows out of the tab order:
    // the list itself holds focus and arrow keys move the selection.
    bind: { ...drag.listeners, ...drag.attributes, tabIndex: -1 },
    isDragging: drag.isDragging,
    isOver: item.kind === "folder" && drop.isOver,
  };
}

function ListRow({ item, selected, striped, onClick, onDoubleClick, onContextMenu }: ItemProps & { striped: boolean }) {
  const dnd = useItemDnd(item);
  return (
    <div
      ref={dnd.setRef}
      {...dnd.bind}
      role="option"
      aria-selected={selected}
      data-key={item.key}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      className={cn(
        "grid h-[30px] cursor-default select-none items-center gap-3 rounded-md px-3 text-[13px] outline-none",
        LIST_COLS,
        selected ? "tethr-selected" : striped && "tethr-stripe",
        dnd.isOver && "ring-1 ring-inset ring-[var(--foreground)]",
        dnd.isDragging && "opacity-40",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <FileGlyph item={item} className="h-4 w-4 text-muted-foreground" />
        <span className="truncate">{item.name}</span>
      </span>
      <span className="hidden truncate text-[12px] tethr-text-3 @md/list:block">{formatFinderDate(item.modifiedAt)}</span>
      <span className="hidden truncate text-right text-[12px] tethr-text-3 @xl/list:block">
        {item.kind === "folder" ? "--" : formatBytes(item.size)}
      </span>
      <span className="hidden truncate text-[12px] tethr-text-3 @3xl/list:block">{fileKind(item)}</span>
    </div>
  );
}

function GridTile({ item, selected, onClick, onDoubleClick, onContextMenu }: ItemProps) {
  const dnd = useItemDnd(item);
  return (
    <div
      ref={dnd.setRef}
      {...dnd.bind}
      role="option"
      aria-selected={selected}
      data-key={item.key}
      title={item.name}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      className={cn(
        "flex cursor-default select-none flex-col items-center gap-1.5 rounded-lg px-1.5 pb-2 pt-3 outline-none",
        selected && "tethr-selected",
        dnd.isOver && "ring-1 ring-inset ring-[var(--foreground)]",
        dnd.isDragging && "opacity-40",
      )}
    >
      <FileGlyph item={item} className="h-10 w-10 text-muted-foreground" />
      <span className="line-clamp-2 max-w-full break-words text-center text-[12px] leading-tight">{item.name}</span>
    </div>
  );
}

/** A path-bar segment that is also a drop target (drag an item onto an ancestor to move it up). */
function PathCrumb({
  crumb,
  isLast,
  showChevron,
  onClick,
}: {
  crumb: Crumb;
  isLast: boolean;
  showChevron: boolean;
  onClick: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `up:${crumb.ref}` });
  return (
    <span className={cn("flex min-w-0 items-center gap-0.5", isLast ? "shrink-0" : "shrink")}>
      {showChevron ? <ChevronRight className="h-3 w-3 shrink-0 tethr-text-3" /> : null}
      <button
        ref={setNodeRef}
        onClick={onClick}
        className={cn(
          "truncate rounded px-1 py-0.5 transition-colors",
          isLast ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
          isOver && "bg-[var(--tethr-select)] text-[var(--tethr-select-fg)]",
        )}
      >
        {crumb.name}
      </button>
    </span>
  );
}

function PreviewPane({
  location,
  item,
  count,
  full,
  onOpen,
}: {
  location: FinderLocation;
  item: FmItem | null;
  count: number;
  full: boolean;
  onOpen: () => void;
}) {
  if (!item) {
    const Icon = LOCATION_ICONS[location.icon];
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <Icon className="h-12 w-12 text-muted-foreground" strokeWidth={1.25} />
        <p className="mt-1 text-[13.5px] font-medium">{location.label}</p>
        <p className="text-[12px] text-muted-foreground">
          {count} {count === 1 ? "item" : "items"} · select a file to preview it
        </p>
      </div>
    );
  }
  if (item.kind === "folder") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <FileGlyph item={item} className="h-14 w-14 text-muted-foreground" />
        <p className="mt-1 max-w-full truncate text-[13.5px] font-medium">{item.name}</p>
        <p className="text-[12px] text-muted-foreground">Folder</p>
        <button onClick={onOpen} className="tethr-btn tethr-btn-glass mt-2 h-8 px-3.5 text-[12.5px]">
          Open
        </button>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-start gap-3 border-b tethr-rule px-4 py-3">
        <FileGlyph item={item} className="mt-0.5 h-8 w-8 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-medium" title={item.name}>
            {item.name}
          </p>
          <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
            {fileKind(item)} · {formatBytes(item.size)} · {formatFinderDate(item.modifiedAt)}
          </p>
        </div>
        {!full ? (
          <ToolButton title="Quick Look (Space)" onClick={onOpen}>
            <Eye className="h-4 w-4" />
          </ToolButton>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <PreviewBody key={item.key} source={location.source} item={item} size={full ? "full" : "pane"} />
      </div>
    </div>
  );
}

function QuickLook({
  source,
  item,
  archiveName,
  onClose,
  onRename,
  onArchive,
}: {
  source: DriveSource;
  item: FmItem;
  archiveName: string;
  onClose: () => void;
  onRename: () => void;
  onArchive: () => void;
}) {
  return createPortal(
    <div className="tethr-scrim fixed inset-0 z-[80] flex items-center justify-center p-2 md:p-8" onClick={onClose}>
      <div
        role="dialog"
        aria-label={`Quick Look: ${item.name}`}
        className="tethr-window tethr-window-lifted flex h-full max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tethr-window-bar flex h-11 shrink-0 items-center gap-2 border-b tethr-rule px-2">
          <ToolButton title="Close (Space or Esc)" onClick={onClose}>
            <X className="h-4 w-4" />
          </ToolButton>
          <FileGlyph item={item} className="h-4 w-4 text-muted-foreground" />
          <span className="min-w-0 truncate text-[13px] font-medium">{item.name}</span>
          <span className="hidden shrink-0 text-[11.5px] text-muted-foreground sm:inline">
            · {fileKind(item)} · {formatBytes(item.size)}
          </span>
          <div className="flex-1" />
          <ToolButton title="Rename" onClick={onRename}>
            <Pencil className="h-3.5 w-3.5" />
          </ToolButton>
          <ToolButton title={`Move to ${archiveName}`} onClick={onArchive}>
            <Archive className="h-3.5 w-3.5" />
          </ToolButton>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <PreviewBody key={item.key} source={source} item={item} size="full" />
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ContextMenu({
  x,
  y,
  entries,
  onClose,
}: {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", down, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    document.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
      document.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);
  const width = 220;
  const height = entries.reduce((h, e) => h + (e === "sep" ? 9 : 28), 8);
  const left = Math.max(8, Math.min(x, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - height - 8));
  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="tethr-glass fixed z-[90] p-1"
      style={{ left, top, width }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {entries.map((entry, i) =>
        entry === "sep" ? (
          <div key={`sep-${i}`} className="mx-2 my-1 border-t tethr-rule" />
        ) : (
          <button
            key={entry.label}
            role="menuitem"
            onClick={() => {
              onClose();
              entry.onSelect();
            }}
            className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors hover:bg-[var(--tethr-select)] hover:text-[var(--tethr-select-fg)]"
          >
            <span className="flex w-4 shrink-0 justify-center">
              {entry.checked ? <Check className="h-3.5 w-3.5" /> : entry.icon}
            </span>
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            {entry.hint ? <span className="font-mono text-[10.5px] opacity-60">{entry.hint}</span> : null}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

function useCombinedRefs(...refs: Array<((node: HTMLElement | null) => void) | null>) {
  return useCallback((node: HTMLElement | null) => {
    for (const ref of refs) if (ref) ref(node);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, refs);
}
