// The sidebar's agents as a tree (phase 27; Mark: "the subagents on the sidebar
// should be listed under and collapsible under the main agent"). Pure, so the
// core sidebar only has to render what this returns.

export interface TreeAgent {
  id: string;
  reportsTo?: string | null;
}

export interface AgentNode<T extends TreeAgent> {
  agent: T;
  children: Array<AgentNode<T>>;
}

/**
 * Agents nested under the one they report to, keeping the order they came in.
 * The top of the org (an agent that reports to nobody, like tethr) doesn't
 * swallow everyone: it and its direct reports sit side by side at the top, and
 * only what reports to one of THOSE nests. So a lead shows its sub-team under
 * it, and a company with no sub-teams reads as the flat list it always was.
 */
export function agentTree<T extends TreeAgent>(agents: T[]): Array<AgentNode<T>> {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const isRoot = (a: T) => !a.reportsTo || !byId.has(a.reportsTo);
  const parentOf = (a: T): T | null => {
    const parent = a.reportsTo ? byId.get(a.reportsTo) : undefined;
    return parent && !isRoot(parent) ? parent : null;
  };
  const build = (agent: T, seen: Set<string>): AgentNode<T> => ({
    agent,
    // `seen` guards against a reporting loop (a → b → a) in bad data.
    children: agents.filter((a) => !seen.has(a.id) && parentOf(a)?.id === agent.id).map((a) => build(a, new Set([...seen, a.id]))),
  });
  const top = agents.filter((a) => !parentOf(a));
  // Bad data only: agents that report to each other in a loop have no way in from the top.
  const reached = new Set<string>();
  const walk = (node: AgentNode<T>) => {
    reached.add(node.agent.id);
    node.children.forEach(walk);
  };
  const tree = top.map((a) => build(a, new Set([a.id])));
  tree.forEach(walk);
  return [...tree, ...agents.filter((a) => !reached.has(a.id)).map((agent) => ({ agent, children: [] }))];
}

/** Whether a node or anything under it is the given agent. */
export function nodeHolds<T extends TreeAgent>(node: AgentNode<T>, matches: (agent: T) => boolean): boolean {
  return node.children.some((child) => matches(child.agent) || nodeHolds(child, matches));
}

/** How many agents sit under a node, at any depth. */
export function descendantCount<T extends TreeAgent>(node: AgentNode<T>): number {
  return node.children.reduce((n, child) => n + 1 + descendantCount(child), 0);
}

const CLOSED_KEY = "tethr.sidebar.agents.closed";

/** The leads whose sub-teams are folded away, per company (this browser only). */
export function readClosed(companyId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(`${CLOSED_KEY}.${companyId}`);
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeClosed(companyId: string, closed: Set<string>): void {
  try {
    window.localStorage.setItem(`${CLOSED_KEY}.${companyId}`, JSON.stringify([...closed]));
  } catch {
    // Private mode: it just won't be remembered.
  }
}
