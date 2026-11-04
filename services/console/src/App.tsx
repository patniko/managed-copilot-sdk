import type { OperatorIdentity } from "@managed-copilot/protocol/operator";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActionDialog } from "./components/ui/ActionDialog.js";
import { Sidebar } from "./components/layout/Sidebar.js";
import { TopBar } from "./components/layout/TopBar.js";
import {
  BootScreen,
  ForbiddenScreen,
  GitHubUnavailableScreen,
  SignedOutScreen,
  SigningInScreen,
  TicketFailedScreen,
  UnreachableScreen,
} from "./components/screens/AuthScreens.js";
import { Toasts } from "./components/ui/Toasts.js";
import { useAuth } from "./lib/auth.js";
import { useLocation } from "./lib/router.js";
import { routeView, type Query, type Route } from "./lib/routes.js";
import { startStream, stopStream } from "./lib/stream.js";
import { AccountsView } from "./views/AccountsView.js";
import { ActionsView } from "./views/ActionsView.js";
import { AuditView } from "./views/AuditView.js";
import { ConnectionsView } from "./views/ConnectionsView.js";
import { EnvironmentDetailView } from "./views/EnvironmentDetailView.js";
import { EnvironmentsView } from "./views/EnvironmentsView.js";
import { EventsView } from "./views/EventsView.js";
import { InfrastructureView } from "./views/InfrastructureView.js";
import { LogsView } from "./views/LogsView.js";
import { NotFoundView } from "./views/NotFoundView.js";
import { OverviewView } from "./views/OverviewView.js";
import { SandboxesView } from "./views/SandboxesView.js";
import { SchedulesView } from "./views/SchedulesView.js";
import { SessionDetailView } from "./views/SessionDetailView.js";
import { SessionsView } from "./views/SessionsView.js";
import { WebhooksView } from "./views/WebhooksView.js";

export function App() {
  const auth = useAuth();
  let screen;
  switch (auth.status) {
    case "checking":
      screen = <BootScreen />;
      break;
    case "signing-in":
      screen = <SigningInScreen />;
      break;
    case "signed-in":
      // Keyed by account: if another operator signs in from another tab, nothing of the previous one's state survives.
      screen = <Shell key={auth.identity.account.id} identity={auth.identity} />;
      break;
    case "signed-out":
      screen = <SignedOutScreen reason={auth.reason} message={auth.message} />;
      break;
    case "ticket-failed":
      screen = <TicketFailedScreen message={auth.message} />;
      break;
    case "forbidden":
      screen = <ForbiddenScreen message={auth.message} login={auth.login} />;
      break;
    case "github-unavailable":
      screen = <GitHubUnavailableScreen message={auth.message} retryAt={auth.retryAt} retrying={auth.retrying} />;
      break;
    case "unreachable":
      screen = <UnreachableScreen error={auth.error} retrying={auth.retrying} />;
      break;
  }
  return (
    <>
      {screen}
      <Toasts />
    </>
  );
}

function Shell({ identity }: { readonly identity: OperatorIdentity }) {
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const main = useRef<HTMLElement>(null);
  const previousPath = useRef(location.pathname);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  useEffect(() => {
    startStream();
    return () => stopStream();
  }, []);

  // A new page starts at the top, with focus on the content so screen readers announce it.
  useEffect(() => {
    if (previousPath.current === location.pathname) return;
    previousPath.current = location.pathname;
    const element = main.current;
    if (!element) return;
    element.scrollTop = 0;
    element.focus({ preventScroll: true });
  }, [location.pathname]);

  return (
    <div className="flex h-dvh flex-col bg-canvas">
      <a
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          main.current?.focus();
        }}
        className="sr-only z-50 rounded-md bg-accent-emphasis px-3 py-2 font-semibold text-fg-on-emphasis focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <TopBar identity={identity} onOpenMenu={() => setDrawerOpen(true)} />
      <div className="flex min-h-0 flex-1">
        <Sidebar active={routeView(location.route)} drawerOpen={drawerOpen} onCloseDrawer={closeDrawer} />
        <main id="main" ref={main} tabIndex={-1} className="min-w-0 flex-1 overflow-y-auto focus:outline-none">
          <RouteView route={location.route} query={location.query} />
        </main>
      </div>
      <ActionDialog />
    </div>
  );
}

function RouteView({ route, query }: { readonly route: Route; readonly query: Query }) {
  switch (route.kind) {
    case "overview":
    case "signin":
      return <OverviewView />;
    case "infrastructure":
      return <InfrastructureView />;
    case "environments":
      return <EnvironmentsView />;
    case "environment":
      return <EnvironmentDetailView key={route.name} name={route.name} query={query} />;
    case "sessions":
      return <SessionsView query={query} />;
    case "session":
      return <SessionDetailView key={route.id} id={route.id} query={query} />;
    case "connections":
      return <ConnectionsView />;
    case "sandboxes":
      return <SandboxesView query={query} />;
    case "schedules":
      return <SchedulesView query={query} />;
    case "webhooks":
      return <WebhooksView query={query} />;
    case "actions":
      return <ActionsView query={query} />;
    case "accounts":
      return <AccountsView />;
    case "events":
      return <EventsView query={query} />;
    case "logs":
      return <LogsView query={query} />;
    case "audit":
      return <AuditView />;
    case "not-found":
      return <NotFoundView path={route.path} />;
  }
}
