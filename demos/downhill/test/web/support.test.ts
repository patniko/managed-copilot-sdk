import { describe, expect, it } from 'vitest';
import { forgetSupportTicket, openSupportTicket, SUPPORT_TICKET_KEY, type TicketStorage } from '../../src/web/support/api';

function memory(): TicketStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value), removeItem: (key) => void values.delete(key) };
}

/** Downhill's server, answering with the tickets given, one per request; records what it was sent. */
function server(...answers: Array<{ status: number; body: unknown }>) {
  const sent: unknown[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    const answer = answers[Math.min(sent.length, answers.length) - 1]!;
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { sent, fetcher };
}

const ticket = (id: string) => ({ status: 201, body: { ticketId: id, chatUrl: `http://localhost:7440/chat/${id}` } });
const request = { player: { rider: 'mona' }, opener: 'support-button' } as const;

describe("the player's support ticket", () => {
  it('is opened once per browser session, then reopened with the same id', async () => {
    const storage = memory();
    const { sent, fetcher } = server(ticket('m3k9x2abcdef'), ticket('m3k9x2abcdef'), ticket('m3kaaa999999'));
    expect(await openSupportTicket(request, { fetcher, storage })).toEqual({ ticketId: 'm3k9x2abcdef', chatUrl: 'http://localhost:7440/chat/m3k9x2abcdef' });
    expect(sent[0]).toEqual(request);
    expect(storage.values.get(SUPPORT_TICKET_KEY)).toBe('m3k9x2abcdef');

    await openSupportTicket({ ...request, opener: 'promo-error' }, { fetcher, storage });
    expect(sent[1]).toEqual({ ...request, opener: 'promo-error', ticketId: 'm3k9x2abcdef' });

    // That ticket ended, so Help Desk opened a new one: it's the one to reopen from now on.
    await openSupportTicket(request, { fetcher, storage });
    expect(storage.values.get(SUPPORT_TICKET_KEY)).toBe('m3kaaa999999');
    forgetSupportTicket(storage);
    await openSupportTicket(request, { fetcher, storage });
    expect(sent[3]).toEqual(request);
  });

  it("explains failures in the server's words, and keeps the ticket it had", async () => {
    const storage = memory();
    storage.setItem(SUPPORT_TICKET_KEY, 'm3k9x2abcdef');
    const notConnected = server({ status: 503, body: { error: { code: 'support_not_connected', message: "Support isn't connected. Start Help Desk with `aspire run`, or set HELP_DESK_URL." } } });
    await expect(openSupportTicket(request, { fetcher: notConnected.fetcher, storage })).rejects.toThrow("Support isn't connected. Start Help Desk with `aspire run`, or set HELP_DESK_URL.");
    const elsewhere = server({ status: 201, body: { ticketId: 'x', chatUrl: 'javascript:alert(1)' } });
    await expect(openSupportTicket(request, { fetcher: elsewhere.fetcher, storage })).rejects.toThrow("Support answered with something the game couldn't open. Try again in a moment.");
    const down = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    await expect(openSupportTicket(request, { fetcher: down, storage })).rejects.toThrow("Couldn't reach Downhill's server. Check that it's still running, then try again.");
    expect(storage.values.get(SUPPORT_TICKET_KEY)).toBe('m3k9x2abcdef');
  });
});
