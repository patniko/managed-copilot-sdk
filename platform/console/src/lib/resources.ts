import type { OperatorAccount, OperatorEnvironments, OperatorEvent, OperatorOverview } from "@managed-copilot/protocol/operator";
import type { PlatformEventType } from "@managed-copilot/protocol";
import { getEnvironments, getOverview, listAccounts, listEvents } from "./api.js";
import { usePoll, type PollState } from "./poll.js";

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
 * Recent platform events, loaded once (the live stream delivers new ones; views reload after a reconnect). The Events
 * view and the overview share the unfiltered request.
 */
export function useEventHistory(type: PlatformEventType | undefined): PollState<OperatorEvent[]> {
  return usePoll(`events?type=${type ?? ""}&limit=${EVENT_HISTORY_LIMIT}`, (signal) => listEvents({ limit: EVENT_HISTORY_LIMIT, type }, signal), { intervalMs: 0 });
}
