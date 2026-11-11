import { AlertIcon, ArrowLeftIcon, CommentDiscussionIcon, KebabHorizontalIcon, TableIcon, TrashIcon } from "@primer/octicons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AnalysisView } from "../../shared/types.js";
import { cx } from "../lib/cx.js";
import { formatCount } from "../lib/format.js";
import { useDismiss } from "../lib/hooks.js";
import { homeHref, navigate } from "../lib/router.js";
import { deleteAnalysis, loadAnalysis, useStore } from "../lib/store.js";
import { ChatPanel } from "./Chat.js";
import { DataPanel } from "./DataPanel.js";
import { FactoryButton, FactoryDialog } from "./Factory.js";
import { PlacementTrack, UsageMeter } from "./PlacementTrack.js";
import { Spinner } from "./ui/Spinner.js";

export function Workspace({ id }: { readonly id: string }) {
  const view = useStore((state) => state.views[id]);
  const error = useStore((state) => state.viewErrors[id]);
  const [panel, setPanel] = useState<"chat" | "data">("chat");
  const [sending, setSending] = useState(false);
  const openSend = useCallback(() => setSending(true), []);

  useEffect(() => {
    void loadAnalysis(id);
  }, [id]);

  if (!view) {
    return error ? (
      <div className="mx-auto mt-16 flex max-w-md flex-col items-center gap-3 px-4 text-center">
        <AlertIcon size={24} className="text-fg-muted" />
        <p>{error}</p>
        <div className="flex gap-2">
          <button type="button" className="btn" onClick={() => void loadAnalysis(id)}>
            Try again
          </button>
          <a className="btn btn-invisible" href={homeHref()}>
            All datasets
          </a>
        </div>
      </div>
    ) : (
      <div className="flex flex-1 items-center justify-center gap-2 text-fg-muted" role="status">
        <Spinner size={16} /> Opening the analysis…
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar view={view} onSend={openSend} />
      {view.problem ? (
        <div className="flash flash-warn flash-full flex shrink-0 items-center gap-2 py-2" role="status">
          <AlertIcon size={16} />
          <span className="min-w-0 truncate" title={view.problem}>
            {view.problem}
          </span>
        </div>
      ) : null}
      <div className="flex shrink-0 justify-center border-b border-line px-4 py-2 lg:hidden">
        <div className="SegmentedControl SegmentedControl--sm" role="tablist" aria-label="Show">
          <button type="button" role="tab" aria-selected={panel === "chat"} className="SegmentedControl-item" onClick={() => setPanel("chat")}>
            <CommentDiscussionIcon size={16} /> Chat
          </button>
          <button type="button" role="tab" aria-selected={panel === "data"} className="SegmentedControl-item" onClick={() => setPanel("data")}>
            <TableIcon size={16} /> Data
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <DataPanel view={view} onSend={openSend} className={cx("flex-1 border-line lg:flex lg:border-r", panel === "data" ? "flex" : "hidden")} />
        <ChatPanel view={view} className={cx("w-full shrink-0 lg:flex lg:w-[440px] xl:w-[480px]", panel === "chat" ? "flex" : "hidden")} />
      </div>
      {sending ? <FactoryDialog view={view} onClose={() => setSending(false)} /> : null}
    </div>
  );
}

function TopBar({ view, onSend }: { readonly view: AnalysisView; readonly onSend: () => void }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-3 border-b border-line bg-canvas px-4 py-3">
      <div className="flex min-w-0 flex-1 items-center gap-2 lg:w-64 lg:flex-none">
        <a href={homeHref()} className="btn-octicon shrink-0" aria-label="All datasets">
          <ArrowLeftIcon size={16} />
        </a>
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold" title={view.title}>
            {view.title}
          </h1>
          {view.dataset ? (
            <p className="text-xs text-fg-muted tabular-nums">
              {formatCount(view.dataset.rows, "row")} · {formatCount(view.dataset.columns.length, "column")}
            </p>
          ) : null}
        </div>
      </div>
      <PlacementTrack view={view} className="order-last w-full pb-4 md:order-none md:w-auto md:flex-1 md:pb-0 lg:mx-auto lg:max-w-[560px]" />
      <div className="flex shrink-0 items-center gap-2">
        <UsageMeter view={view} />
        <FactoryButton onOpen={onSend} />
        <Overflow view={view} />
      </div>
    </div>
  );
}

function Overflow({ view }: { readonly view: AnalysisView }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    setConfirming(false);
  }, []);
  useDismiss(container, open, close);
  const remove = async () => {
    setDeleting(true);
    if (await deleteAnalysis(view.id)) navigate(homeHref());
    setDeleting(false);
    close();
  };
  return (
    <div ref={container} className="relative">
      <button type="button" className="btn-octicon" aria-label="More actions" aria-haspopup="menu" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
        <KebabHorizontalIcon size={16} />
      </button>
      {open ? (
        <div className="Overlay absolute top-full right-0 z-40 mt-1 w-64 animate-scale-in" role="menu">
          <div className="Overlay-body p-2">
            {confirming ? (
              <div className="flex flex-col gap-2 p-2 text-sm">
                <p>Delete this analysis{view.placement === "sandbox" ? " and its sandbox" : ""}?</p>
                <div className="flex gap-2">
                  <button type="button" className="btn btn-sm btn-danger" disabled={deleting} onClick={() => void remove()}>
                    {deleting ? <Spinner size={16} /> : null}
                    Delete
                  </button>
                  <button type="button" className="btn btn-sm" onClick={close}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <ul className="ActionList">
                <li>
                  <button type="button" role="menuitem" className="ActionList-item ActionList-item--danger w-full" onClick={() => setConfirming(true)}>
                    <TrashIcon size={16} />
                    <span className="ActionList-item-label">Delete analysis</span>
                  </button>
                </li>
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
