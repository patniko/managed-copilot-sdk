import { XIcon } from "@primer/octicons-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, errorMessage, type FileContent } from "../lib/api.js";
import { formatBytes } from "../lib/format.js";
import { Spinner } from "./ui/Spinner.js";

/** Previews a text file from a worker's workspace (a Primer dialog on the native modal `<dialog>`). */
export function FileDialog({ conversationId, workerId, path, onClose }: { readonly conversationId: string; readonly workerId: string; readonly path: string; readonly onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [file, setFile] = useState<FileContent>();
  const [error, setError] = useState<string>();

  useLayoutEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setFile(undefined);
    setError(undefined);
    api
      .file(conversationId, workerId, path)
      .then((loaded) => !cancelled && setFile(loaded))
      .catch((failure: unknown) => !cancelled && setError(errorMessage(failure)));
    return () => {
      cancelled = true;
    };
  }, [conversationId, workerId, path]);

  return (
    <dialog
      ref={dialog}
      aria-labelledby="file-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="Dialog Dialog--large animate-scale-in backdrop:animate-fade-in"
    >
      <div className="Dialog-header">
        <div className="Dialog-headerContent min-w-0">
          <h2 id="file-title" className="Dialog-title truncate font-mono text-sm">
            {path}
          </h2>
          {file && !file.binary ? <p className="Dialog-subtitle">{formatBytes(new TextEncoder().encode(file.content).length)}{file.truncated ? " shown; the file is longer" : ""}</p> : null}
        </div>
        <button type="button" className="btn btn-invisible btn-icon" aria-label="Close" onClick={onClose}>
          <XIcon size={16} />
        </button>
      </div>
      <div className="Dialog-body max-h-[70vh] overflow-auto p-0">
        {error ? (
          <p className="p-4 text-sm text-fg-danger">{error}</p>
        ) : !file ? (
          <div className="flex items-center gap-2 p-4 text-sm text-fg-muted">
            <Spinner size={16} />
            Reading the file from the worker's sandbox…
          </div>
        ) : file.binary ? (
          <p className="p-4 text-sm text-fg-muted">This file is binary, so it can't be previewed here.</p>
        ) : (
          <pre className="m-0 overflow-auto bg-canvas-inset p-4 font-mono text-xs leading-5 whitespace-pre">{file.content || "(empty file)"}</pre>
        )}
      </div>
    </dialog>
  );
}
