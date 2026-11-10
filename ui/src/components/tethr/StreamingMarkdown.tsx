import { memo, useEffect, useRef, useState, type ComponentProps } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MarkdownBody } from "@/components/MarkdownBody";
import { useTheme } from "@/context/ThemeContext";
import { remarkSoftBreaks } from "@/lib/remark-soft-breaks";
import { cn } from "@/lib/utils";
import { closeOpenMarkdown, MIN_CHARS_PER_SECOND, rehypeStreamWords, revealEnd, smoothRate, targetRate } from "@/lib/tethr-stream";

// A chat answer that writes itself out: while a turn streams, the text is
// revealed word by word at a steady pace (it trails the stream by a fraction of
// a second, so the bursts from polling disappear) and each new word fades in.
// Once the turn is done and the reveal has caught up, it hands over to the
// regular MarkdownBody (links, code copy buttons). A turn that's already
// finished when it first renders shows whole: only text you watch arriving
// types out.

/** At most this often (ms) the revealed text re-renders (~30 fps is plenty for words). */
const RENDER_EVERY_MS = 32;

export function StreamingMarkdown({ text, live, className }: { text: string; live: boolean; className?: string }) {
  const end = useSmoothReveal(text, live);
  if (!live && end >= text.length) return <MarkdownBody linkIssueReferences={false} className={className}>{text}</MarkdownBody>;
  return <StreamFrame text={text.slice(0, end)} className={className} />;
}

/** How much of `text` to show right now (an index at a word end). */
function useSmoothReveal(text: string, live: boolean): number {
  const animates = useRef(live);
  const [end, setEnd] = useState(() => (live ? revealEnd(text, text.length, true) : text.length));
  const state = useRef({ text, live, cursor: end, rate: MIN_CHARS_PER_SECOND, shown: text.slice(0, end) });

  // New text: carry on from where the reveal is, unless the answer was
  // replaced rather than extended (then show the new one whole).
  const s = state.current;
  if (text !== s.text) {
    if (!text.startsWith(s.shown)) s.cursor = text.length;
    s.text = text;
  }
  s.live = live;

  useEffect(() => {
    if (!animates.current) return;
    let frame = 0;
    let last = performance.now();
    let lastRender = 0;
    const step = (now: number) => {
      const st = state.current;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const backlog = Math.max(0, st.text.length - st.cursor);
      st.rate = smoothRate(st.rate, targetRate(backlog, st.live), dt);
      st.cursor = Math.min(st.text.length, st.cursor + st.rate * dt);
      const next = revealEnd(st.text, st.cursor, st.live);
      const finished = !st.live && next >= st.text.length;
      if (finished || now - lastRender >= RENDER_EVERY_MS) {
        lastRender = now;
        st.shown = st.text.slice(0, next);
        setEnd(next);
      }
      if (!finished) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, []);

  return animates.current ? end : text.length;
}

const REMARK_PLUGINS = [remarkGfm, remarkSoftBreaks];
const REHYPE_PLUGINS = [rehypeStreamWords];

// Defined once, so React keeps every element between renders (a new component
// function per render would remount the whole answer and replay the fades).
const STREAM_COMPONENTS: Components = {
  a: ({ node: _node, ...props }: ComponentProps<"a"> & { node?: unknown }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  table: ({ node: _node, ...props }: ComponentProps<"table"> & { node?: unknown }) => (
    <div className="paperclip-markdown-table-scroll">
      <table {...props} />
    </div>
  ),
};

const StreamFrame = memo(function StreamFrame({ text, className }: { text: string; className?: string }) {
  const { theme } = useTheme();
  return (
    <div
      className={cn(
        "paperclip-markdown tethr-stream prose prose-sm min-w-0 max-w-full break-words overflow-hidden",
        theme === "dark" && "prose-invert",
        className,
      )}
      style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}
    >
      <Markdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={STREAM_COMPONENTS}>
        {closeOpenMarkdown(text.trimEnd())}
      </Markdown>
    </div>
  );
});
