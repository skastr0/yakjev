import { useEffect, useRef, useState } from "react";
import type { Command, Graph } from "@yakjev/protocol";

type Execute = (command: Command, revision: number) => Promise<boolean>;

export const CONTEXT_LIMIT = 4000;

// Long-term facts and preferences the owner wants Jev to weigh in every
// judgment. The server adds them to each Jev call; nothing is sent from here
// except the saved text.
export function JevContext({
  graph,
  execute,
}: {
  graph: Graph;
  execute: Execute;
}) {
  const saved = graph.jevContext?.text ?? "";
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const dirty = draft !== saved;
  // Follow edits from elsewhere (another tab, an agent) unless mid-edit.
  const lastSaved = useRef(saved);
  useEffect(() => {
    if (draft === lastSaved.current) setDraft(saved);
    lastSaved.current = saved;
  }, [saved]);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (panel.current?.contains(event.target as Node)) return;
      if ((event.target as HTMLElement).closest?.(".jev-context-toggle"))
        return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [open]);
  const save = () => {
    if (!dirty || saving || draft.length > CONTEXT_LIMIT) return;
    const text = draft.trim();
    setDraft(text);
    setSaving(true);
    void execute({ type: "jev.context.set", text }, graph.revision).then(
      (ok) => {
        setSaving(false);
        if (!ok) return;
        setJustSaved(true);
        setTimeout(() => setJustSaved(false), 1800);
      },
    );
  };
  return (
    <div className="jev-context">
      <button
        type="button"
        className="jev-context-toggle"
        aria-expanded={open}
        aria-controls="jev-context-panel"
        data-set={saved.trim() ? "true" : "false"}
        onClick={() => setOpen((value) => !value)}
      >
        Jev context
      </button>
      {open && (
        <div
          ref={panel}
          id="jev-context-panel"
          className="jev-context-panel"
          role="dialog"
          aria-label="Jev context"
        >
          <p className="jev-context-lead">What Jev should always know</p>
          <p className="jev-note">
            Long-term facts and preferences. Jev reads this in every judgment,
            from the first thing you type.
          </p>
          <textarea
            autoFocus
            aria-label="Jev context"
            value={draft}
            rows={9}
            placeholder={
              "I run two projects: yakjev (this graph tool) and a sourdough bakery.\nTraining for a spring marathon.\nPrefer 'requires' only for true prerequisites."
            }
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setDraft(saved);
                setOpen(false);
              }
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                save();
              }
            }}
          />
          <div className="jev-context-foot">
            <span
              className="jev-context-count"
              data-over={draft.length > CONTEXT_LIMIT}
            >
              {draft.length}/{CONTEXT_LIMIT}
            </span>
            <span className="jev-note" role="status">
              {saving
                ? "Saving…"
                : justSaved
                  ? "Saved · Jev uses it now"
                  : dirty
                    ? "Unsaved"
                    : graph.jevContext
                      ? `Saved r${graph.jevContext.updated.revision}`
                      : ""}
            </span>
            <button
              type="button"
              className="primary"
              disabled={!dirty || saving || draft.length > CONTEXT_LIMIT}
              onClick={save}
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
