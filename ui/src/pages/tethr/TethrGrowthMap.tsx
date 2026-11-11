import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageSkeleton } from "@/components/PageSkeleton";
import { OutputPanel } from "@/components/tethr/OutputPanel";
import { Segmented } from "@/pages/tethr/setup/controls";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { useSearchParams } from "../../lib/router";
import { tethrApi, tethrKeys, type TethrAreaId, type TethrGrowthMap as GrowthMapData } from "@/api/tethr";
import { COMPACT_BELOW, earnedUnlocks, newUnlocks, readSeenUnlocks, writeSeenUnlocks, type EarnedUnlocks } from "@/lib/tethr-growth-map";
import { AreaList } from "./map/AreaList";
import { AreaPanel } from "./map/AreaPanel";
import { Galaxy } from "./map/Galaxy";
import { Overview } from "./map/Overview";

// The growth map (phase 26.9): every part of growing the company as a star on
// a galaxy, its level worked out from evidence, with the area's panel beside
// it. Map or List on a desktop; on a phone, a smaller map with the list under
// it and the panel as a sheet. Nothing runs from here except an audit a
// person starts with "Explore with tethr".

type ViewMode = "map" | "list";
const VIEW_KEY = "tethr.growthMap.view";
/** Wide enough for the map and the panel side by side. */
const TWO_COLUMNS_AT = 980;

function readViewMode(): ViewMode {
  try {
    return window.localStorage.getItem(VIEW_KEY) === "list" ? "list" : "map";
  } catch {
    return "map";
  }
}

function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Unlocks earned since this person last opened the map (they bloom once). */
function useFreshUnlocks(companyId: string | null, map: GrowthMapData | undefined): EarnedUnlocks {
  const [fresh, setFresh] = useState<EarnedUnlocks>({});
  const seen = useRef<EarnedUnlocks | null | undefined>(undefined);
  useEffect(() => {
    if (!companyId || !map) return;
    if (seen.current === undefined) seen.current = readSeenUnlocks(companyId);
    const now = earnedUnlocks(map.areas);
    const added = newUnlocks(seen.current, now);
    if (Object.keys(added).length) {
      setFresh((prev) => {
        const next = { ...prev };
        for (const [area, keys] of Object.entries(added)) next[area] = [...new Set([...(next[area] ?? []), ...keys])];
        return next;
      });
    }
    seen.current = now;
    writeSeenUnlocks(companyId, now);
  }, [companyId, map]);
  return fresh;
}

/** One page per company: switching company starts fresh (what's new, the open area, the view). */
export function TethrGrowthMap() {
  const { selectedCompanyId } = useCompany();
  return <GrowthMapPage key={selectedCompanyId ?? "none"} selectedCompanyId={selectedCompanyId ?? null} />;
}

function GrowthMapPage({ selectedCompanyId }: { selectedCompanyId: string | null }) {
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchParams, setSearchParams] = useSearchParams();
  const [mode, setMode] = useState<ViewMode>(readViewMode);
  const [file, setFile] = useState<string | null>(null);
  const [wrapRef, width] = useElementWidth<HTMLDivElement>();

  useEffect(() => {
    setBreadcrumbs([{ label: "Growth map" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, isError } = useQuery({
    queryKey: tethrKeys.growthMap(selectedCompanyId!),
    queryFn: () => tethrApi.growthMap(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });
  const fresh = useFreshUnlocks(selectedCompanyId, data);

  const selectedId = (searchParams.get("area") as TethrAreaId | null) ?? null;
  const selected = data?.areas.find((a) => a.id === selectedId) ?? null;
  const select = useCallback(
    (id: TethrAreaId | null) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id && id !== prev.get("area")) next.set("area", id);
          else next.delete("area");
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  useEffect(() => {
    if (!selected || file) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, file, select]);

  const changeMode = (next: ViewMode) => {
    setMode(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Remembering the view is a convenience only.
    }
  };

  const measured = width > 0;
  const phone = measured && width < COMPACT_BELOW;
  const twoColumns = width >= TWO_COLUMNS_AT;
  const showMap = phone || mode === "map";

  const side =
    data && selected ? (
      <AreaPanel area={selected} companyId={selectedCompanyId!} fresh={fresh[selected.id] ?? []} onClose={() => select(null)} onOpenFile={setFile} />
    ) : data ? (
      <Overview map={data} fresh={fresh} onSelect={select} />
    ) : null;

  return (
    <div ref={wrapRef} className="space-y-4">
      {isLoading || !measured ? <PageSkeleton /> : null}
      {isError ? (
        <div className="tethr-empty px-6 py-10 text-center text-[13px]">The growth map didn't load. It retries on its own.</div>
      ) : null}
      {data && measured ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-[62ch] text-[13px] text-muted-foreground">
              Every part of growing {data.company.name}, and how far along each is. Levels come only from what tethr can check;
              {phone ? " tap" : " click"} a star to see why, and what would earn the next one.
            </p>
            {phone ? (
              <p className="flex w-full items-baseline gap-2">
                <span className="tethr-eyebrow">company level</span>
                <span className="tethr-figure text-[28px]">{data.company.level}</span>
                <span className="text-[12px] text-muted-foreground">of {data.company.max}</span>
              </p>
            ) : null}
            {!phone ? (
              <Segmented
                value={mode}
                onChange={changeMode}
                options={[
                  { value: "map", label: "Map" },
                  { value: "list", label: "List" },
                ]}
              />
            ) : null}
          </div>

          <div className={twoColumns ? "grid grid-cols-[minmax(0,1fr)_360px] items-start gap-4" : "space-y-4"}>
            <div className="min-w-0 space-y-4">
              {showMap ? (
                <div className="tethr-panel tethr-galaxy overflow-hidden" data-tethr-enter>
                  <Galaxy map={data} selected={selected?.id ?? null} fresh={fresh} onSelect={select} />
                </div>
              ) : null}
              {!showMap || phone ? <AreaList map={data} selected={selected?.id ?? null} fresh={fresh} onSelect={select} /> : null}
            </div>
            {phone ? null : (
              <aside className={twoColumns ? "tethr-panel sticky top-4 max-h-[calc(100dvh-7rem)] overflow-y-auto p-5" : "tethr-panel p-5"}>{side}</aside>
            )}
          </div>

          {phone && selected ? (
            <div className="fixed inset-0 z-40 flex flex-col justify-end">
              <button type="button" className="tethr-scrim absolute inset-0" aria-label="Close" onClick={() => select(null)} />
              <div
                role="dialog"
                aria-label={selected.name}
                className="tethr-glass-heavy relative max-h-[82dvh] overflow-y-auto rounded-t-[18px] p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom,0px))]"
              >
                {side}
              </div>
            </div>
          ) : null}

          {file ? (
            <div className="pointer-events-none fixed inset-0 z-50 [&>aside]:pointer-events-auto">
              <OutputPanel
                companyId={selectedCompanyId!}
                files={[{ path: file, version: file }]}
                current={{ path: file, version: file }}
                onSelect={setFile}
                onClose={() => setFile(null)}
              />
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
