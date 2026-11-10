import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Compass } from "lucide-react";
import { SidebarNavItem } from "../SidebarNavItem";
import { useCompany } from "../../context/CompanyContext";
import { Link, useLocation, useNavigate } from "../../lib/router";
import { tethrApi, tethrKeys } from "@/api/tethr";
import { sessionStorageOrNull } from "@/lib/tethr-intro";

// Phase 20: point at the setup until it's done (sidebar item + a chat nudge).
// 2026-11-08: a first launch lands on the setup welcome instead of the chat.
// Phase 27: from any page, not only the chat.

/** Set once this window has shown you the setup, so the chat stays reachable after. */
const FIRST_RUN_KEY = "tethr.setup.landed";

function useSetupIncomplete(): boolean {
  const { selectedCompanyId } = useCompany();
  const c = selectedCompanyId ?? "";
  const { data } = useQuery({
    queryKey: tethrKeys.setup(c),
    queryFn: () => tethrApi.setup(c),
    enabled: !!selectedCompanyId,
    staleTime: 60_000,
  });
  return !!data && !data.state.completedAt;
}

export function TethrSetupNavItem() {
  return useSetupIncomplete() ? <SidebarNavItem to="/setup" label="Set up tethr" icon={Compass} /> : null;
}

export function TethrSetupNudge() {
  if (!useSetupIncomplete()) return null;
  return (
    <Link
      to="/setup"
      className="tethr-glass mx-auto flex w-fit items-center gap-2 whitespace-nowrap rounded-full px-3.5 py-1.5 text-[12.5px] transition-colors hover:text-foreground"
    >
      <Compass className="h-3.5 w-3.5 text-muted-foreground" />
      Finish setting up tethr
    </Link>
  );
}

/** Remembers, for this window, that you've seen the setup. Called by the
 * setup page itself and by the first-run redirect. */
export function rememberSetupSeen(): void {
  try {
    sessionStorageOrNull()?.setItem(FIRST_RUN_KEY, "1");
  } catch {
    // Private mode: the redirect may just happen once more.
  }
}

/** Whether a page is one the first-run redirect leaves alone: the setup itself,
 * and a link to one particular chat (a side chat, an agent's chat). */
export function staysPutOnFirstRun(pathname: string, search: string): boolean {
  if (/\/setup(\/|$)/.test(pathname)) return true;
  return /\/chat(\/|$)/.test(pathname) && new URLSearchParams(search).has("chat");
}

/** The first page of a window, before setup is done, becomes the setup welcome,
 * whatever page it was (2026-11-10: the app opened on a page that never checked).
 * Once per window, so "Look around first" and every later click stay where they go.
 * Mounted once by App.tsx, beside the startup intro. */
export function TethrFirstRunToSetup(): null {
  const incomplete = useSetupIncomplete();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  useEffect(() => {
    if (!incomplete) return;
    if (sessionStorageOrNull()?.getItem(FIRST_RUN_KEY)) return;
    rememberSetupSeen();
    if (staysPutOnFirstRun(pathname, search)) return;
    navigate("/setup", { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- decided once, when the setup state arrives
  }, [incomplete, navigate]);
  return null;
}
