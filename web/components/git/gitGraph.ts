// Pure topology helpers for rendering `get_log` output as a Git history graph.
//
// The backend already returns `refs` (git `%D` decoration) and `parents` (`%P`)
// for every commit, so this module derives rendering semantics only: ref
// classification (local branch / remote branch / tag / HEAD), lane assignment
// for continuous tracks, and the per-row line segments needed to draw a
// git-graph style topology (pass-through lines, merge bends, convergence).
//
// No React, no DOM, no I/O — everything here is unit-testable in isolation.
import type { GitCommit } from "@/services/gitService";

export type GitRefKind = "head" | "localBranch" | "remoteBranch" | "tag";

export interface GitRef {
  /** Original decoration token, e.g. `HEAD -> main` or `tag: v1.0`. */
  raw: string;
  /** Display name with symbolic/`tag:` prefixes stripped, e.g. `main`, `v1.0`. */
  name: string;
  kind: GitRefKind;
  /** True when this ref is the checked-out HEAD (or the current branch tip). */
  isHead: boolean;
}

export type GitNodeKind = "root" | "normal" | "merge";

/**
 * A commit row plus everything the renderer needs to draw its graph gutter:
 * which lanes carry a line, where the dot sits, and how merge/converge bends
 * connect to neighbouring rows. Lane indices are zero-based columns.
 */
export interface GitGraphNode {
  commit: GitCommit;
  /** Zero-based row index, matching the commit order from `get_log`. */
  row: number;
  /** Zero-based lane (column) this commit's dot is drawn in. */
  lane: number;
  kind: GitNodeKind;
  refs: GitRef[];
  isHead: boolean;
  /** Marks commits flagged as conflict-related (e.g. an in-progress merge tip). */
  conflict: boolean;
  /** Lanes with a line passing the full row height (other commits' tracks). */
  passThroughLanes: number[];
  /** Lanes whose line enters from the top and curves into this commit's dot. */
  enterLanes: number[];
  /** Lanes this commit's dot bends down into (non-first / merge parents). */
  exitLanes: number[];
  /** True when this commit's own lane has a line arriving from the row above. */
  hasIncoming: boolean;
  /** True when this commit's own lane continues to a parent in the row below. */
  hasOutgoing: boolean;
}

export interface GitGraph {
  nodes: GitGraphNode[];
  /** Number of lane columns needed to draw the whole graph. */
  laneCount: number;
}

export interface BuildGitGraphOptions {
  /**
   * Remote names used to classify `<remote>/<branch>` decorations as remote
   * refs. When omitted, `origin`/`upstream` are assumed and any `<x>/HEAD`
   * decoration auto-registers `<x>` as a remote.
   */
  remotes?: readonly string[];
  /** Commit hashes to flag as conflict-related (e.g. an in-progress merge tip). */
  conflictHashes?: ReadonlySet<string>;
}

const DEFAULT_REMOTES = ["origin", "upstream"];

function remoteSegment(name: string): string | null {
  const slash = name.indexOf("/");
  return slash > 0 ? name.slice(0, slash) : null;
}

/** Collect remote names from explicit options plus any `<remote>/HEAD` decoration. */
function resolveRemotes(commits: readonly GitCommit[], remotes?: readonly string[]): Set<string> {
  const set = new Set(remotes ?? DEFAULT_REMOTES);
  for (const commit of commits) {
    for (const token of commit.refs.split(",")) {
      const left = token.split("->")[0]?.trim();
      if (left && left !== "HEAD" && left.endsWith("/HEAD")) {
        const segment = remoteSegment(left);
        if (segment) set.add(segment);
      }
    }
  }
  return set;
}

function classifyRef(token: string, remotes: ReadonlySet<string>): GitRef | null {
  const raw = token.trim();
  if (!raw) return null;

  if (raw.startsWith("tag:")) {
    const name = raw.slice(4).trim();
    return name ? { raw, name, kind: "tag", isHead: false } : null;
  }

  const arrow = raw.indexOf("->");
  const left = arrow >= 0 ? raw.slice(0, arrow).trim() : null;
  const right = (arrow >= 0 ? raw.slice(arrow + 2) : raw).trim();
  if (!right) return null;

  if (!left && right === "HEAD") {
    return { raw, name: "HEAD", kind: "head", isHead: true };
  }

  const isHead = left === "HEAD";
  const segment = remoteSegment(right);
  const kind: GitRefKind = segment && remotes.has(segment) ? "remoteBranch" : "localBranch";
  return { raw, name: right, kind, isHead };
}

