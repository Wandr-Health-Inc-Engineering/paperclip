import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  LogOut,
  type LucideIcon,
  Moon,
  Settings,
  UserRound,
  Sun,
  UserRoundPen,
} from "lucide-react";
import type { DeploymentMode } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { authApi } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";
import { useSidebar } from "../context/SidebarContext";
import { useTheme } from "../context/ThemeContext";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "../lib/utils";

const PROFILE_SETTINGS_PATH = "/instance/settings/profile";
const DOCS_URL = "https://docs.paperclip.ing/";

interface SidebarAccountMenuProps {
  deploymentMode?: DeploymentMode;
  instanceSettingsTarget: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  version?: string | null;
}

interface MenuActionProps {
  label: string;
  icon: LucideIcon;
  onClick?: () => void;
  href?: string;
  external?: boolean;
}

function deriveInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function deriveUserSlug(name: string | null | undefined, email: string | null | undefined, id: string | null | undefined) {
  const candidates = [name, email?.split("@")[0], email, id];
  for (const candidate of candidates) {
    const slug = candidate
      ?.trim()
      .toLowerCase()
      .replace(/['"]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (slug) return slug;
  }
  return "me";
}

function MenuAction({ label, icon: Icon, onClick, href, external = false }: MenuActionProps) {
  const className =
    "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm font-medium text-foreground transition-colors hover:bg-accent/60";

  const content = (
    <>
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </>
  );

  if (href) {
    if (external) {
      return (
        <a href={href} target="_blank" rel="noreferrer" className={className} onClick={onClick}>
          {content}
        </a>
      );
    }

    return (
      <Link to={href} className={className} onClick={onClick}>
        {content}
      </Link>
    );
  }

  return (
    <button type="button" className={className} onClick={onClick}>
      {content}
    </button>
  );
}

export function SidebarAccountMenu({
  deploymentMode,
  instanceSettingsTarget,
  open: controlledOpen,
  onOpenChange,
  version,
}: SidebarAccountMenuProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const queryClient = useQueryClient();
  const { isMobile, setSidebarOpen } = useSidebar();
  const { theme, toggleTheme } = useTheme();
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  const signOutMutation = useMutation({
    mutationFn: () => authApi.signOut(),
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
    },
  });

  const displayName = session?.user.name?.trim() || "Board";
  const secondaryLabel =
    session?.user.email?.trim() || (deploymentMode === "authenticated" ? "Signed in" : "Local workspace board");
  const accountBadge = deploymentMode === "authenticated" ? "Account" : "Local";
  const initials = deriveInitials(displayName);
  const profileHref = `/u/${deriveUserSlug(session?.user.name, session?.user.email, session?.user.id)}`;

  function closeNavigationChrome() {
    setOpen(false);
    if (isMobile) setSidebarOpen(false);
  }

  return (
    <div className="border-t border-r border-border bg-background px-3 py-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] font-medium text-foreground/80 transition-colors hover:bg-accent/50 hover:text-foreground"
            aria-label="Open account menu"
          >
            <Avatar size="sm">
              {session?.user.image ? <AvatarImage src={session.user.image} alt={displayName} /> : null}
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
            <span className="min-w-0 flex-1 truncate">{displayName}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-64 max-w-[calc(100vw-1rem)] overflow-hidden border-border p-0 shadow-2xl"
        >
          <div className="flex items-center gap-3 border-b border-border px-3 py-3">
            <Avatar size="sm">
              {session?.user.image ? <AvatarImage src={session.user.image} alt={displayName} /> : null}
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <h2 className="truncate text-sm font-semibold text-foreground">{displayName}</h2>
                <span className="shrink-0 rounded-sm bg-accent px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {accountBadge}
                </span>
              </div>
              <p className="truncate text-xs text-muted-foreground">{secondaryLabel}</p>
              {version ? (
                <p className="mt-0.5 text-[10px] text-muted-foreground/80">tethr v{version}</p>
              ) : null}
            </div>
          </div>

          <div className="p-1.5">
            <MenuAction
              label="View profile"
              icon={UserRound}
              href={profileHref}
              onClick={closeNavigationChrome}
            />
            <MenuAction
              label="Edit profile"
              icon={UserRoundPen}
              href={PROFILE_SETTINGS_PATH}
              onClick={closeNavigationChrome}
            />
            <MenuAction
              label="Instance settings"
              icon={Settings}
              href={instanceSettingsTarget}
              onClick={closeNavigationChrome}
            />
            <MenuAction
              label="Documentation"
              icon={BookOpen}
              href={DOCS_URL}
              external
              onClick={() => setOpen(false)}
            />
            <MenuAction
              label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              icon={theme === "dark" ? Sun : Moon}
              onClick={() => {
                toggleTheme();
                setOpen(false);
              }}
            />
            {deploymentMode === "authenticated" ? (
              <button
                type="button"
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm font-medium text-foreground transition-colors hover:bg-destructive/10 hover:text-destructive",
                  signOutMutation.isPending && "cursor-not-allowed opacity-60",
                )}
                onClick={() => signOutMutation.mutate()}
                disabled={signOutMutation.isPending}
              >
                <LogOut className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">
                  {signOutMutation.isPending ? "Signing out…" : "Sign out"}
                </span>
              </button>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
