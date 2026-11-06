import { AlertIcon } from "@primer/octicons-react";
import { useEffect } from "react";
import { ConversationPage } from "./components/Conversation.js";
import { Header } from "./components/Header.js";
import { Home } from "./components/Home.js";
import { MemoryPanel } from "./components/MemoryPanel.js";
import { Sidebar } from "./components/Sidebar.js";
import { SignIn } from "./components/SignIn.js";
import { Spinner, Toasts } from "./components/ui/index.js";
import { useRoute } from "./lib/router.js";
import { loadMe, useStore } from "./lib/store.js";

export function App() {
  const me = useStore((state) => state.me);
  const meError = useStore((state) => state.meError);
  const route = useRoute();

  useEffect(() => {
    void loadMe();
  }, []);

  if (!me) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        {meError ? (
          <div className="blankslate max-w-md">
            <AlertIcon size={24} className="blankslate-icon text-fg-danger" />
            <h1 className="blankslate-heading">Front Desk isn't reachable</h1>
            <p className="blankslate-description">{meError}</p>
            <div className="blankslate-action">
              <button type="button" className="btn btn-primary" onClick={() => void loadMe()}>
                Try again
              </button>
            </div>
          </div>
        ) : (
          <Spinner size={32} className="text-fg-muted" label="Loading Front Desk" />
        )}
      </div>
    );
  }

  if (!me.user) {
    return (
      <>
        <SignIn options={me.options} />
        <Toasts />
      </>
    );
  }

  return (
    <div className="flex h-dvh flex-col bg-canvas text-fg">
      <Header user={me.user} />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          {route.page === "conversation" ? <ConversationPage key={route.id} id={route.id} user={me.user} /> : <Home user={me.user} />}
        </main>
        <MemoryPanel />
      </div>
      <Toasts />
    </div>
  );
}
