import { useQuery } from "@tanstack/react-query";
import { Compass } from "lucide-react";
import { SidebarNavItem } from "../SidebarNavItem";
import { useCompany } from "../../context/CompanyContext";
import { Link } from "../../lib/router";
import { tethrApi, tethrKeys } from "@/api/tethr";

// Phase 20: point at the setup until it's done (sidebar item + a chat nudge).

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
      className="tethr-glass mx-auto flex w-fit items-center gap-2 rounded-full px-3.5 py-1.5 text-[12.5px] transition-colors hover:text-foreground"
    >
      <Compass className="h-3.5 w-3.5 text-muted-foreground" />
      Finish setting up tethr: goals, connections and rhythm
    </Link>
  );
}
