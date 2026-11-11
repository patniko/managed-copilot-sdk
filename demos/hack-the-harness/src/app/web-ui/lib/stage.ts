import { DEFAULT_STAGE, findStage, type Stage } from "../../server/stages";

/** The stage this page shows, from `?stage=` in its URL (the gallery links to each). */
export const stage: Stage = findStage(new URLSearchParams(window.location.search).get("stage")) ?? findStage(DEFAULT_STAGE)!;

/** Opens another stage, with its own chats. */
export function switchStage(id: string) {
  window.location.assign(`/?stage=${encodeURIComponent(id)}`);
}
