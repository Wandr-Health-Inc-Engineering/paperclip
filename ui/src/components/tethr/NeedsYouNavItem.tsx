import { useQuery } from "@tanstack/react-query";
import { Hand } from "lucide-react";
import { SidebarNavItem } from "../SidebarNavItem";
import { useCompany } from "../../context/CompanyContext";
import { tethrApi, tethrKeys } from "@/api/tethr";

// The sidebar's "Needs you" item (it was "Queue"): the page for everything that
// waits on a person, with how many do.

const REFRESH_MS = 20_000;

export function TethrNeedsYouNavItem() {
  const { selectedCompanyId } = useCompany();
  const c = selectedCompanyId ?? "";
  const { data } = useQuery({
    queryKey: tethrKeys.needsYou(c),
    queryFn: () => tethrApi.needsYou(c),
    enabled: !!selectedCompanyId,
    refetchInterval: REFRESH_MS,
  });
  return <SidebarNavItem to="/queue" label="Needs you" icon={Hand} badge={data?.count} />;
}
