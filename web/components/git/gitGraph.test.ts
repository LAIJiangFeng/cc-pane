import { describe, expect, it } from "vitest";

import type { GitCommit } from "@/services/gitService";
import {
  buildGitGraph,
  parseGitRefs,
  type GitGraphNode,
} from "./gitGraph";

function commit(
  hash: string,
  parents: string[] = [],
  refs = "",
  overrides: Partial<GitCommit> = {},
): GitCommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    author: "A",
    authorEmail: "a@example.com",
    date: "2024-01-01T00:00:00+00:00",
    subject: hash,
    refs,
    parents,
    ...overrides,
  };
}

function nodeByHash(nodes: GitGraphNode[], hash: string): GitGraphNode {
  const found = nodes.find((node) => node.commit.hash === hash);
  if (!found) throw new Error(`missing node ${hash}`);
  return found;
}

describe("parseGitRefs", () => {
  it("classifies HEAD -> branch as a head ref", () => {
    const refs = parseGitRefs("HEAD -> main");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ name: "main", kind: "localBranch", isHead: true });
  });

  it("classifies a bare HEAD decoration", () => {
    const refs = parseGitRefs("HEAD");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ name: "HEAD", kind: "head", isHead: true });
  });

  it("classifies tags by stripping the tag: prefix", () => {
    const refs = parseGitRefs("tag: v1.0.0");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ name: "v1.0.0", kind: "tag", isHead: false });
  });

  it("classifies remote branches via explicit remote set", () => {
    const refs = parseGitRefs("origin/feature, origin/HEAD -> origin/main", new Set(["origin"]));
    expect(refs.map((ref) => ref.kind)).toEqual(["remoteBranch", "remoteBranch"]);
    expect(refs[0].name).toBe("origin/feature");
    expect(refs[1].name).toBe("origin/main");
    // `origin/HEAD` is the remote's default-branch pointer, not the local
    // checkout, so it must not be flagged as HEAD.
    expect(refs[1].isHead).toBe(false);
  });

  it("flags only the local checkout as HEAD when a remote branch is also decorated", () => {
    const refs = parseGitRefs("HEAD -> main, origin/main");
    expect(refs.map((ref) => ref.isHead)).toEqual([true, false]);
  });

  it("keeps unknown remote-prefixed refs as local branches", () => {
    const refs = parseGitRefs("topic/foo");
    expect(refs[0]).toMatchObject({ name: "topic/foo", kind: "localBranch" });
  });

  it("parses multiple comma-separated decorations", () => {
    const refs = parseGitRefs("HEAD -> main, origin/main, tag: v2");
    expect(refs).toHaveLength(3);
    expect(refs.map((ref) => ref.kind)).toEqual(["localBranch", "remoteBranch", "tag"]);
    expect(refs.filter((ref) => ref.isHead)).toHaveLength(1);
  });

  it("ignores empty tokens", () => {
    expect(parseGitRefs("")).toEqual([]);
    expect(parseGitRefs(" , ")).toEqual([]);
  });
});

