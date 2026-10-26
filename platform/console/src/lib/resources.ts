import type { OperatorAccount, OperatorEnvironments, OperatorEvent, OperatorOverview } from "@managed-copilot/protocol/operator";
import type { PlatformEventType } from "@managed-copilot/protocol";
import { useEffect, useState } from "react";
import { getEnvironments, getOverview, listAccounts, listEvents } from "./api.js";
import { ReconnectTracker } from "./feed.js";
import { usePoll, type PollState } from "./poll.js";
import { useStreamStatus } from "./stream.js";

/** Resources several views share (one request serves all of them). */
export function useOverview(): PollState<OperatorOverview> {
  return usePoll("overview", getOverview);
}

export function useEnvironments(): PollState<OperatorEnvironments> {
  return usePoll("environments", getEnvironments);
}

export function useAccounts(): PollState<OperatorAccount[]> {
  return usePoll("accounts", listAccounts);
}

export const EVENT_HISTORY_LIMIT = 200;

/**
 * Reloads history a view loads once (`refresh` from its `usePoll`) whenever the live stream reconnects: the stream
 * doesn't replay what was published while it was down, so those entries would otherwise never show up.
 */
export function useReloadAfterReconnect(refresh: () => Promise<void>): void {
  const connectedAt = useStreamStatus().connectedAt;
  const [tracker] = useState(() => new ReconnectTracker(connectedAt));
  useEffect(() => {
    if (tracker.reconnected(connectedAt)) void refresh();
  }, [tracker, connectedAt, refresh]);
}

/**
 * Recent platform events, loaded once and reloaded after the live stream reconnects (the stream delivers new ones in
 * between). The Events view and the overview share the unfiltered request.
 */
export function useEventHistory(type: PlatformEventType | undefined): PollState<OperatorEvent[]> {
  const history = usePoll(`events?type=${type ?? ""}&limit=${EVENT_HISTORY_LIMIT}`, (signal) => listEvents({ limit: EVENT_HISTORY_LIMIT, type }, signal), { intervalMs: 0 });
  useReloadAfterReconnect(history.refresh);
  return history;
}
