import { useCallback, useEffect, useState } from "react";
import type { SessionEvent } from "@github/copilot-sdk";
import type { SessionInfo } from "@managed-copilot/sdk";
import { request } from "../lib/api";
import { mergeEvents } from "../lib/timeline";
import { stage } from "../lib/stage";

function newestFirst(sessions: SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// Keeps the session list current as live events arrive.
function applyEvent(session: SessionInfo, event: SessionEvent): SessionInfo {
  switch (event.type) {
    case "session.title_changed":
      return { ...session, title: event.data.title, updatedAt: event.timestamp };
    case "assistant.turn_start":
      return { ...session, state: "running", updatedAt: event.timestamp };
    case "session.idle":
      return { ...session, state: "idle", updatedAt: event.timestamp };
    default:
      return session;
  }
}

export function useSessions() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [events, setEvents] = useState<Record<string, SessionEvent[]>>({});
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setSessions(newestFirst(await request<SessionInfo[]>(`/api/sessions?stage=${stage.id}`)));
  }, []);

  const open = useCallback(async (id: string) => {
    try {
      const history = await request<SessionEvent[]>(`/api/sessions/${id}/events`);
      setEvents(previous => ({ ...previous, [id]: mergeEvents(history, previous[id] ?? []) }));
    } catch (error) {
      setError((error as Error).message);
    }
  }, []);

  // Receive live session events from the server. EventSource reconnects automatically.
  useEffect(() => {
    const stream = new EventSource("/api/events");

    stream.onopen = () => {
      setConnected(true);
      refresh().catch(error => setError(error.message));
    };

    stream.onerror = () => {
      setConnected(false);
    };

    stream.onmessage = message => {
      const { sessionId, event } = JSON.parse(message.data) as { sessionId: string; event: SessionEvent };

      setSessions(previous => newestFirst(previous.map(session => session.id === sessionId ? applyEvent(session, event) : session)));
      setEvents(previous => ({ ...previous, [sessionId]: mergeEvents(previous[sessionId] ?? [], [event]) }));
    };

    return () => stream.close();
  }, [refresh]);

  return { sessions, setSessions, events, connected, error, setError, refresh, open };
}
