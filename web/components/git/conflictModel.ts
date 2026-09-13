// Pure conflict-resolution view helpers (F3.2).
//
// Keeps the dialog dumb: stage availability, degradation reasons and the
// initial editable result are all derived here so they are unit-testable
// without a Git repo or DOM.
import type {
  GitConflictContent,
  GitConflictFile,
  GitConflictStage,
  GitConflictVersions,
} from "@/services/gitService";

export type SideKind = "base" | "ours" | "theirs" | "result";

/** Why a side cannot be shown as text; `null` means it is available. */
export type SideUnavailableReason = "missing" | "binary" | "tooLarge";

export interface SideView {
  side: SideKind;
  content: string | null;
  size: number;
  unavailableReason: SideUnavailableReason | null;
}

export function sideView(side: SideKind, value: GitConflictContent): SideView {
  const reason: SideUnavailableReason | null =
    value.content !== null ? null : value.isBinary ? "binary" : value.tooLarge ? "tooLarge" : "missing";
  return { side, content: value.content, size: value.size, unavailableReason: reason };
}

export interface ConflictVersionViews {
  base: SideView;
  ours: SideView;
  theirs: SideView;
  result: SideView;
  /** True when all three resolution panes hold editable text. */
  resolvable: boolean;
}

export function toVersionViews(versions: GitConflictVersions): ConflictVersionViews {
  const base = sideView("base", versions.base);
  const ours = sideView("ours", versions.ours);
  const theirs = sideView("theirs", versions.theirs);
  const result = sideView("result", versions.result);
  const resolvable = [ours, theirs, result].every((side) => side.unavailableReason === null);
  return { base, ours, theirs, result, resolvable };
}

/**
 * Pick the best starting point for the editable result pane.
 *
 * The worktree file normally already contains conflict markers; if it is
 * unreadable (binary/too large/missing) fall back to ours, then theirs, then "".
 */
export function initialResultText(versions: GitConflictVersions): string {
  if (versions.result.content !== null) return versions.result.content;
  if (versions.ours.content !== null) return versions.ours.content;
  if (versions.theirs.content !== null) return versions.theirs.content;
  return "";
}

/** Accept one side wholesale into the result pane; returns null when impossible. */
export function acceptSide(views: ConflictVersionViews, side: "ours" | "theirs"): string | null {
  return views[side].content;
}

export function stageOf(file: GitConflictFile, kind: GitConflictStage["kind"]): GitConflictStage | null {
  return file.stages.find((stage) => stage.kind === kind) ?? null;
}

/** Which sides exist for a conflict file (add/add has no base; delete sides are absent). */
export function presentStages(file: GitConflictFile): GitConflictStage["kind"][] {
  return file.stages.map((stage) => stage.kind);
}

/**
 * Sort conflict files so the ones a user is most likely to resolve first
 * (text, both sides present) come before degraded entries.
 */
export function sortConflictFiles(files: readonly GitConflictFile[]): GitConflictFile[] {
  return [...files].sort((a, b) => {
    if (a.isBinary !== b.isBinary) return a.isBinary ? 1 : -1;
    return a.path.localeCompare(b.path);
  });
}
