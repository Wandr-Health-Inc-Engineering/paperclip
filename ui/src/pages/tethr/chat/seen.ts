import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { tethrApi, tethrKeys, type TethrChatRun } from "@/api/tethr";
import { seenInChat } from "@/lib/tethr-notify-seen";

/** True while the page is in front (not a background tab or a hidden app window). */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

/**
 * While this chat is open in front of you, its notifications are read: the bell
 * doesn't ring for a card or a report you're looking at (lib/tethr-notify-seen.ts).
 */
export function useNotificationsSeenHere(companyId: string, threadId: string | null, mainThreadId: string, runs: TethrChatRun[] | undefined): void {
  const queryClient = useQueryClient();
  const visible = usePageVisible();
  // Marked once each: the chat's runs refresh every half second while a turn streams.
  const sent = useRef(new Set<string>());
  // Shares the bell's query (same key), so it adds no extra polling of its own.
  const { data: notifications } = useQuery({
    queryKey: tethrKeys.notifications(companyId),
    queryFn: () => tethrApi.notifications(companyId),
    enabled: !!companyId,
    refetchInterval: 20_000,
  });
  useEffect(() => {
    if (!visible || !threadId || !runs || !notifications) return;
    const ids = seenInChat(notifications, {
      threadId,
      mainThreadId,
      runIds: new Set(runs.map((r) => r.id)),
      outputIds: new Set(runs.flatMap((r) => [...r.outputs, ...(r.needsYou?.approvals ?? [])].map((o) => o.id))),
    });
    const fresh = ids.filter((id) => !sent.current.has(id));
    if (!fresh.length) return;
    for (const id of fresh) sent.current.add(id);
    void Promise.allSettled(fresh.map((id) => tethrApi.markNotificationRead(companyId, id))).then(() =>
      queryClient.invalidateQueries({ queryKey: tethrKeys.notifications(companyId) }),
    );
  }, [visible, threadId, mainThreadId, runs, notifications, companyId, queryClient]);
}
