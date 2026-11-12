import type { ApiErrorBody, SupportRequest, SupportTicketResponse } from '../../shared/support';

/** The player's support ticket in this browser session (sessionStorage): opening support again reopens it. */
export const SUPPORT_TICKET_KEY = 'downhill.support.ticket';

export type TicketStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

let fallback: TicketStorage | undefined;

/** The browser's sessionStorage, or storage for this page only when the browser blocks it. */
export function sessionTicketStorage(): TicketStorage {
  try {
    const storage = window.sessionStorage;
    storage.getItem(SUPPORT_TICKET_KEY);
    return storage;
  } catch {
    const values = new Map<string, string>();
    fallback ??= { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value), removeItem: (key) => void values.delete(key) };
    return fallback;
  }
}

function savedTicket(storage: TicketStorage): string | undefined {
  try {
    const id = storage.getItem(SUPPORT_TICKET_KEY);
    return id && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Forgets this session's ticket, so the next time support opens it's a new one (a demo reset). */
export function forgetSupportTicket(storage: TicketStorage = sessionTicketStorage()): void {
  try {
    storage.removeItem(SUPPORT_TICKET_KEY);
  } catch {
    // nothing was kept
  }
}

/**
 * Asks Downhill's server to open the player's support ticket in Help Desk, or to reopen the one this browser session
 * already has, with what's new at checkout. Returns the ticket and the address of its chat. Failures are thrown as
 * errors whose message is written for the player (the server's own words when it sent some).
 */
export async function openSupportTicket(
  request: Omit<SupportRequest, 'ticketId'>,
  options: { fetcher?: typeof fetch; storage?: TicketStorage } = {},
): Promise<SupportTicketResponse> {
  const fetcher = options.fetcher ?? fetch;
  const storage = options.storage ?? sessionTicketStorage();
  const ticketId = savedTicket(storage);
  let response: Response;
  try {
    response = await fetcher('/api/support/tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, ...(ticketId ? { ticketId } : {}) } satisfies SupportRequest),
    });
  } catch {
    throw new Error("Couldn't reach Downhill's server. Check that it's still running, then try again.");
  }
  const body = (await response.json().catch(() => undefined)) as Partial<SupportTicketResponse & ApiErrorBody> | undefined;
  if (!response.ok) throw new Error(body?.error?.message ?? `Downhill's server couldn't open a support ticket (HTTP ${response.status}). Try again in a moment.`);
  const chatUrl = body?.chatUrl;
  let protocol = '';
  try {
    protocol = new URL(chatUrl ?? '').protocol;
  } catch {
    // not an address
  }
  if (!chatUrl || (protocol !== 'http:' && protocol !== 'https:') || typeof body?.ticketId !== 'string' || !body.ticketId) {
    throw new Error("Support answered with something the game couldn't open. Try again in a moment.");
  }
  try {
    storage.setItem(SUPPORT_TICKET_KEY, body.ticketId);
  } catch {
    // storage is full or off: the next time opens a new ticket
  }
  return { ticketId: body.ticketId, chatUrl };
}
