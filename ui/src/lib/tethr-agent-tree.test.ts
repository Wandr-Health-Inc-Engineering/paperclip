import { describe, expect, it } from "vitest";
import { agentTree, descendantCount, nodeHolds } from "./tethr-agent-tree";

const a = (id: string, reportsTo: string | null = null) => ({ id, reportsTo });
const shape = (nodes: ReturnType<typeof agentTree<{ id: string; reportsTo: string | null }>>): unknown =>
  nodes.map((n) => (n.children.length ? [n.agent.id, shape(n.children)] : n.agent.id));

describe("the sidebar's agent tree", () => {
  it("nests a sub-team under its lead, and leaves the top of the org flat", () => {
    const agents = [a("tethr"), a("paid-ads", "tethr"), a("sage", "tethr"), a("keywords", "paid-ads"), a("reporting", "paid-ads")];
    expect(shape(agentTree(agents))).toEqual(["tethr", ["paid-ads", ["keywords", "reporting"]], "sage"]);
  });

  it("is the flat list it always was when nobody has a sub-team", () => {
    const agents = [a("tethr"), a("scout", "tethr"), a("sage", "tethr")];
    expect(shape(agentTree(agents))).toEqual(["tethr", "scout", "sage"]);
  });

  it("keeps the order it was given, at every level", () => {
    const agents = [a("reporting", "paid-ads"), a("sage", "tethr"), a("paid-ads", "tethr"), a("tethr"), a("keywords", "paid-ads")];
    expect(shape(agentTree(agents))).toEqual(["sage", ["paid-ads", ["reporting", "keywords"]], "tethr"]);
  });

  it("shows an agent whose lead isn't in the list at the top, and survives a reporting loop", () => {
    expect(shape(agentTree([a("orphan", "gone"), a("tethr")]))).toEqual(["orphan", "tethr"]);
    const looped = agentTree([a("tethr"), a("x", "y"), a("y", "x")]);
    expect(looped.map((n) => n.agent.id).sort()).toEqual(["tethr", "x", "y"]);
  });

  it("knows what's under a node", () => {
    const [, lead] = agentTree([a("tethr"), a("paid-ads", "tethr"), a("keywords", "paid-ads"), a("deep", "keywords")]);
    expect(descendantCount(lead!)).toBe(2);
    expect(nodeHolds(lead!, (agent) => agent.id === "deep")).toBe(true);
    expect(nodeHolds(lead!, (agent) => agent.id === "paid-ads")).toBe(false);
  });
});
