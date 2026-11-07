import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Check, ExternalLink, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useCompany } from "../../context/CompanyContext";
import { useNavigate } from "../../lib/router";
import { cn } from "@/lib/utils";
import { tethrApi, tethrKeys, type TethrNotification } from "@/api/tethr";
import { MonoTag, StatusDot, formatRelative } from "./primitives";

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

  const navigate = useNavigate();
  const { data: throttle } = useQuery({
    queryKey: tethrKeys.throttle(selectedCompanyId!),
    queryFn: () => tethrApi.throttle(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
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
      {throttle?.paused ? (
        <button
          onClick={() => navigate("/tethr-settings")}
          title="Agents are paused (usage throttle) — click to manage"
          className="tethr-pill tethr-pill-solid mr-1 h-6 px-2.5 text-[9.5px]"
        >
          <span className="tethr-dot bg-primary-foreground" />
          agents paused
        </button>
      ) : null}
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
              <span className="absolute right-0.5 top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 font-mono text-[8px] font-medium text-primary-foreground">
                {unread.length > 9 ? "9+" : unread.length}
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-96 overflow-hidden p-0">
          <div className="tethr-rule flex items-center justify-between border-b px-4 py-2.5">
            <MonoTag>beacon · notifications</MonoTag>
            {unread.length > 0 ? (
              <button
                onClick={() => markAllRead.mutate()}
                className="tethr-eyebrow transition-colors hover:text-foreground"
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
                      "tethr-rule block w-full border-b px-4 py-3 text-left transition-colors hover:bg-accent",
                      !n.readAt && "bg-[var(--tethr-frost-strong)]",
                    )}
                  >
                    <p className="flex items-start gap-2.5">
                      {!n.readAt ? (
                        <StatusDot tone={pendingOutputId ? "warn" : "live"} className="mt-[7px] animate-none" />
                      ) : (
                        <span className="mt-[7px] h-1.5 w-1.5 shrink-0" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="block flex-1 text-sm font-medium leading-snug">{n.title}</span>
                          {pendingOutputId ? (
                            <span className="tethr-pill shrink-0 px-2 py-0.5 text-[9px]">
                              needs you
                            </span>
                          ) : null}
                        </span>
                        {n.body ? (
                          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                            {n.body}
                          </span>
                        ) : null}
                        <span className="tethr-eyebrow mt-1.5 block text-[9.5px] tracking-[0.14em]">
                          {n.agentTag ? `${n.agentTag} · ` : ""}
                          {n.kind} · {formatRelative(n.createdAt)}
                        </span>
                      </span>
                    </p>
                  </button>
                );
              })
            ) : (
              <p className="px-4 py-10 text-center text-sm text-muted-foreground">
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

  // "Ask Tethr to handle this" — hand the alert to the coordinator as a task and
  // open the Console on the live run. The generic way to act on any notification.
  const dispatch = useMutation({
    mutationFn: () => {
      const context = `${n.title}${n.body ? ` — ${n.body}` : ""}`;
      const ask = note.trim()
        ? note.trim()
        : "Can you look into this and tell me how you'd handle it?";
      return tethrApi.route(companyId, `I got this alert: "${context}". ${ask}`);
    },
    onSuccess: (ids) => {
      onActed();
      onClose();
      navigate(`/console?run=${ids.routeRunId}&thread=${ids.threadId}`);
    },
    onError: (e) => setResult(e instanceof Error ? e.message : "Couldn't reach Tethr — try the Console."),
  });

  const go = (to: string) => {
    onClose();
    navigate(to);
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--tethr-overlay)] p-4 backdrop-blur-[4px]"
      onClick={onClose}
    >
      <div className="tethr-glass-heavy w-full max-w-md overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="tethr-rule flex items-start justify-between gap-3 border-b px-5 py-4">
          <div className="min-w-0">
            <h3 className="text-[15px] font-medium leading-snug tracking-[-0.01em]">{n.title}</h3>
            <p className="tethr-eyebrow mt-1 text-[9.5px] tracking-[0.14em]">
              {n.agentTag ? `${n.agentTag} · ` : ""}
              {n.kind} · {formatRelative(n.createdAt)}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="tethr-btn tethr-btn-ghost h-7 w-7 shrink-0">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          {n.body ? <p className="text-sm leading-relaxed text-muted-foreground">{n.body}</p> : null}

          {result ? (
            <p className="tethr-inset mt-3 px-3 py-2 text-sm font-medium">{result}</p>
          ) : pendingOutputId ? (
            <div className="mt-4 space-y-2">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional note (e.g. why you're rejecting, or a tweak to make)…"
                rows={2}
                className="tethr-field w-full resize-none px-3 py-2 text-sm"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  className="tethr-btn tethr-btn-primary h-9 flex-1 px-4 text-[13px]"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate("approve")}
                >
                  <Check className="h-3.5 w-3.5" />
                  Approve
                </button>
                <button
                  type="button"
                  className="tethr-btn tethr-btn-glass h-9 flex-1 px-4 text-[13px]"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate("reject")}
                >
                  <X className="h-3.5 w-3.5" />
                  Reject
                </button>
              </div>
              <button
                onClick={() => go("/queue")}
                className="tethr-eyebrow flex w-full items-center justify-center gap-1.5 py-1.5 transition-colors hover:text-foreground"
              >
                Open the full Queue <ExternalLink className="h-3 w-3" />
              </button>
            </div>
          ) : (
            // Informational: hand it to Tethr as a task, or just dismiss.
            <div className="mt-4 space-y-2">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Tell Tethr what to do about this (optional) — e.g. 'check if it's really a duplicate and advise'…"
                rows={2}
                className="tethr-field w-full resize-none px-3 py-2 text-sm"
              />
              <button
                type="button"
                className="tethr-btn tethr-btn-primary h-9 w-full px-4 text-[13px]"
                disabled={dispatch.isPending}
                onClick={() => dispatch.mutate()}
              >
                <Sparkles className="h-3.5 w-3.5" />
                {dispatch.isPending ? "Handing to Tethr…" : "Ask Tethr to handle this"}
              </button>
            </div>
          )}
        </div>

        {/* Footer: secondary navigation + dismiss (hidden when it would be empty). */}
        {result || viewTo || !pendingOutputId ? (
        <div className="tethr-rule flex items-center justify-end gap-2 border-t px-5 py-3">
          {result ? (
            <button type="button" className="tethr-btn tethr-btn-primary h-8 px-3.5 text-[13px]" onClick={onClose}>
              Done
            </button>
          ) : (
            <>
              {viewTo ? (
                <button type="button" className="tethr-btn tethr-btn-glass h-8 px-3.5 text-[13px]" onClick={() => go(viewTo)}>
                  <ExternalLink className="h-3.5 w-3.5" />
                  {viewLabel}
                </button>
              ) : null}
              {!pendingOutputId ? (
                <button type="button" className="tethr-btn tethr-btn-ghost h-8 px-3.5 text-[13px]" onClick={onClose}>
                  Dismiss
                </button>
              ) : null}
            </>
          )}
        </div>
        ) : null}
      </div>
    </div>
  );
}
