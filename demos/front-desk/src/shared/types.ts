/** Front Desk's API and live-event shapes, shared by the server and the web UI. */

/** How a person signed in: with GitHub, or with an email and password kept by Front Desk. */
export type UserKind = "github" | "email";

/** Where a person's model use is billed: their own Copilot plan, or the app's Azure AI Foundry. */
export type BillingRoute = "copilot" | "foundry";

export interface BillingInfo {
  readonly route: BillingRoute;
  /** Plain words, e.g. "Your Copilot plan". */
  readonly label: string;
  /** One sentence on why. */
  readonly detail: string;
  /** People billed to the app: messages left today, and the daily allowance. */
  readonly remainingToday?: number;
  readonly dailyLimit?: number;
}

export interface UserView {
  readonly id: string;
  readonly kind: UserKind;
  readonly name: string;
  /** GitHub sign-ins. */
  readonly login?: string;
  /** Email sign-ins. */
  readonly email?: string;
  readonly avatarUrl?: string;
  readonly billing: BillingInfo;
}

export interface AuthOptions {
  /** "Continue with GitHub" is set up (a GitHub OAuth app). */
  readonly github: boolean;
  /** Local only: sign in as the account this computer's GitHub CLI uses. Never offered by a deployed app. */
  readonly localGitHub: boolean;
  /** Accounts with an email and password. */
  readonly email: boolean;
  /** Creating an account needs the invitation code the app's operator shared. */
  readonly inviteRequired: boolean;
  /** Whether people without GitHub can chat on this deployment, and why not. */
  readonly appUsers: { readonly available: boolean; readonly reason?: string };
}

export interface MeResponse {
  readonly user: UserView | null;
  readonly options: AuthOptions;
}

export interface SignUpRequest {
  readonly name: string;
  readonly email: string;
  readonly password: string;
  readonly invite?: string;
}

export interface SignInRequest {
  readonly email: string;
  readonly password: string;
}

export interface ConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Where this conversation's model use goes; fixed when it starts. */
  readonly route: BillingRoute;
  readonly model?: string;
  readonly busy: boolean;
}

export type ChatItem =
  | { readonly kind: "user"; readonly id: string; readonly text: string; readonly at: string }
  | { readonly kind: "assistant"; readonly id: string; readonly text: string; readonly at: string; readonly streaming?: boolean; readonly model?: string }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly tool: string;
      /** What it did, in plain words: "Remembered", "Looked through your memory". */
      readonly label: string;
      readonly detail?: string;
      readonly status: "running" | "done" | "failed";
      readonly at: string;
    }
  | { readonly kind: "notice"; readonly id: string; readonly tone: "info" | "warning" | "danger"; readonly text: string; readonly at: string };

export interface ConversationView extends ConversationSummary {
  readonly items: readonly ChatItem[];
  /** What Managed Copilot itself records for this conversation's session, when it says. */
  readonly platform?: PlatformRecord;
}

/** The platform's own record of a session: who owns it, and where its model calls go. */
export interface PlatformRecord {
  /** `github`: a GitHub account. `app-user`: one of Front Desk's own users. */
  readonly ownerKind: "github" | "app-user" | "app";
  /** The owner's login: a GitHub login, or `front-desk/<user ID>` for an app user. */
  readonly owner: string;
  /** Where model calls go: the owner's Copilot plan, or a Foundry account. */
  readonly inference?: { readonly route: BillingRoute; readonly foundry?: string };
  readonly model?: string;
}

export interface CreateConversationRequest {
  readonly prompt: string;
}

export interface SendMessageRequest {
  readonly prompt: string;
}

export interface MemoryItem {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
}

/** Live events for the signed-in person only, over server-sent events (`GET /api/events`). */
export type ServerEvent =
  | { readonly type: "conversation"; readonly conversation: ConversationSummary }
  | { readonly type: "conversation.deleted"; readonly id: string }
  | { readonly type: "item"; readonly conversationId: string; readonly item: ChatItem }
  | { readonly type: "delta"; readonly conversationId: string; readonly itemId: string; readonly delta: string }
  | { readonly type: "memories"; readonly memories: readonly MemoryItem[] }
  | { readonly type: "billing"; readonly billing: BillingInfo };

export interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

/** Limits the server enforces, shared so the UI can say them before a request fails. */
export const LIMITS = {
  prompt: 8_000,
  name: 80,
  email: 254,
  passwordMin: 10,
  passwordMax: 200,
  memory: 500,
  memoriesPerPerson: 200,
} as const;
