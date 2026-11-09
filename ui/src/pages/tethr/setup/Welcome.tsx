import type { CSSProperties } from "react";
import { ArrowRight } from "lucide-react";
import { Nebula } from "@/components/tethr/Nebula";
import { MonoTag } from "@/components/tethr/primitives";
import { Link } from "../../../lib/router";
import { SETUP_MINUTES, STEP_GUIDE } from "./guide";
import { STEPS } from "./shared";

// The first thing a new workspace sees: what tethr is, how setup goes, and what
// to have ready. Entrance is choreographed in CSS (.tethr-welcome*): the
// nebula settles, the headline rises word by word, then the rest follows.

const HEADLINE = ["Hello.", "Let's", "set", "up", "tethr."];

const HAVE_READY = [
  "Your Slack member ID (Slack: your profile, then ⋯, then Copy member ID).",
  "Stripe, PostHog and Gmail connected in your Claude account: claude.ai, Settings, Connectors.",
  "A rough sense of your numbers. tethr pulls the real ones; you decide the targets.",
  `About ${SETUP_MINUTES} minutes. You can stop and pick up where you left off.`,
];

const ALWAYS = [
  "It reads your tools freely and asks before anything changes, sends or spends.",
  "Money, anything public and anything medical always ask, whatever the setting.",
  "It never handles anyone's health information.",
];

export function SetupWelcome({ onBegin }: { onBegin: () => void }) {
  return (
    <section className="tethr-welcome" aria-labelledby="tethr-welcome-title">
      <div className="tethr-welcome-hero">
        <div className="tethr-welcome-mark" aria-hidden="true">
          <Nebula />
        </div>
        <p className="tethr-eyebrow tethr-welcome-rise" style={{ "--d": "140ms" } as CSSProperties}>
          first run · about {SETUP_MINUTES} minutes
        </p>
        <h1 id="tethr-welcome-title" className="tethr-welcome-title">
          {HEADLINE.map((word, i) => (
            <span key={word} className="tethr-welcome-word" style={{ "--i": i } as CSSProperties}>
              {word}
              {i < HEADLINE.length - 1 ? " " : ""}
            </span>
          ))}
        </h1>
        <p className="tethr-welcome-lede tethr-welcome-rise" style={{ "--d": "620ms" } as CSSProperties}>
          tethr is your team's operator for growth. It works through your own tools, asks before anything leaves the company, and keeps everyone
          pointed at real numbers.
        </p>
        <div className="tethr-welcome-actions tethr-welcome-rise" style={{ "--d": "760ms" } as CSSProperties}>
          <button type="button" onClick={onBegin} className="tethr-btn tethr-btn-primary h-11 px-6 text-[14px]">
            Begin setup
            <ArrowRight className="h-4 w-4" />
          </button>
          <Link to="/chat" className="tethr-btn tethr-btn-ghost h-11 px-5 text-[13.5px]">
            Look around first
          </Link>
        </div>
      </div>

      <div className="tethr-welcome-grid">
        <div className="tethr-welcome-rise" style={{ "--d": "880ms" } as CSSProperties}>
          <MonoTag>how it goes</MonoTag>
          <ol className="mt-4 divide-y divide-[var(--tethr-rim)]">
            {STEPS.map((step, i) => (
              <li key={step.key} className="grid grid-cols-[2.25rem_minmax(0,1fr)_auto] items-baseline gap-3 py-3.5">
                <span className="font-mono text-[11px] tethr-text-3">{String(i + 1).padStart(2, "0")}</span>
                <span className="min-w-0">
                  <span className="block text-[15px] font-medium tracking-[-0.01em]">{step.title}</span>
                  <span className="mt-0.5 block text-[13px] text-muted-foreground">{STEP_GUIDE[step.key].lede}</span>
                </span>
                <span className="font-mono text-[11px] tethr-text-3">{STEP_GUIDE[step.key].minutes} min</span>
              </li>
            ))}
          </ol>
        </div>
        <aside className="space-y-8 tethr-welcome-rise" style={{ "--d": "980ms" } as CSSProperties}>
          <div>
            <MonoTag>have these ready</MonoTag>
            <ul className="mt-4 space-y-3">
              {HAVE_READY.map((item) => (
                <li key={item} className="flex gap-3 text-[13.5px] leading-relaxed text-muted-foreground">
                  <span aria-hidden="true" className="mt-[0.6em] h-px w-3 shrink-0 bg-[var(--tethr-rim-strong)]" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="tethr-inset px-4 py-3.5">
            <MonoTag>always true</MonoTag>
            <ul className="mt-2.5 space-y-1.5">
              {ALWAYS.map((item) => (
                <li key={item} className="text-[13px] leading-relaxed">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </section>
  );
}