describe("buildGitGraph", () => {
  it("renders a linear history on a single continuous lane", () => {
    const commits = [commit("c3", ["c2"]), commit("c2", ["c1"]), commit("c1", [])];
    const graph = buildGitGraph(commits);

    expect(graph.laneCount).toBe(1);
    expect(graph.nodes.map((node) => node.lane)).toEqual([0, 0, 0]);
    expect(graph.nodes.map((node) => node.kind)).toEqual(["normal", "normal", "root"]);

    const middle = nodeByHash(graph.nodes, "c2");
    expect(middle.hasIncoming).toBe(true);
    expect(middle.hasOutgoing).toBe(true);
    expect(middle.passThroughLanes).toEqual([]);

    const root = nodeByHash(graph.nodes, "c1");
    expect(root.hasOutgoing).toBe(false);
    const tip = nodeByHash(graph.nodes, "c3");
    expect(tip.hasIncoming).toBe(false);
  });

  it("marks merge commits and records the bend to the second parent lane", () => {
    const commits = [
      commit("m", ["a", "b"]),
      commit("a", ["base"]),
      commit("b", ["base"]),
      commit("base", []),
    ];
    const graph = buildGitGraph(commits);
    const merge = nodeByHash(graph.nodes, "m");
    expect(merge.kind).toBe("merge");
    expect(merge.commit.parents).toHaveLength(2);
    // The second parent is placed on a different lane and the merge bends into it.
    expect(merge.exitLanes.length).toBe(1);
    expect(merge.exitLanes[0]).not.toBe(merge.lane);
  });

  it("keeps branch tracks on distinct lanes across a fork", () => {
    const commits = [
      commit("r0", ["r1", "r2"]),
      commit("r1", ["r3"]),
      commit("r2", ["r3"]),
      commit("r3", []),
    ];
    const graph = buildGitGraph(commits);

    const left = nodeByHash(graph.nodes, "r1").lane;
    const right = nodeByHash(graph.nodes, "r2").lane;
    expect(left).not.toBe(right);
    expect(graph.laneCount).toBeGreaterThanOrEqual(2);
    expect(nodeByHash(graph.nodes, "r3").lane).toBe(left);
  });

  it("records a pass-through lane when another track continues past a commit", () => {
    // m merges r2 (right track) into r1 (left track). On the row of r2, the left
    // track still expects r1, so r2's row should carry a pass-through lane.
    const commits = [
      commit("m", ["r1", "r2"]),
      commit("r2", ["base"]),
      commit("r1", ["base"]),
      commit("base", []),
    ];
    const graph = buildGitGraph(commits);
    const r2 = nodeByHash(graph.nodes, "r2");
    expect(r2.passThroughLanes.length).toBeGreaterThanOrEqual(1);
    expect(r2.passThroughLanes).not.toContain(r2.lane);
  });

  it("marks convergence lanes that curve into a commit's dot", () => {
    const commits = [
      commit("m", ["a", "b"]),
      commit("a", ["base"]),
      commit("b", ["base"]),
      commit("base", []),
    ];
    const graph = buildGitGraph(commits);
    const base = nodeByHash(graph.nodes, "base");
    // Both tracks expect `base`, so one of them converges into base's lane.
    expect(base.enterLanes.length).toBe(1);
    expect(base.enterLanes[0]).not.toBe(base.lane);
  });

  it("flags the HEAD commit and conflict hashes", () => {
    const commits = [
      commit("head", ["prev"], "HEAD -> main"),
      commit("prev", ["x"], ""),
      commit("x", []),
    ];
    const graph = buildGitGraph(commits, { conflictHashes: new Set(["prev"]) });
    expect(nodeByHash(graph.nodes, "head").isHead).toBe(true);
    expect(nodeByHash(graph.nodes, "head").conflict).toBe(false);
    expect(nodeByHash(graph.nodes, "prev").conflict).toBe(true);
  });

  it("classifies local vs remote refs on the same commit", () => {
    const commits = [commit("tip", [], "HEAD -> main, origin/main, tag: v1")];
    const graph = buildGitGraph(commits);
    const node = nodeByHash(graph.nodes, "tip");
    expect(node.refs.map((ref) => ref.kind)).toEqual(["localBranch", "remoteBranch", "tag"]);
  });

  it("handles an empty commit list without throwing", () => {
    const graph = buildGitGraph([]);
    expect(graph.nodes).toEqual([]);
    expect(graph.laneCount).toBe(1);
  });

  it("reuses a free lane for an unrelated second branch instead of growing forever", () => {
    const commits = [
      commit("a1", []),
      commit("b1", []),
      commit("a2", ["a1"]),
      commit("b2", ["b1"]),
    ];
    const graph = buildGitGraph(commits);
    expect(graph.laneCount).toBeLessThanOrEqual(2);
  });

  it("auto-detects a remote from a <remote>/HEAD decoration", () => {
    const commits = [commit("tip", [], "upstream/HEAD -> upstream/main")];
    const graph = buildGitGraph(commits);
    const node = nodeByHash(graph.nodes, "tip");
    const remote = node.refs.find((ref) => ref.name === "upstream/main");
    expect(remote?.kind).toBe("remoteBranch");
  });
});
