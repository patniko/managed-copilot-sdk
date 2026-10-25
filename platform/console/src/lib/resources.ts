import type { OperatorAccount, OperatorEnvironments, OperatorOverview } from "@managed-copilot/protocol/operator";
import { getEnvironments, getOverview, listAccounts } from "./api.js";
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
