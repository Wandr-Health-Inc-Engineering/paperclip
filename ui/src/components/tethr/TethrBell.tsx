import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useCompany } from "../../context/CompanyContext";
import { useNavigate } from "../../lib/router";
import { cn } from "@/lib/utils";
import { tethrApi, tethrKeys } from "@/api/tethr";
import { MonoTag, formatRelative } from "./primitives";

// The notification bell: the in-app channel of the Notifier interface,
// surfaced in the global toolbar. Slack/SMS/email mirror these in the cloud.

export function TethrBell() {
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data: notifications } = useQuery({
    queryKey: tethrKeys.notifications(selectedCompanyId!),
    queryFn: () => tethrApi.notifications(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 20_000,
  });

  const markAllRead = useMutation({
    mutationFn: () => tethrApi.markAllNotificationsRead(selectedCompanyId!),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: tethrKeys.notifications(selectedCompanyId!),
      }),
  });
  const markRead = useMutation({
    mutationFn: (id: string) => tethrApi.markNotificationRead(selectedCompanyId!, id),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: tethrKeys.notifications(selectedCompanyId!),
      }),
  });

  if (!selectedCompanyId) return null;
  const unread = notifications?.filter((n) => !n.readAt) ?? [];

  return (
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
            notifications.slice(0, 25).map((n) => (
              <button
                key={n.id}
                onClick={() => {
                  if (!n.readAt) markRead.mutate(n.id);
                  if (n.href) {
                    setOpen(false);
                    navigate(n.href);
                  }
                }}
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
                    <span className="block text-sm font-semibold leading-snug">{n.title}</span>
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
            ))
          ) : (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              Nothing yet. The crew will let you know when something needs you.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
