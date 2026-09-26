import type {
  GraphNodeJson,
  InclusionReasonJson,
  SourceState,
} from "../api/types.ts";

export const shortOid = (oid: string): string => oid.slice(0, 7);

const REASON_TEXT: Record<InclusionReasonJson, string> = {
  head: "branch head",
  ancestor: "common ancestor of branch heads",
  recent: "recent commit",
  worktree: "checked out in a worktree",
  inspection: "shown for inspection",
};

export function reasonText(reasons: readonly InclusionReasonJson[]): string {
  return reasons.map((r) => REASON_TEXT[r]).join(", ");
}

/** A glyph and a word for every state, so status never relies on color. */
export const STATE_TEXT: Record<SourceState, { glyph: string; word: string }> =
  {
    initializing: { glyph: "…", word: "Loading" },
    ready: { glyph: "●", word: "Up to date" },
    incomplete: { glyph: "◐", word: "Incomplete" },
    stale: { glyph: "◷", word: "Last known state" },
    offline: { glyph: "⊘", word: "Offline" },
    error: { glyph: "✕", word: "Error" },
  };

export function formatTime(seconds: number, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(seconds * 1000));
}

export function relativeTime(ms: number, now: number): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${String(Math.floor(s / 60))} min ago`;
  if (s < 86400) return `${String(Math.floor(s / 3600))} h ago`;
  return `${String(Math.floor(s / 86400))} d ago`;
}

/** One line describing a commit for lists and screen readers. */
export function describeNode(node: GraphNodeJson): string {
  const refs = node.refs.length > 0 ? `${node.refs.join(", ")} — ` : "";
  return `${shortOid(node.oid)} ${refs}${node.subject} (${reasonText(node.reasons)})`;
}

export function hiddenText(hidden: number | null): string {
  return hidden === null
    ? "Hidden ancestry: multiple paths"
    : `Hidden ancestry: ${String(hidden)} commit${hidden === 1 ? "" : "s"}`;
}

/** A short duration such as "45 s", "3 min", or "2 h". */
export function durationText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${String(s)} s`;
  if (s < 3600) return `${String(Math.round(s / 60))} min`;
  return `${String(Math.round(s / 3600))} h`;
}
