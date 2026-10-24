/** REST route table shared by the gateway and its clients. Every `/v1` route requires `Authorization: Bearer <GitHub token>`. */

const e = encodeURIComponent;

export const ROUTES = {
  health: "/healthz",
  info: "/v1/info",
  me: "/v1/me",
  /** WebSocket upgrade for the SDK bridge. */
  connect: "/v1/connect",
  /** Server-sent platform events for the caller's sessions. */
  events: "/v1/events",

  sessions: "/v1/sessions",
  session: (id: string) => `/v1/sessions/${e(id)}`,
  promote: (id: string) => `/v1/sessions/${e(id)}/promote`,
  /** `POST` returns short-lived `AttachMaterial` for Copilot CLI attach (spec section 14). */
  attach: (id: string) => `/v1/sessions/${e(id)}/attach`,
  /** WebSocket (AHP) upgrade for an attach ticket: `Authorization: Bearer <ticket>` or `?tkn=<ticket>`. */
  attachSocket: (id: string) => `/v1/sessions/${e(id)}/ahp`,

  actions: (id: string) => `/v1/sessions/${e(id)}/actions`,
  actionClaim: (id: string, actionId: string) => `/v1/sessions/${e(id)}/actions/${e(actionId)}/claim`,
  actionResult: (id: string, actionId: string) => `/v1/sessions/${e(id)}/actions/${e(actionId)}/result`,

  /** `GET ?path=dir` lists; `GET .../content?path=` downloads; `PUT .../content?path=` uploads (streamed). */
  files: (id: string) => `/v1/sessions/${e(id)}/files`,
  fileContent: (id: string) => `/v1/sessions/${e(id)}/files/content`,

  /** `GET ?versions=all|latest` */
  artifacts: (id: string) => `/v1/sessions/${e(id)}/artifacts`,
  /** `GET ?turnId=&timeoutMs=` waits for a turn's publication manifest. */
  artifactPublication: (id: string) => `/v1/sessions/${e(id)}/artifacts/publication`,
  artifactContent: (id: string, artifactId: string) => `/v1/sessions/${e(id)}/artifacts/${e(artifactId)}/content`,

  vaults: "/v1/vaults",
  vault: (id: string) => `/v1/vaults/${e(id)}`,

  schedules: "/v1/schedules",
  schedule: (id: string) => `/v1/schedules/${e(id)}`,
  scheduleRuns: (id: string) => `/v1/schedules/${e(id)}/runs`,
  schedulePause: (id: string) => `/v1/schedules/${e(id)}/pause`,
  scheduleResume: (id: string) => `/v1/schedules/${e(id)}/resume`,
  scheduleRunNow: (id: string) => `/v1/schedules/${e(id)}/run`,

  /** `POST` stores this deployment's background credential (`managed-copilot login`); `DELETE` revokes it. */
  backgroundCredential: "/v1/credentials/background",
} as const;
