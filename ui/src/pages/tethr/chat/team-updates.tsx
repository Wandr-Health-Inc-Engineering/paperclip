import { useState } from "react";
import { ArrowRight, ChevronDown, Users } from "lucide-react";
import { MarkdownBody } from "@/components/MarkdownBody";
import { AgentGlyph, formatRelative } from "@/components/tethr/primitives";
import type { TethrChatRun, TethrTeamAgent } from "@/api/tethr";
import { reportHasMore, reportLead } from "@/lib/tethr-cards";
import { cn } from "@/lib/utils";
import { UrgencyRow } from "./cards";
import { ApprovalCard, QuestionCard } from "./decision-cards";
import { FileChips } from "./file-chip";

// What tethr's agents report, the way an assistant would bring it to you (Mark,
// 2026-11-10: "if my assistant brought me all this I'd say this isn't helpful").
// Each report is its headline and one line; what needs you sits right under it;
// the full report and its files open on tap. Reports that land one after
// another come as one "updates from your team" card.

interface ReportProps {
  companyId: string;
  agentFor: (run: TethrChatRun) => TethrTeamAgent | undefined;
  onOpenFile: (path: string) => void;
  onOpenChat: (threadId: string) => void;
}

/** "@writer finished WD-8: Drafts" under the writer's own name reads "Finished WD-8: Drafts". */
export function withoutTag(headline: string, tag: string | undefined): string {
  if (!tag || !headline.startsWith(`${tag} `)) return headline;
  const rest = headline.slice(tag.length + 1);
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

const filesOf = (run: TethrChatRun) => [...new Set(run.hops.filter((h) => h.layer === "tool" && h.file && h.status === "ok").map((h) => h.file as string))];

/** One report: who, the headline, its first line, what needs you; the rest on tap. */
function ReportItem({ run, companyId, agent, onOpenFile, onOpenChat }: Omit<ReportProps, "agentFor"> & { run: TethrChatRun; agent?: TethrTeamAgent }) {
  const [open, setOpen] = useState(false);
  const files = filesOf(run);
  const lead = reportLead(run.resultText);
  const more = reportHasMore(run.resultText) || files.length > 0;
  const needs = run.needsYou;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[11.5px] tethr-text-3">
        {agent ? <AgentGlyph icon={agent.icon} className="h-3.5 w-3.5 shrink-0" /> : <Users className="h-3.5 w-3.5 shrink-0" />}
        <span className="min-w-0 truncate">{agent?.name ?? "An agent"}</span>
        <span className="ml-auto shrink-0 font-mono text-[10.5px]">{formatRelative(run.createdAt)}</span>
      </div>
      <p className="text-[14px] font-medium leading-snug [overflow-wrap:anywhere]">{withoutTag(run.requestText, agent?.tag)}</p>
      {lead && !open ? <p className="line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">{lead}</p> : null}
      {open ? (
        <div className="space-y-2.5">
          {run.resultText ? <MarkdownBody linkIssueReferences={false} className="tethr-chat-md">{run.resultText}</MarkdownBody> : null}
          <FileChips files={files} onOpen={onOpenFile} />
          {run.urgency ? <UrgencyRow run={run} companyId={companyId} /> : null}
        </div>
      ) : null}
      {needs ? (
        <div className="space-y-2.5 pt-1">
          {needs.questions.map((q) => (
            <QuestionCard key={q.id} question={q} companyId={companyId} />
          ))}
          {needs.approvals.map((o) => (
            <ApprovalCard key={o.id} output={o} companyId={companyId} threadId={typeof o.meta?.threadId === "string" ? o.meta.threadId : ""} />
          ))}
        </div>
      ) : null}
      {more || agent ? (
        <div className="-ml-2 flex flex-wrap items-center gap-x-1 gap-y-1.5">
          {more ? (
            <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="tethr-btn tethr-btn-ghost h-8 px-2.5 text-[12.5px]">
              {open ? "Show less" : files.length ? `Read the report · ${files.length} ${files.length === 1 ? "file" : "files"}` : "Read the report"}
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
            </button>
          ) : null}
          {agent ? (
            <button type="button" onClick={() => onOpenChat(agent.threadId)} title={`Open ${agent.tag}'s chat`} className="tethr-btn tethr-btn-ghost h-8 px-2.5 text-[12.5px]">
              Open chat
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Reports that landed together: one card, newest last, each item calm until tapped. */
export function TeamUpdates({ runs, ...props }: ReportProps & { runs: TethrChatRun[] }) {
  if (runs.length === 1) {
    const run = runs[0]!;
    return (
      <div className="tethr-glass rounded-[16px] px-4 py-3.5">
        <ReportItem run={run} agent={props.agentFor(run)} companyId={props.companyId} onOpenFile={props.onOpenFile} onOpenChat={props.onOpenChat} />
      </div>
    );
  }
  return (
    <div className="tethr-glass rounded-[16px] px-4 py-3.5">
      <p className="tethr-eyebrow pb-1">updates from your team · {runs.length}</p>
      <div className="divide-y divide-[var(--tethr-rim)]">
        {runs.map((run) => (
          <div key={run.id} className="py-3 first:pt-2 last:pb-0.5">
            <ReportItem run={run} agent={props.agentFor(run)} companyId={props.companyId} onOpenFile={props.onOpenFile} onOpenChat={props.onOpenChat} />
          </div>
        ))}
      </div>
    </div>
  );
}
