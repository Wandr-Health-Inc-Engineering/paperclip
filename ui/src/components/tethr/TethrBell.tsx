import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Check, ExternalLink, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useCompany } from "../../context/CompanyContext";
import { useNavigate } from "../../lib/router";
import { cn } from "@/lib/utils";
import { tethrApi, tethrKeys, type TethrNotification } from "@/api/tethr";
import { MonoTag, formatRelative } from "./primitives";

// The notification bell: the in-app channel of the Notifier interface. Clicking
// a notification opens a detail popup with the actions that fit it — approve or
// reject a staged item inline, jump to the right page, or dismiss.

/** What a notification lets you do, derived from its kind + href. */
function actionsFor(n: TethrNotification): { pendingOutputId?: string; viewLabel?: string; viewTo?: string } {
  // A staged item awaiting review carries /queue/<outputId> and a "for review" title.
  if (n.href?.startsWith("/queue/") && /for review|staged/i.test(n.title)) {
    return { pendingOutputId: n.href.slice("/queue/".length) };
  }
  if (n.href?.startsWith("/queue/")) return { viewLabel: "Open the Queue", viewTo: "/queue" };
  if (n.href === "/company-view") return { viewLabel: "View on the Company page", viewTo: "/company-view" };
  if (n.href) return { viewLabel: "Open", viewTo: n.href };
  return {};
}

export function TethrBell() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<TethrNotification | null>(null);

  const { data: notifications } = useQuery({
    queryKey: tethrKeys.notifications(selectedCompanyId!),
    queryFn: () => tethrApi.notifications(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 20_000,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: tethrKeys.notifications(selectedCompanyId!) });

  const markAllRead = useMutation({
    mutationFn: () => tethrApi.markAllNotificationsRead(selectedCompanyId!),
    onSuccess: invalidate,
  });
  const markRead = useMutation({
    mutationFn: (id: string) => tethrApi.markNotificationRead(selectedCompanyId!, id),
    onSuccess: invalidate,
  });

  if (!selectedCompanyId) return null;
  const unread = notifications?.filter((n) => !n.readAt) ?? [];

  const openDetail = (n: TethrNotification) => {
    if (!n.readAt) markRead.mutate(n.id);
    setActive(n);
    setOpen(false);
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Notifications${unread.length ? ` (${unread.length} unread)` : ""}`}
            className="relative text-muted-foreground"
          >
            <Bell className="h-4 w-4" />
            {unread.length > 0 ? (
              <span className="absolute right-0.5 top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-foreground px-0.5 font-mono text-[8px] font-bold text-background">
                {unread.length > 9 ? "9+" : unread.length}
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-96 p-0">
          <div className="flex items-center justify-between border-b-2 border-foreground px-3 py-2">
            <MonoTag className="text-foreground">beacon · notifications</MonoTag>
            {unread.length > 0 ? (
              <button
                onClick={() => markAllRead.mutate()}
                className="font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground hover:text-foreground"
              >
                mark all read
              </button>
            ) : null}
          </div>
          <div className="max-h-96 overflow-auto">
            {notifications?.length ? (
              notifications.slice(0, 25).map((n) => {
                const { pendingOutputId } = actionsFor(n);
                return (
                  <button
                    key={n.id}
                    onClick={() => openDetail(n)}
                    className={cn(
                      "block w-full border-b border-border px-3 py-2.5 text-left transition-colors hover:bg-accent/50",
                      !n.readAt && "bg-secondary/60",
                    )}
                  >
                    <p className="flex items-start gap-2">
                      {!n.readAt ? (
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-foreground" />
                      ) : null}
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="block flex-1 text-sm font-semibold leading-snug">{n.title}</span>
                          {pendingOutputId ? (
                            <span className="shrink-0 border border-foreground px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.1em]">
                              needs you
                            </span>
                          ) : null}
                        </span>
                        {n.body ? (
                          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                            {n.body}
                          </span>
                        ) : null}
                        <span className="mt-1 block font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground/70">
                          {n.agentTag ? `${n.agentTag} · ` : ""}
                          {n.kind} · {formatRelative(n.createdAt)}
                        </span>
                      </span>
                    </p>
                  </button>
                );
              })
            ) : (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                Nothing yet. The crew will let you know when something needs you.
              </p>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {active ? (
        <NotificationDetail
          notification={active}
          companyId={selectedCompanyId}
          onClose={() => setActive(null)}
          onActed={invalidate}
        />
      ) : null}
    </>
  );
}

function NotificationDetail({
  notification: n,
  companyId,
  onClose,
  onActed,
}: {
  notification: TethrNotification;
  companyId: string;
  onClose: () => void;
  onActed: () => void;
}) {
  const navigate = useNavigate();
  const [note, setNote] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const { pendingOutputId, viewLabel, viewTo } = actionsFor(n);

  const decide = useMutation({
    mutationFn: (decision: "approve" | "reject") =>
      tethrApi.decide(companyId, pendingOutputId!, decision, note.trim() || undefined),
    onSuccess: (_r, decision) => {
      setResult(decision === "approve" ? "Approved — it's applied now." : "Rejected — nothing was applied.");
      onActed();
    },
    onError: (e) => setResult(e instanceof Error ? e.message : "This may have already been handled."),
  });

  const go = (to: string) => {
    onClose();
    navigate(to);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md border-2 border-foreground bg-card" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b-2 border-foreground px-4 py-3">
          <div className="min-w-0">
            <h3 className="text-sm font-bold leading-snug">{n.title}</h3>
            <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
              {n.agentTag ? `${n.agentTag} · ` : ""}
              {n.kind} · {formatRelative(n.createdAt)}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="shrink-0 text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-4 py-3">
          {n.body ? <p className="text-sm leading-relaxed text-muted-foreground">{n.body}</p> : null}

          {result ? (
            <p className="mt-3 border-2 border-foreground px-3 py-2 text-sm font-semibold">{result}</p>
          ) : pendingOutputId ? (
            <div className="mt-4 space-y-2">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional note (e.g. why you're rejecting, or a tweak to make)…"
                rows={2}
                className="w-full resize-none border-2 border-foreground bg-background px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground/60"
              />
              <div className="flex gap-2">
                <Button size="sm" className="flex-1 gap-1.5" disabled={decide.isPending} onClick={() => decide.mutate("approve")}>
                  <Check className="h-3.5 w-3.5" />
                  Approve
                </Button>
                <Button variant="outline" size="sm" className="flex-1 gap-1.5" disabled={decide.isPending} onClick={() => decide.mutate("reject")}>
                  <X className="h-3.5 w-3.5" />
                  Reject
                </Button>
              </div>
              <button
                onClick={() => go("/queue")}
                className="flex w-full items-center justify-center gap-1.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground hover:text-foreground"
              >
                Open the full Queue <ExternalLink className="h-3 w-3" />
              </button>
            </div>
          ) : null}
        </div>

        {/* Footer actions for non-approval notifications (or after a decision). */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          {result ? (
            <Button size="sm" onClick={onClose}>
              Done
            </Button>
          ) : (
            <>
              {viewTo ? (
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => go(viewTo)}>
                  <ExternalLink className="h-3.5 w-3.5" />
                  {viewLabel}
                </Button>
              ) : null}
              {!pendingOutputId ? (
                <Button size="sm" onClick={onClose}>
                  Dismiss
                </Button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