/** Parse a git `%D` decoration string into classified refs. */
export function parseGitRefs(refs: string, remotes?: ReadonlySet<string>): GitRef[] {
  const remoteSet = remotes ?? new Set(DEFAULT_REMOTES);
  const out: GitRef[] = [];
  for (const token of refs.split(",")) {
    const ref = classifyRef(token, remoteSet);
    if (ref) out.push(ref);
  }
  return out;
}

function nodeKind(parents: readonly string[]): GitNodeKind {
  if (parents.length > 1) return "merge";
  if (parents.length === 0) return "root";
  return "normal";
}

/**
 * Assign lanes and derive per-row render segments for commits in `get_log` order.
 *
 * Lane assignment walks rows top to bottom, keeping a `lanes` array where each
 * slot holds the hash that column expects to draw next (or `null` when free).
 * A commit takes the first lane already expecting it; extra lanes expecting the
 * same hash converge into it. The first parent continues in the commit's lane,
 * additional (merge) parents reserve their own lanes, producing convergence
 * points that the renderer draws as bends.
 */
export function buildGitGraph(
  commits: readonly GitCommit[],
  options: BuildGitGraphOptions = {},
): GitGraph {
  const remotes = resolveRemotes(commits, options.remotes);
  const conflictHashes = options.conflictHashes;

  const nodes: GitGraphNode[] = [];
  const lanes: (string | null)[] = [];

  const acquireLane = (): number => {
    const free = lanes.indexOf(null);
    if (free >= 0) return free;
    lanes.push(null);
    return lanes.length - 1;
  };

  for (let row = 0; row < commits.length; row += 1) {
    const commit = commits[row];
    const parents = commit.parents;
    const refs = parseGitRefs(commit.refs, remotes);
    const isHead = refs.some((ref) => ref.isHead);

    // Snapshot of lanes expected to draw at this row before placing the commit.
    const incoming = lanes.map((hash, index) => ({ hash, index }));

    // 1. Place this commit. Prefer the first lane already expecting it.
    let lane = lanes.indexOf(commit.hash);
    const hasIncoming = lane !== -1;
    const enterLanes: number[] = [];
    if (lane === -1) {
      lane = acquireLane();
    } else {
      // Any additional lane expecting this same hash converges into `lane`.
      for (const { hash, index } of incoming) {
        if (hash === commit.hash && index !== lane) enterLanes.push(index);
      }
    }
    lanes[lane] = commit.hash;
    for (const index of enterLanes) lanes[index] = null;

    // 2. Lanes whose expected commit is drawn elsewhere pass straight through.
    const passThroughLanes: number[] = [];
    for (const { hash, index } of incoming) {
      if (hash !== null && hash !== commit.hash) passThroughLanes.push(index);
    }

    // 3. Reserve lanes for parents on the next row.
    const exitLanes: number[] = [];
    let hasOutgoing = false;
    if (parents.length > 0) {
      lanes[lane] = parents[0];
      hasOutgoing = true;
      for (const parent of parents.slice(1)) {
        let target = lanes.indexOf(parent);
        if (target === -1) {
          target = acquireLane();
          lanes[target] = parent;
        }
        if (target !== lane) exitLanes.push(target);
      }
    } else {
      lanes[lane] = null;
    }

    nodes.push({
      commit,
      row,
      lane,
      kind: nodeKind(parents),
      refs,
      isHead,
      conflict: conflictHashes?.has(commit.hash) ?? false,
      passThroughLanes,
      enterLanes,
      exitLanes,
      hasIncoming,
      hasOutgoing,
    });
  }

  let laneCount = 1;
  for (const node of nodes) {
    laneCount = Math.max(laneCount, node.lane + 1, ...node.exitLanes.map((c) => c + 1));
  }

  return { nodes, laneCount };
}
