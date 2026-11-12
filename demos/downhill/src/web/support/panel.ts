import './support.css';
import type { SupportRequest } from '../../shared/support';
import { openSupportTicket } from './api';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** A message with the parts in backticks set as code, the way the server writes commands (`aspire run`). */
function withCode(message: string): DocumentFragment {
  const out = document.createDocumentFragment();
  message.split('`').forEach((part, i) => {
    if (part) out.append(i % 2 ? el('code', '', part) : part);
  });
  return out;
}

function status(text: string): HTMLElement {
  const box = el('div', 'support-status');
  box.setAttribute('role', 'status');
  box.append(el('div', 'spinner'), el('span', '', text));
  return box;
}

/**
 * Contoso Outdoors' support chat (Help Desk's AI agent), in a panel over the game: connecting, the chat, or what went
 * wrong. Opening it never says anything for the player: the agent greets them, and they write in the chat themselves.
 */
export class SupportPanel {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  private request: Omit<SupportRequest, 'ticketId'> | null = null;
  /** The chat on show, if any. */
  private chatUrl: string | null = null;
  private returnFocus: HTMLElement | null = null;
  private attempt = 0;
  /** Called when the panel opens or closes. */
  onChange?: (open: boolean) => void;

  constructor(parent: HTMLElement, private readonly click: () => void = () => undefined) {
    this.el = el('aside', 'support hidden');
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Contoso Outdoors support');
    const head = el('header', 'support-head');
    const title = el('div', 'support-title');
    const who = el('span');
    who.append(el('b', 'support-ai', 'AI agent'), ' · Help with Downhill and its shop');
    title.append(el('strong', '', 'Contoso Outdoors support'), who);
    this.closeButton = el('button', 'support-close', '×');
    this.closeButton.type = 'button';
    this.closeButton.setAttribute('aria-label', 'Close support');
    this.closeButton.onclick = () => {
      this.click();
      this.close();
    };
    head.append(title, this.closeButton);
    this.body = el('div', 'support-body');
    this.el.append(head, this.body);
    this.el.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      this.close();
    });
    parent.append(this.el);
  }

  get isOpen(): boolean {
    return !this.el.classList.contains('hidden');
  }

  /**
   * Opens the player's ticket, or reopens the one they have with what's new at checkout, and shows its chat. Opened
   * again while it's showing, the chat stays as it is.
   */
  open(request: Omit<SupportRequest, 'ticketId'>): void {
    this.request = request;
    if (!this.isOpen) {
      this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.el.classList.remove('hidden');
      requestAnimationFrame(() => this.el.classList.add('show'));
      this.onChange?.(true);
      this.closeButton.focus();
    }
    void this.connect();
  }

  close(): void {
    if (!this.isOpen) return;
    // a ticket still on its way is left alone: its chat is never shown
    this.attempt++;
    this.chatUrl = null;
    this.el.classList.remove('show');
    this.el.classList.add('hidden');
    this.body.replaceChildren();
    this.onChange?.(false);
    if (this.returnFocus?.isConnected) this.returnFocus.focus();
  }

  private async connect(): Promise<void> {
    const attempt = ++this.attempt;
    const request = this.request;
    if (!request) return;
    const showing = this.chatUrl;
    if (!showing) this.body.replaceChildren(status('Connecting you to support…'));
    try {
      const { chatUrl } = await openSupportTicket(request);
      if (attempt !== this.attempt || chatUrl === this.chatUrl) return;
      this.chatUrl = chatUrl;
      const frame = el('iframe');
      frame.title = 'Contoso Outdoors support';
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox');
      frame.referrerPolicy = 'no-referrer';
      const loading = status('Opening the chat…');
      loading.classList.add('over');
      frame.addEventListener(
        'load',
        () => {
          loading.remove();
          // The keyboard goes to the chat, so the player can write to the agent.
          if (this.isOpen && (document.activeElement === this.closeButton || document.activeElement === document.body)) frame.focus();
        },
        { once: true },
      );
      frame.src = chatUrl;
      this.body.replaceChildren(frame, loading);
    } catch (error) {
      if (attempt !== this.attempt) return;
      if (showing && this.chatUrl === showing) {
        // The chat on show still works; only telling it what's new at checkout didn't.
        console.warn('[support] couldn’t update the ticket', error);
        return;
      }
      this.chatUrl = null;
      const box = el('div', 'support-error');
      box.setAttribute('role', 'alert');
      const message = el('p');
      message.append(withCode(error instanceof Error ? error.message : String(error)));
      const retry = el('button', 'btn small lime', 'Try again');
      retry.type = 'button';
      retry.onclick = () => {
        this.click();
        void this.connect();
      };
      const close = el('button', 'btn small ghost', 'Close');
      close.type = 'button';
      close.onclick = () => {
        this.click();
        this.close();
      };
      const actions = el('div', 'support-actions');
      actions.append(retry, close);
      box.append(el('strong', '', "Couldn't connect you to support"), message, actions);
      this.body.replaceChildren(box);
      retry.focus();
    }
  }
}
