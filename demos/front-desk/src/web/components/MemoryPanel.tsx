import { LightBulbIcon, LockIcon, TrashIcon, XIcon } from "@primer/octicons-react";
import { useState } from "react";
import { clearMemories, deleteMemory, setMemoryOpen, useStore } from "../lib/store.js";

/** What Front Desk remembers about the signed-in person: theirs alone, and they can remove any of it. */
export function MemoryPanel() {
  const open = useStore((state) => state.memoryOpen);
  const memories = useStore((state) => state.memories);
  const [confirmClear, setConfirmClear] = useState(false);
  if (!open) return null;

  const panel = (
    <section aria-label="What Front Desk remembers about you" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line-muted px-4 py-3">
        <LightBulbIcon size={16} className="text-fg-done" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">What Front Desk remembers</h2>
        <button type="button" className="btn-octicon" aria-label="Close" onClick={() => setMemoryOpen(false)}>
          <XIcon size={16} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {memories.length === 0 ? (
          <div className="blankslate blankslate--sm">
            <LightBulbIcon size={24} className="blankslate-icon" />
            <h3 className="blankslate-heading">Nothing yet</h3>
            <p className="blankslate-description">Ask Front Desk to remember something, like “Remember that I'm vegetarian.”</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {memories.map((memory) => (
              <li key={memory.id} className="group flex items-start gap-2 rounded-md border border-line-muted bg-canvas px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 break-words">{memory.text}</span>
                <button type="button" className="btn-octicon btn-octicon-danger -mr-1 shrink-0" aria-label={`Forget "${memory.text}"`} onClick={() => void deleteMemory(memory.id)}>
                  <TrashIcon size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex shrink-0 flex-col gap-2 border-t border-line-muted px-4 py-3 text-xs text-fg-muted">
        <p className="flex items-start gap-1.5">
          <LockIcon size={12} className="mt-0.5 shrink-0" />
          Only you and your conversations with Front Desk can see this. Nobody else's assistant can read it.
        </p>
        {memories.length > 0 ? (
          confirmClear ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={() => {
                  setConfirmClear(false);
                  void clearMemories();
                }}
              >
                Forget everything
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setConfirmClear(false)}>
                Keep it
              </button>
            </div>
          ) : (
            <button type="button" className="btn btn-sm self-start" onClick={() => setConfirmClear(true)}>
              Forget everything…
            </button>
          )
        ) : null}
      </div>
    </section>
  );

  return (
    <>
      <aside className="hidden w-80 shrink-0 animate-slide-in-right border-l border-line-muted bg-canvas-inset xl:block">{panel}</aside>
      <div className="fixed inset-0 z-40 xl:hidden">
        <button type="button" className="absolute inset-0 bg-backdrop" aria-label="Close" onClick={() => setMemoryOpen(false)} />
        <aside className="absolute inset-y-0 right-0 w-80 max-w-[85vw] animate-slide-in-right border-l border-line bg-canvas shadow-xl">{panel}</aside>
      </div>
    </>
  );
}
