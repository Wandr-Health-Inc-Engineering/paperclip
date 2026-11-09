import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Compass } from "lucide-react";
import { SidebarNavItem } from "../SidebarNavItem";
import { useCompany } from "../../context/CompanyContext";
import { Link, useNavigate } from "../../lib/router";
import { tethrApi, tethrKeys } from "@/api/tethr";
import { sessionStorageOrNull } from "@/lib/tethr-intro";

// Phase 20: point at the setup until it's done (sidebar item + a chat nudge).
// 2026-11-08: a first launch lands on the setup welcome instead of the chat.

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

/** On the first chat of a session, before setup is done, go to the setup
 * welcome instead. Once per window, so "Look around first" and the goals
 * interview's chat link still land in the chat. */
export function useFirstRunToSetup(enabled: boolean): void {
  const incomplete = useSetupIncomplete();
  const navigate = useNavigate();
  useEffect(() => {
    if (!enabled || !incomplete) return;
    if (sessionStorageOrNull()?.getItem(FIRST_RUN_KEY)) return;
    rememberSetupSeen();
    navigate("/setup", { replace: true });
  }, [enabled, incomplete, navigate]);
}
