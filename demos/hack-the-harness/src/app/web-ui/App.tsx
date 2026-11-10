import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Download, Gamepad2, FileText, Loader2, MessageSquare, Moon, PackageX, LogOut, PanelLeftClose, PanelLeftOpen, Paperclip, Plus, Square, Sun, Trash2, X } from "lucide-react";
import type { MessageOptions } from "@github/copilot-sdk";
import type { SessionInfo } from "@managed-copilot/sdk";
import { Button } from "./components/ui/button";
import { ChatContainerContent, ChatContainerRoot } from "./components/ui/chat-container";
import { Message, MessageContent } from "./components/ui/message";
import { PromptInput, PromptInputActions, PromptInputTextarea } from "./components/ui/prompt-input";
import { groupSteps, Steps } from "./components/steps";
import { useSessions } from "./hooks/useSessions";
import { request } from "./lib/api";
import { fileElements, timeline } from "./lib/timeline";
import { toAttachment } from "./lib/attachments";

const OfficeView = lazy(() => import("./office/OfficeView"));
import { cn } from "./lib/utils";

function select(id: string | null) {
  window.location.hash = id ?? "";
}

function title(session: SessionInfo) {
  return session.title?.replace(fileElements, "") || "New chat";
}

export function App() {
  const data = useSessions();
  const [activeId, setActiveId] = useState(() => window.location.hash.slice(1) || null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<Record<string, File[]>>({});
  const [dragging, setDragging] = useState(false);
  const [creating, setCreating] = useState(false);
  const [sending, setSending] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [dark, setDark] = useState(false);
  const [office, setOffice] = useState(() => sessionStorage.getItem("office") === "1");

  useEffect(() => sessionStorage.setItem("office", office ? "1" : "0"), [office]);
  const [user, setUser] = useState<{ name: string }>();
  const fileInput = useRef<HTMLInputElement>(null);

  const active = data.sessions.find(session => session.id === activeId);
  const events = activeId ? data.events[activeId] : undefined;
  const items = useMemo(() => groupSteps(timeline(events ?? [])), [events]);
  const input = activeId ? drafts[activeId] ?? "" : "";
  const pendingFiles = activeId ? files[activeId] ?? [] : [];
  const busy = active?.state === "running" || active?.state === "waiting" || sending;
  const ready = Boolean(events && data.connected);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  useEffect(() => {
    request<{ name: string }>("/api/me").then(setUser);
  }, []);

  useEffect(() => {
    const changed = () => setActiveId(window.location.hash.slice(1) || null);
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);

  // Load the selected chat, and reload it after reconnecting to the server.
  useEffect(() => {
    if (activeId && data.connected) {
      void data.open(activeId);
    }
  }, [activeId, data.connected, data.open]);

  function setPendingFiles(id: string, update: (files: File[]) => File[]) {
    setFiles(previous => ({ ...previous, [id]: update(previous[id] ?? []) }));
  }

  function attachFiles(added: File[]) {
    if (activeId && added.length) {
      setPendingFiles(activeId, previous => [...previous, ...added]);
    }
  }

  async function createChat() {
    setCreating(true);

    try {
      const session = await request<SessionInfo>("/api/sessions", "POST");
      data.setSessions(previous => [session, ...previous]);
      select(session.id);
    } catch (error) {
      data.setError((error as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function submit() {
    if (!activeId || !ready || busy || (!input.trim() && !pendingFiles.length)) {
      return;
    }

    const id = activeId;
    setSending(true);
    data.setError(null);

    try {
      const message: MessageOptions = {
        prompt: input.trim(),
        attachments: await Promise.all(pendingFiles.map(toAttachment)),
      };
      await request(`/api/sessions/${id}/messages`, "POST", message);
      setDrafts(previous => ({ ...previous, [id]: "" }));
      setPendingFiles(id, () => []);
    } catch (error) {
      data.setError((error as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function stop() {
    try {
      await request(`/api/sessions/${activeId}/cancel`, "POST");
    } catch (error) {
      data.setError((error as Error).message);
    }
  }

  async function releaseWorkspace() {
    try {
      await request(`/api/sessions/${activeId}/release`, "POST");
    } catch (error) {
      data.setError((error as Error).message);
    }
  }

  async function deleteChat(session: SessionInfo) {
    if (!confirm(`Delete "${title(session)}"?`)) {
      return;
    }

    try {
      await request(`/api/sessions/${session.id}`, "DELETE");
      data.setSessions(previous => previous.filter(item => item.id !== session.id));

      if (activeId === session.id) {
        select(null);
      }
    } catch (error) {
      data.setError((error as Error).message);
    }
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      {sidebar && (
        <aside className="flex w-64 shrink-0 flex-col border-r bg-sidebar p-3 max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-30" aria-label="Chat sessions">
          <div className="flex items-center gap-2">
            <Button className="min-w-0 flex-1 justify-start gap-2" variant="secondary" disabled={creating || !data.connected} onClick={() => void createChat()}>
              {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus size={18} />} New chat
            </Button>
            <Button size="icon" variant="ghost" aria-label="Hide sidebar" onClick={() => setSidebar(false)}>
              <PanelLeftClose size={18} />
            </Button>
          </div>

          <div className="mt-7 px-2 text-xs font-medium text-muted-foreground">Your chats</div>

          <nav className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto" aria-label="Conversations">
            {data.sessions.map(session => (
              <div key={session.id} className={cn("group flex items-center rounded-lg hover:bg-sidebar-accent", activeId === session.id && "bg-sidebar-accent")}>
                <button
                  className="flex min-w-0 flex-1 items-center gap-2 px-3 py-3 text-left text-sm"
                  onClick={() => select(session.id)}
                  aria-current={activeId === session.id ? "page" : undefined}
                  title={title(session)}
                >
                  {session.state === "running" || session.state === "waiting"
                    ? <Loader2 className="size-4 shrink-0 animate-spin" />
                    : <MessageSquare className="size-4 shrink-0 text-muted-foreground" />}
                  <span className="truncate">{title(session)}</span>
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="mr-1 size-8 shrink-0 text-muted-foreground md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                  aria-label={`Delete chat: ${title(session)}`}
                  onClick={() => void deleteChat(session)}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            ))}
          </nav>

          {user && (
            <form method="post" action="/logout" className="flex items-center gap-2 border-t pt-3">
              <span className="grid size-7 place-items-center rounded-full bg-primary text-xs font-medium uppercase text-primary-foreground">{user.name[0]}</span>
              <span className="min-w-0 flex-1 truncate text-sm capitalize">{user.name}</span>
              <Button type="submit" size="icon" variant="ghost" aria-label="Sign out" title="Sign out">
                <LogOut size={16} />
              </Button>
            </form>
          )}
        </aside>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-border bg-black/5 px-5 dark:bg-white/5">
          <div className="flex min-w-0 items-center gap-3">
            {!sidebar && (
              <Button variant="ghost" size="icon" aria-label="Show sidebar" onClick={() => setSidebar(true)}>
                <PanelLeftOpen size={18} />
              </Button>
            )}
            <span className="text-base font-medium">Staff assistant</span>
          </div>
          <div className="flex items-center gap-1">
            {/* Throws away the agent's workspace sandbox. Change `false` to `true` for the Direct architecture in the README. */}
            {false && activeId && (
              <Button variant="ghost" className="gap-2 text-muted-foreground" onClick={() => void releaseWorkspace()}>
                <PackageX size={18} /> Release workspace
              </Button>
            )}
            <Button
              variant={office ? "secondary" : "ghost"}
              size="icon"
              className="text-muted-foreground"
              aria-label={office ? "Leave office mode" : "Office mode"}
              aria-pressed={office}
              onClick={() => setOffice(value => !value)}
            >
              <Gamepad2 size={18} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground"
              aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
              onClick={() => setDark(value => !value)}
            >
              {dark ? <Sun size={18} /> : <Moon size={18} />}
            </Button>
          </div>
        </header>

        {!data.connected && (
          <div role="status" className="border-y border-border bg-muted px-5 py-3 text-sm">
            Connecting…
          </div>
        )}

        {data.error && (
          <div role="alert" className="flex items-start justify-between gap-3 border-y border-destructive/30 bg-destructive/10 px-5 py-3 text-sm">
            <span>{data.error}</span>
            <button aria-label="Dismiss error" onClick={() => data.setError(null)}>
              <X size={16} />
            </button>
          </div>
        )}

        {office && (
          <Suspense fallback={<div role="status" className="flex flex-1 items-center justify-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading office…</div>}>
            <OfficeView data={data} onExit={() => setOffice(false)} />
          </Suspense>
        )}

        {!office && (
        <>
        <ChatContainerRoot key={activeId ?? "welcome"} className="relative min-h-0 flex-1">
          <ChatContainerContent className="mx-auto w-full max-w-3xl gap-8 px-5 py-10 md:px-10">
            {!activeId && (
              <div className="mx-auto flex min-h-[50dvh] w-full max-w-xl flex-col justify-center">
                <h1 className="text-center text-3xl font-semibold tracking-tight">How can I help?</h1>
                <Button variant="secondary" className="mx-auto mt-8 gap-2" disabled={creating || !data.connected} onClick={() => void createChat()}>
                  <Plus size={16} /> Start a conversation
                </Button>
              </div>
            )}

            {activeId && !events && (
              <div role="status" className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading conversation…
              </div>
            )}

            {events && items.length === 0 && (
              <div className="flex min-h-[45dvh] items-center justify-center">
                <h1 className="text-3xl font-semibold tracking-tight">What would you like to know?</h1>
              </div>
            )}

            {items.map(item => {
              if (item.kind === "tool") {
                const path = String(item.input.path);
                return (
                  <a
                    key={item.id}
                    href={`/api/sessions/${activeId}/files?${new URLSearchParams(item.input as Record<string, string>)}`}
                    download
                    className="flex max-w-[85%] items-center gap-3 self-start rounded-lg border px-4 py-3 text-sm hover:bg-muted"
                  >
                    <FileText className="size-5 shrink-0 text-muted-foreground" />
                    <span className="truncate font-medium">{path.split("/").pop()}</span>
                    <Download className="size-4 shrink-0 text-muted-foreground" />
                  </a>
                );
              }

              if (item.kind === "steps") {
                return <Steps key={item.id} tools={item.tools} />;
              }

              return (
                <Message key={item.id} className={cn("w-full flex-col", item.kind === "user" ? "items-end" : "items-start")}>
                  {item.attachments && (
                    <div className="mb-2 flex max-w-[85%] flex-wrap justify-end gap-2">
                      {item.attachments.map((name, index) => (
                        <span key={index} className="flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                          <FileText className="size-4 shrink-0 text-muted-foreground" />
                          <span className="truncate">{name}</span>
                        </span>
                      ))}
                    </div>
                  )}
                  {item.content && (
                    <MessageContent
                      markdown={item.kind === "assistant"}
                      className={cn(
                        "text-sm leading-6",
                        item.kind === "user"
                          ? "max-w-[85%] whitespace-pre-wrap rounded-xl bg-muted px-5 py-3"
                          : "w-full bg-transparent p-0 prose prose-sm dark:prose-invert",
                        item.kind === "error" && "text-destructive",
                      )}
                    >
                      {item.content}
                    </MessageContent>
                  )}
                </Message>
              );
            })}

            {busy && (
              <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Thinking…
              </div>
            )}
          </ChatContainerContent>
        </ChatContainerRoot>

        {activeId && (
          <div className="mx-auto w-full max-w-3xl px-4 pb-3 pt-3 md:px-8 md:pb-5">
            <PromptInput
              className={cn("relative", dragging && "ring-2 ring-ring")}
              value={input}
              onValueChange={value => setDrafts(previous => ({ ...previous, [activeId]: value }))}
              onSubmit={() => void submit()}
              disabled={!ready || sending}
              onDragOver={event => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={event => {
                event.preventDefault();
                setDragging(false);
                attachFiles(Array.from(event.dataTransfer.files));
              }}
              onPaste={event => attachFiles(Array.from(event.clipboardData.files))}
            >
              {dragging && (
                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-background/95 text-sm font-medium">
                  Drop files to attach
                </div>
              )}

              {pendingFiles.length > 0 && (
                <div aria-label="Pending attachments" className="flex flex-wrap gap-2 px-2 pb-3">
                  {pendingFiles.map((file, index) => (
                    <div key={index} className="flex max-w-full items-center gap-2 rounded-lg border bg-muted px-3 py-2 text-sm">
                      <FileText className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{file.name}</span>
                      <button
                        type="button"
                        className="ml-1 p-1 text-muted-foreground"
                        aria-label={`Remove ${file.name}`}
                        disabled={sending}
                        onClick={() => setPendingFiles(activeId, previous => previous.filter(item => item !== file))}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <PromptInputTextarea className="text-sm" placeholder="Ask the assistant" aria-label="Message" />

              <PromptInputActions className="mt-3 justify-between px-2 pb-1">
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  onChange={event => {
                    attachFiles(Array.from(event.currentTarget.files ?? []));
                    event.currentTarget.value = "";
                  }}
                />
                <Button variant="ghost" size="icon" className="size-9 text-muted-foreground" aria-label="Attach files" disabled={!ready || busy} onClick={() => fileInput.current?.click()}>
                  <Paperclip size={18} />
                </Button>
                {busy ? (
                  <Button size="icon" className="size-9 rounded-full" aria-label="Stop response" onClick={() => void stop()}>
                    <Square size={14} />
                  </Button>
                ) : (
                  <Button size="icon" className="size-9 rounded-full" aria-label="Send message" disabled={!ready || (!input.trim() && !pendingFiles.length)} onClick={() => void submit()}>
                    <ArrowUp size={18} />
                  </Button>
                )}
              </PromptInputActions>
            </PromptInput>
          </div>
        )}
        </>
        )}
      </main>
    </div>
  );
}
