import { useEffect, useRef } from "react";
import type { GraphJson, SignatureJson } from "../api/types.ts";
import { formatTime, reasonText, shortOid } from "./format.ts";

export interface DetailsProps {
  graph: GraphJson | undefined;
  repoLabel: string;
  oid: string;
  timeZone: string;
  onClose: () => void;
  onSelect: (oid: string) => void;
}

function Person({
  role,
  who,
  timeZone,
}: {
  role: string;
  who: SignatureJson | null;
  timeZone: string;
}) {
  if (!who) return null;
  return (
    <div className="person">
      <dt>{role}</dt>
      <dd>
        {who.name} &lt;{who.email}&gt;
        <br />
        <time dateTime={new Date(who.time * 1000).toISOString()}>
          {formatTime(who.time, timeZone)}
        </time>{" "}
        <span className="muted">({who.timezone})</span>
      </dd>
    </div>
  );
}

/** Pinned commit details. Tracks the commit by OID across live updates. */
export function Details({
  graph,
  repoLabel,
  oid,
  timeZone,
  onClose,
  onSelect,
}: DetailsProps) {
  const node = graph?.nodes.find((n) => n.oid === oid);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [oid]);

  const branches = node?.refs.filter((r) => !r.startsWith("tag: ")) ?? [];
  const tags =
    node?.refs.filter((r) => r.startsWith("tag: ")).map((r) => r.slice(5)) ??
    [];
  const visible = new Set(graph?.nodes.map((n) => n.oid));

  return (
    <aside className="details" aria-label="Commit details">
      <div className="details-head">
        <h2 ref={heading} tabIndex={-1}>
          {node ? node.subject || "(no message)" : "Commit not shown"}
        </h2>
        <button
          type="button"
          className="close"
          aria-label="Close details"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <p className="muted">{repoLabel}</p>
      {!node ? (
        <p role="status">
          Commit <code>{shortOid(oid)}</code> is no longer in the current graph.
          Its branch may have moved or been deleted, or it left the
          recent-history window.
        </p>
      ) : (
        <>
          <dl>
            <div>
              <dt>Commit</dt>
              <dd>
                <code className="oid-full">{node.oid}</code>
              </dd>
            </div>
            {branches.length > 0 && (
              <div>
                <dt>Branches</dt>
                <dd>
                  <ul className="chips">
                    {branches.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </dd>
              </div>
            )}
            {tags.length > 0 && (
              <div>
                <dt>Tags</dt>
                <dd>
                  <ul className="chips">
                    {tags.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                </dd>
              </div>
            )}
            {node.worktrees.length > 0 && (
              <div>
                <dt>Worktrees</dt>
                <dd>
                  <ul className="plain">
                    {node.worktrees.map((w) => (
                      <li key={w.path}>
                        <code>{w.path}</code>
                        {w.main ? " (main)" : ""}
                        {w.detached
                          ? " — detached HEAD"
                          : w.branch
                            ? ` — ${w.branch.replace(/^refs\/heads\//, "")}`
                            : ""}
                        {w.locked !== null
                          ? ` — locked${w.locked ? `: ${w.locked}` : ""}`
                          : ""}
                        {w.prunable !== null ? " — prunable" : ""}
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            )}
            <Person role="Author" who={node.author} timeZone={timeZone} />
            <Person role="Committer" who={node.committer} timeZone={timeZone} />
            <div>
              <dt>Shown because</dt>
              <dd>
                {reasonText(node.reasons)}
                {node.futureDated && " — committer date is in the future"}
                {node.boundary &&
                  " — its parents are missing (shallow history)"}
              </dd>
            </div>
            {node.parents.length > 0 && (
              <div>
                <dt>
                  {node.parents.length > 1
                    ? `Parents (${String(node.parents.length)}, in order)`
                    : "Parent"}
                </dt>
                <dd>
                  <ul className="plain">
                    {node.parents.map((p) => (
                      <li key={p}>
                        {visible.has(p) ? (
                          <button
                            type="button"
                            className="link"
                            onClick={() => {
                              onSelect(p);
                            }}
                          >
                            {shortOid(p)}
                          </button>
                        ) : (
                          <span>
                            <code>{shortOid(p)}</code>{" "}
                            <span className="muted">(hidden)</span>
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            )}
          </dl>
          <h3>Message</h3>
          <pre className="message">{node.message.trimEnd()}</pre>
        </>
      )}
    </aside>
  );
}
