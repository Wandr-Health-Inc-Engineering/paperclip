import type { CSSProperties } from "react";
import { ArrowRight } from "lucide-react";
import { Nebula } from "@/components/tethr/Nebula";
import { Link } from "../../../lib/router";
import { FORM_MINUTES } from "./guide";
import { STEPS } from "./shared";

// The first thing a new workspace sees: one calm screen. The mark settles, a
// single word rises, then one line and one button. How setup goes and what to
// have ready are told by the steps themselves (their rail and guides).

export function SetupWelcome({ onBegin }: { onBegin: () => void }) {
  return (
    <section className="tethr-welcome" aria-labelledby="tethr-welcome-title">
      <div className="tethr-welcome-hero">
        <div className="tethr-welcome-mark" aria-hidden="true">
          <Nebula />
        </div>
        <h1 id="tethr-welcome-title" className="tethr-welcome-title">
          <span className="tethr-welcome-word">Hello.</span>
        </h1>
        <p className="tethr-welcome-lede tethr-welcome-rise" style={{ "--d": "420ms" } as CSSProperties}>
          I'm tethr, your team's operator for growth. {STEPS.length - 1} short steps, about {FORM_MINUTES} minutes, then we talk through your
          goals.
        </p>
        <div className="tethr-welcome-actions tethr-welcome-rise" style={{ "--d": "560ms" } as CSSProperties}>
          <button type="button" onClick={onBegin} className="tethr-btn tethr-btn-primary h-11 px-6 text-[14px]">
            Begin setup
            <ArrowRight className="h-4 w-4" />
          </button>
          <Link to="/chat" className="tethr-btn tethr-btn-ghost h-11 px-5 text-[13.5px]">
            Look around first
          </Link>
        </div>
        <p className="tethr-welcome-note tethr-welcome-rise" style={{ "--d": "700ms" } as CSSProperties}>
          It reads your tools freely and asks before anything is sent, changed or spent. It never handles anyone's health information.
        </p>
      </div>
    </section>
  );
}
