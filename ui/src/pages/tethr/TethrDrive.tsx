import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  File,
  FileText,
  Folder,
  HardDrive,
  History,
  Lock,
  Tag,
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { MarkdownBody } from "@/components/MarkdownBody";
import { MonoTag, formatRelative } from "@/components/tethr/primitives";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { cn } from "@/lib/utils";
import { tethrApi, tethrKeys, type TethrDriveNode } from "@/api/tethr";

// The Drive: Tethr's source of truth, replacing Google Drive. Folders,
// versioned files, tags, and permissions metadata — bytes live behind the
// StorageProvider (local disk here, S3/GCS in the cloud).

interface Crumb {
  id: string | null;
  name: string;
}

export function TethrDrive() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ id: null, name: "drive" }]);
  const [selectedFile, setSelectedFile] = useState<TethrDriveNode | null>(null);
  const currentFolder = crumbs[crumbs.length - 1];

  useEffect(() => {
    setBreadcrumbs([{ label: "Drive" }]);
  }, [setBreadcrumbs]);

  const { data: children, isLoading } = useQuery({
    queryKey: tethrKeys.drive(selectedCompanyId!, currentFolder.id),
    queryFn: () => tethrApi.drive(selectedCompanyId!, currentFolder.id),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={HardDrive} message="Select a company to browse the drive." />;
  }

  const open = (node: TethrDriveNode) => {
    if (node.kind === "folder") {
      setCrumbs((prev) => [...prev, { id: node.id, name: node.name }]);
      setSelectedFile(null);
    } else {
      setSelectedFile(node);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <MonoTag className="text-foreground">● tethr · drive</MonoTag>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight">the drive</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Source of truth. Every file is versioned; gated work lands here only after
          approval.
        </p>
      </div>

      {/* Path bar */}
      <div className="flex flex-wrap items-center gap-1 border-2 border-foreground bg-card px-3 py-2">
        {crumbs.map((crumb, index) => (
          <span key={`${crumb.id ?? "root"}-${index}`} className="flex items-center gap-1">
            {index > 0 ? (
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            ) : null}
            <button
              onClick={() => {
                setCrumbs((prev) => prev.slice(0, index + 1));
                setSelectedFile(null);
              }}
              className={cn(
                "px-1 font-mono text-[11px] font-bold uppercase tracking-[0.12em]",
                index === crumbs.length - 1
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {crumb.name}
            </button>
          </span>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        {/* Listing */}
        <div className={cn(selectedFile && "hidden lg:block")}>
          {isLoading ? (
            <PageSkeleton variant="list" />
          ) : children?.length ? (
            <div className="space-y-1.5" data-tethr-stagger>
              {children.map((node) => (
                <button
                  key={node.id}
                  onClick={() => open(node)}
                  className={cn(
                    "flex w-full items-center gap-3 border bg-card px-3 py-2.5 text-left transition-colors",
                    selectedFile?.id === node.id
                      ? "border-foreground"
                      : "border-border hover:border-foreground/60",
                  )}
                >
                  {node.kind === "folder" ? (
                    <Folder className="h-4 w-4 shrink-0" />
                  ) : (
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                    {node.name}
                  </span>
                  {node.tags.length > 0 ? (
                    <span className="hidden gap-1 sm:flex">
                      {node.tags.slice(0, 2).map((tag) => (
                        <span
                          key={tag}
                          className="border border-border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.1em] text-muted-foreground"
                        >
                          {tag}
                        </span>
                      ))}
                    </span>
                  ) : null}
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {node.kind === "file" && node.byteSize != null
                      ? formatBytes(node.byteSize)
                      : ""}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="border border-dashed border-foreground/30 px-4 py-10 text-center">
              <p className="text-sm text-muted-foreground">Empty folder.</p>
            </div>
          )}
        </div>

        {/* File panel */}
        <div className={cn(!selectedFile && "hidden lg:block")}>
          {selectedFile ? (
            <FilePanel
              companyId={selectedCompanyId}
              node={selectedFile}
              onClose={() => setSelectedFile(null)}
            />
          ) : (
            <div className="flex h-full min-h-64 items-center justify-center border border-dashed border-foreground/30">
              <p className="px-6 text-center text-sm text-muted-foreground">
                Select a file to preview it, browse versions, and check permissions.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FilePanel({
  companyId,
  node,
  onClose,
}: {
  companyId: string;
  node: TethrDriveNode;
  onClose: () => void;
}) {
  const [versionId, setVersionId] = useState<string | undefined>(undefined);

  const { data: detail } = useQuery({
    queryKey: tethrKeys.driveNode(companyId, node.id),
    queryFn: () => tethrApi.driveNode(companyId, node.id),
  });
  const { data: content, isLoading: contentLoading } = useQuery({
    queryKey: tethrKeys.driveContent(companyId, node.id, versionId),
    queryFn: () => tethrApi.driveContent(companyId, node.id, versionId),
  });

  const versions = detail?.versions ?? [];
  const isMarkdown =
    (content?.contentType ?? node.contentType ?? "").includes("markdown") ||
    node.name.endsWith(".md");

  return (
    <div className="border-2 border-foreground bg-card">
      <header className="border-b-2 border-foreground px-4 py-3">
        <button
          onClick={onClose}
          className="mb-1 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground hover:text-foreground lg:hidden"
        >
          ← back to files
        </button>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <File className="h-4 w-4 shrink-0" />
            <h2 className="truncate text-base font-extrabold tracking-tight">
              {node.name}
            </h2>
          </div>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
            {node.path}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {node.tags.map((tag) => (
            <span
              key={tag}
              className="flex items-center gap-1 border border-border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.1em] text-muted-foreground"
            >
              <Tag className="h-2.5 w-2.5" />
              {tag}
            </span>
          ))}
          <span className="ml-auto flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
            <Lock className="h-3 w-3" />
            owner {node.permissions.owner} · read {node.permissions.read.join(", ")} · write{" "}
            {node.permissions.write.join(", ")}
          </span>
        </div>
      </header>

      <div className="max-h-96 overflow-auto px-4 py-4">
        {contentLoading ? (
          <p className="shimmer-text text-sm font-semibold">reading…</p>
        ) : content ? (
          isMarkdown ? (
            <MarkdownBody className="text-sm leading-relaxed">
              {content.content}
            </MarkdownBody>
          ) : (
            <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">
              {content.content}
            </pre>
          )
        ) : (
          <p className="text-sm text-muted-foreground">No content.</p>
        )}
      </div>

      <div className="border-t-2 border-foreground px-4 py-3">
        <div className="flex items-center gap-1.5">
          <History className="h-3.5 w-3.5 text-muted-foreground" />
          <MonoTag>versions</MonoTag>
        </div>
        <div className="mt-2 space-y-1">
          {versions.map((version) => (
            <button
              key={version.id}
              onClick={() => setVersionId(version.id)}
              className={cn(
                "flex w-full items-center justify-between gap-3 border px-2.5 py-1.5 text-left transition-colors",
                (versionId ?? node.currentVersionId) === version.id
                  ? "border-foreground"
                  : "border-border hover:border-foreground/60",
              )}
            >
              <span className="font-mono text-[11px] font-bold">
                v{version.versionNumber}
                {node.currentVersionId === version.id ? (
                  <span className="ml-1.5 text-muted-foreground">· current</span>
                ) : null}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {version.note ?? ""}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {version.createdByTag} · {formatRelative(version.createdAt)}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
