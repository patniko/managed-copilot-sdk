import './shop.css';
import type { PromoSource, ShopEventRequest, StorefrontInfo } from '../../shared/shop';
import type { SupportOpener, SupportRequest } from '../../shared/support';
import type { BikePaint, CharacterId, RiderColors } from '../game/rider/types';
import { forgetSupportTicket } from '../support/api';
import { CHAT_ICON } from '../support/icon';
import { findItem, formatCents, ITEMS, LAUNCH_OFFER, type ShopItem, type Slot } from './catalog';
import {
  addToCart,
  applyCode,
  chooseRider,
  clearCode,
  equip,
  itemStatus,
  loadShop,
  lookOf,
  newCheckout,
  promoEvent,
  purchase,
  purchaseEvent,
  removeFromCart,
  saveShop,
  SHOP_KEY,
  supportRequest,
  totals,
  unequip,
  type Checkout,
  type CheckoutHistory,
  type ItemStatus,
  type Order,
  type ShopState,
  type ShopStorage,
} from './shop';
import { loadStorefront, storefrontInfo, type Storefront } from './storefront';

/** The look the 3D preview shows: a rider, their outfit, and their bike's paint. */
export interface PreviewLook {
  readonly rider: CharacterId;
  readonly colors?: RiderColors;
  readonly paint?: BikePaint;
  /** Names the look, so the preview is rebuilt only when it changes. */
  readonly key: string;
}

export interface ShopHandlers {
  /** Leave the shop, back to the title screen. */
  back(): void;
  /** Ride as the current rider, in what they wear. */
  ride(): void;
  preview(look: PreviewLook): void;
  /** The rider you ride as, or what anyone wears, changed. */
  changed(state: ShopState): void;
  /** Open support (Contoso Outdoors' AI agent, in Help Desk) with what happened at checkout. */
  support(request: Omit<SupportRequest, 'ticketId'>): void;
  click(): void;
}

/** How often an open shop asks which storefront checkout runs, so a deployed fix shows up without a reload. */
const STOREFRONT_POLL_MS = 4_000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  b.onclick = onClick;
  return b;
}

/** Tells the sales ledger what happened at checkout. Fire and forget: it never holds up the player. */
function report(event: ShopEventRequest | undefined): void {
  if (!event) return;
  fetch('/api/shop/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event), keepalive: true }).catch((error: unknown) =>
    console.warn('[shop] couldn’t record a checkout event', error),
  );
}

/** `Checkout: storefront v2.3.1 · deployed from INC-1004, approved by mona` */
function storefrontLine(info: StorefrontInfo): string {
  const deployed = info.source === 'deployed' && info.incident ? ` · deployed from ${info.incident}${info.approvedBy ? `, approved by ${info.approvedBy}` : ''}` : '';
  return `Checkout: storefront v${info.version}${deployed}`;
}

/** The Downhill Shop: cosmetics for the riders and their bikes, sold by Contoso Outdoors, with a cart and checkout. */
export class ShopScreen {
  readonly el: HTMLElement;
  state: ShopState;
  private checkout: Checkout = newCheckout();
  /** The last code tried and the latest order, for support. */
  private history: CheckoutHistory = {};
  private selected: string | null = null;
  private receipt: Order | null = null;
  /** The storefront code checkout runs; none until it loads. */
  private storefront: Storefront | null = null;
  private storefrontProblem: string | null = null;
  private refreshing: Promise<void> | null = null;
  private poll: ReturnType<typeof setInterval> | undefined;
  /** A note under the Promo code field that isn't checkout's answer (an empty cart). */
  private notice: string | null = null;
  private readonly cards = new Map<string, { card: HTMLButtonElement; badge: HTMLElement }>();
  private readonly stage: HTMLElement;
  private readonly caption: HTMLElement;
  private readonly lines: HTMLElement;
  private readonly sums: HTMLElement;
  private readonly promoInput: HTMLInputElement;
  private readonly promoApply: HTMLButtonElement;
  private readonly promoNote: HTMLElement;
  private readonly buy: HTMLButtonElement;
  private readonly storefrontEl: HTMLElement;
  private readonly demo: HTMLElement;
  private readonly rideButton: HTMLButtonElement;
  private readonly receiptEl: HTMLElement;

  constructor(
    parent: HTMLElement,
    private readonly storage: ShopStorage,
    private readonly names: Readonly<Record<CharacterId, string>>,
    private readonly on: ShopHandlers,
  ) {
    this.state = loadShop(storage);
    this.el = el('div', 'screen shop hidden');
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Downhill Shop');

    // ----- left: the offer and the looks
    const side = el('section', 'shop-side');
    const title = el('div', 'shop-title', 'DOWNHILL SHOP');
    title.append(el('small', '', 'by Contoso Outdoors'));
    const offer = el('div', 'shop-offer');
    const offerText = el('p');
    offerText.append(el('span', 'tag', 'LAUNCH WEEK'), el('span', '', LAUNCH_OFFER.text));
    offer.append(
      offerText,
      button('Apply code', 'btn small', () => {
        this.on.click();
        this.promoInput.value = LAUNCH_OFFER.code;
        this.apply('banner');
      }),
    );
    const grid = el('div', 'shop-items');
    grid.setAttribute('role', 'list');
    for (const item of ITEMS) {
      const card = button('', 'shop-item', () => {
        this.on.click();
        this.select(item.sku);
      });
      card.setAttribute('role', 'listitem');
      card.dataset.sku = item.sku;
      const swatch = el('span', 'sw');
      for (const color of item.swatch) {
        const chip = el('i');
        chip.style.background = color;
        swatch.append(chip);
      }
      const badge = el('span', 'st');
      const foot = el('span', 'foot');
      foot.append(el('span', 'who', this.forWhom(item.slot)), badge);
      card.append(swatch, el('span', 'nm', item.name), foot);
      grid.append(card);
      this.cards.set(item.sku, { card, badge });
    }
    side.append(title, offer, grid);

    // ----- centre: the 3D preview shows through; the caption says what it is
    this.stage = el('section', 'shop-stage');
    this.caption = el('div', 'shop-caption');
    this.caption.setAttribute('aria-live', 'polite');
    this.stage.append(this.caption);

    // ----- right: cart and checkout
    const cart = el('section', 'shop-cart');
    cart.setAttribute('aria-label', 'Your cart');
    this.lines = el('ul', 'lines');
    const promo = el('form', 'promo');
    const label = el('label', '', 'Promo code');
    label.htmlFor = 'shop-promo';
    this.promoInput = el('input');
    Object.assign(this.promoInput, { id: 'shop-promo', type: 'text', placeholder: 'Enter a code', autocomplete: 'off', spellcheck: false, maxLength: 40 });
    this.promoApply = el('button', 'btn small', 'Apply');
    this.promoApply.type = 'submit';
    const field = el('div', 'field');
    field.append(this.promoInput, this.promoApply);
    promo.append(label, field);
    promo.onsubmit = (e) => {
      e.preventDefault();
      this.on.click();
      this.apply('typed');
    };
    this.promoInput.oninput = () => this.renderCart();
    this.promoNote = el('div', 'promo-note');
    this.sums = el('div', 'sums');
    this.buy = button('Buy', 'btn lime buy', () => {
      this.on.click();
      this.purchase();
    });
    this.storefrontEl = el('p', 'storefront-line', 'Checkout: loading the storefront…');
    this.storefrontEl.setAttribute('aria-live', 'polite');
    this.demo = el('p', 'demo-control');
    cart.append(el('h2', '', 'Your cart'), this.lines, promo, this.promoNote, this.sums, this.buy, el('p', 'fine', 'Demo purchase, no real payment.'), this.storefrontEl, this.demo);

    // ----- top right: leave, ask support, or ride in the new look
    const top = el('div', 'shop-top');
    this.rideButton = button('RIDE ▶', 'btn lime', () => {
      this.on.click();
      this.on.ride();
    });
    const help = button('', 'btn ghost small support-open-button', () => this.contact('support-button'));
    help.innerHTML = `${CHAT_ICON}Support`;
    help.title = 'Chat with Contoso Outdoors support';
    top.append(
      button('◀ Back', 'btn ghost small', () => {
        this.on.click();
        this.on.back();
      }),
      help,
      this.rideButton,
    );

    this.receiptEl = el('div', 'shop-receipt hidden');
    this.el.append(side, this.stage, cart, top, this.receiptEl);
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.receipt) {
        e.stopPropagation();
        this.closeReceipt();
      }
    });
    this.renderDemoControl(false);
    parent.append(this.el);
  }

  get isOpen(): boolean {
    return !this.el.classList.contains('hidden');
  }

  open(): void {
    this.selected = null;
    this.el.classList.remove('hidden');
    requestAnimationFrame(() => this.el.classList.add('show'));
    this.render();
    this.cards.get(ITEMS[0].sku)?.card.focus({ preventScroll: true });
    void this.refreshStorefront();
    clearInterval(this.poll);
    this.poll = setInterval(() => void this.refreshStorefront(), STOREFRONT_POLL_MS);
  }

  close(): void {
    clearInterval(this.poll);
    this.poll = undefined;
    this.closeReceipt();
    this.renderDemoControl(false);
    this.el.classList.remove('show');
    this.el.classList.add('hidden');
  }

  /** The rider picked elsewhere (the select screen, or `?char=`). */
  setRider(rider: CharacterId): void {
    this.update(chooseRider(this.state, rider));
  }

  /** What `rider` wears on a ride. */
  lookOf(rider: CharacterId): { colors?: RiderColors; paint?: BikePaint } {
    return lookOf(this.state, rider);
  }

  /** What support gets, opened from `opener`: the rider, and what happened at checkout if they've tried it. */
  supportRequest(opener: SupportOpener): Omit<SupportRequest, 'ticketId'> {
    return supportRequest(this.state, opener, this.checkout, this.history);
  }

  /** Where the preview should stand: the middle of the stage, from -1 (left edge of the window) to 1 (right edge). */
  stageCenter(): number {
    const r = this.stage.getBoundingClientRect();
    if (!r.width || !window.innerWidth) return 0;
    return ((r.left + r.width / 2) / window.innerWidth) * 2 - 1;
  }

  /** Asks the server which storefront checkout runs, and loads it when it changed (a deploy lands without a reload). */
  private refreshStorefront(): Promise<void> {
    this.refreshing ??= (async () => {
      try {
        const info = await storefrontInfo();
        const current = this.storefront?.info;
        if (current && current.modules.promotions === info.modules.promotions && current.modules.cart === info.modules.cart) {
          this.storefront = { ...this.storefront!, info };
        } else {
          const loaded = await loadStorefront(info);
          const changed = Boolean(current);
          this.storefront = loaded;
          if (changed) {
            this.storefrontEl.classList.remove('fresh');
            void this.storefrontEl.offsetWidth;
            this.storefrontEl.classList.add('fresh');
          }
        }
        this.storefrontProblem = null;
      } catch (error) {
        this.storefrontProblem = error instanceof Error ? error.message : String(error);
        console.warn('[shop] couldn’t load the storefront', error);
      } finally {
        this.refreshing = null;
      }
      if (this.isOpen) this.render();
    })();
    return this.refreshing;
  }

  private forWhom(slot: Slot): string {
    return slot === 'bike' ? 'For any bike' : `For ${this.names[slot]}`;
  }

  private update(state: ShopState): void {
    if (state === this.state) return;
    this.state = state;
    saveShop(this.storage, state);
    this.on.changed(state);
    if (this.isOpen) this.render();
  }

  private select(sku: string | null): void {
    this.selected = sku;
    this.render();
  }

  private status(sku: string): ItemStatus {
    return itemStatus(this.state, this.checkout, sku);
  }

  private apply(source: PromoSource): void {
    const code = this.promoInput.value;
    const storefront = this.storefront;
    if (!code.trim() || !storefront) return;
    if (!this.checkout.cart.lines.length) {
      this.notice = 'Add a look to your cart first, then apply the code.';
      this.renderCart();
      return;
    }
    this.notice = null;
    this.checkout = applyCode(storefront, this.checkout, code, source);
    this.history = { ...this.history, ...(this.checkout.promo ? { promo: this.checkout.promo } : {}) };
    report(promoEvent(storefront, this.state, this.checkout));
    this.renderCart();
  }

  private purchase(): void {
    const storefront = this.storefront;
    if (!this.checkout.cart.lines.length || !storefront) return;
    const { state, order } = purchase(storefront, this.state, this.checkout, new Date());
    report(purchaseEvent(this.state, order));
    this.history = { ...this.history, order };
    this.checkout = newCheckout();
    this.promoInput.value = '';
    this.notice = null;
    this.selected = null;
    this.update(state);
    this.showReceipt(order);
  }

  private closeReceipt(): void {
    if (!this.receipt) return;
    this.receipt = null;
    this.receiptEl.classList.add('hidden');
    this.receiptEl.replaceChildren();
    this.rideButton.focus({ preventScroll: true });
  }

  /** The look in the preview: the selected item on whoever it's for, else the current rider as they ride. */
  private previewLook(): PreviewLook {
    const item = this.selected ? findItem(this.selected) : undefined;
    const rider = item && item.slot !== 'bike' ? item.slot : this.state.rider;
    const worn = lookOf(this.state, rider);
    const outfit = item?.colors ? item.sku : (this.state.equipped[rider] ?? '');
    const paintJob = item?.paint ? item.sku : (this.state.equipped.bike ?? '');
    const colors = item?.colors ?? worn.colors;
    const paint = item?.paint ?? worn.paint;
    return { rider, ...(colors ? { colors } : {}), ...(paint ? { paint } : {}), key: `${rider}|${outfit}|${paintJob}` };
  }

  private render(): void {
    for (const [sku, { card, badge }] of this.cards) {
      const status = this.status(sku);
      card.classList.toggle('sel', sku === this.selected);
      card.classList.toggle('mine', status === 'owned' || status === 'equipped');
      card.setAttribute('aria-pressed', String(sku === this.selected));
      badge.textContent = status === 'equipped' ? 'EQUIPPED' : status === 'owned' ? 'OWNED' : status === 'in-cart' ? 'IN CART' : formatCents(findItem(sku)!.priceCents);
      badge.dataset.status = status;
    }
    this.rideButton.textContent = `RIDE AS ${this.names[this.state.rider].toUpperCase()} ▶`;
    this.renderCaption();
    this.renderCart();
    this.on.preview(this.previewLook());
  }

  private renderCaption(): void {
    const item = this.selected ? findItem(this.selected) : undefined;
    const c = this.caption;
    c.replaceChildren();
    if (!item) {
      const worn = [this.state.equipped[this.state.rider], this.state.equipped.bike].flatMap((sku) => (sku ? [findItem(sku)!.name] : []));
      c.append(el('div', 'nm', this.names[this.state.rider]), el('div', 'blurb', worn.length ? `Equipped: ${worn.join(' and ')}.` : 'In their own colours. Pick a look to try it on.'));
      return;
    }
    const status = this.status(item.sku);
    const row = el('div', 'deal');
    row.append(el('span', 'price', status === 'owned' || status === 'equipped' ? 'Yours' : formatCents(item.priceCents)));
    const act = (label: string, cls: string, run: (storefront: Storefront | null) => void, needsCheckout = false) => {
      const b = button(label, cls, () => {
        this.on.click();
        run(this.storefront);
        this.render();
      });
      if (needsCheckout && !this.storefront) {
        b.disabled = true;
        b.title = 'Checkout is loading';
      }
      row.append(b);
    };
    if (status === 'for-sale') act('Add to cart', 'btn small lime', (storefront) => storefront && (this.checkout = addToCart(storefront, this.checkout, item)), true);
    else if (status === 'in-cart') act('Remove from cart', 'btn small ghost', (storefront) => storefront && (this.checkout = removeFromCart(storefront, this.checkout, item.sku)), true);
    else if (status === 'owned') act(item.slot === 'bike' ? 'Use this paint' : 'Wear it', 'btn small lime', () => this.update(equip(this.state, item.sku)));
    else act(item.slot === 'bike' ? 'Back to stock paint' : 'Take it off', 'btn small ghost', () => this.update(unequip(this.state, item.slot)));
    c.append(el('div', 'nm', item.name), el('div', 'who', this.forWhom(item.slot)), el('div', 'blurb', item.blurb), row);
  }

  private renderCart(): void {
    const { cart, promo } = this.checkout;
    const storefront = this.storefront;
    this.lines.replaceChildren();
    if (!cart.lines.length) this.lines.append(el('li', 'empty', 'Your cart is empty. Pick a look, then Add to cart.'));
    for (const line of cart.lines) {
      const li = el('li');
      const item = findItem(line.sku);
      li.append(el('span', 'nm', line.name), el('span', 'who', item ? this.forWhom(item.slot) : ''), el('span', 'pr', formatCents(line.priceCents)));
      const remove = button('×', 'rm', () => {
        this.on.click();
        if (this.storefront) this.checkout = removeFromCart(this.storefront, this.checkout, line.sku);
        this.render();
      });
      remove.setAttribute('aria-label', `Remove ${line.name}`);
      remove.disabled = !storefront;
      li.append(remove);
      this.lines.append(li);
    }
    this.promoApply.disabled = !this.promoInput.value.trim() || !storefront;

    this.promoNote.replaceChildren();
    this.promoNote.className = 'promo-note';
    if (this.notice) {
      this.promoNote.classList.add('info');
      this.promoNote.append(el('p', 'promo-msg', this.notice));
    } else if (promo?.error) {
      this.promoNote.classList.add('error');
      const message = el('p', 'promo-msg', promo.error);
      message.setAttribute('role', 'alert');
      const help = el('p', 'help', 'Code not working? ');
      help.append(button('Contact support', 'link', () => this.contact('promo-error')));
      this.promoNote.append(message, help);
    } else if (promo?.applied) {
      this.promoNote.classList.add('ok');
      const message = el('p', 'promo-msg', `${promo.applied.code} applied: ${promo.applied.percent}% off. `);
      message.setAttribute('role', 'status');
      message.append(
        button('Remove', 'link', () => {
          this.on.click();
          this.checkout = clearCode(this.checkout);
          this.promoInput.value = '';
          this.render();
        }),
      );
      this.promoNote.append(message);
    }

    this.sums.replaceChildren();
    const sum = (label: string, value: string, cls = '') => {
      const row = el('div', `sum ${cls}`.trim());
      row.append(el('span', '', label), el('span', '', value));
      this.sums.append(row);
    };
    if (storefront) {
      const t = totals(storefront, this.checkout);
      sum('Subtotal', formatCents(t.subtotalCents));
      if (promo?.applied) sum(`Discount (${promo.applied.code})`, `−${formatCents(t.discountCents)}`, 'discount');
      sum('Total', formatCents(t.totalCents), 'total');
      this.buy.textContent = cart.lines.length ? `Buy · ${formatCents(t.totalCents)}` : 'Buy';
    } else {
      sum('Total', '—', 'total');
      this.buy.textContent = 'Buy';
    }
    this.buy.disabled = !cart.lines.length || !storefront;

    // Which storefront code checkout runs, as the server says.
    const info = storefront?.info;
    this.storefrontEl.classList.toggle('problem', Boolean(this.storefrontProblem));
    this.storefrontEl.textContent = info
      ? `${storefrontLine(info)}${this.storefrontProblem ? ` (couldn't check for a newer one: ${this.storefrontProblem})` : ''}`
      : this.storefrontProblem
        ? `Checkout couldn't load the storefront code: ${this.storefrontProblem} Trying again…`
        : 'Checkout: loading the storefront…';
  }

  /** "Reset demo": a demo control for rehearsals, with a second step so it's never pressed by accident. */
  private renderDemoControl(confirming: boolean, problem?: string): void {
    const d = this.demo;
    d.replaceChildren();
    if (!confirming) {
      d.append(
        'Demo control · ',
        button('Reset demo', 'link', () => {
          this.on.click();
          this.renderDemoControl(true);
        }),
      );
      if (problem) d.append(el('span', 'problem', ` ${problem}`));
      return;
    }
    d.append(
      'Start launch day over? This clears purchases and the support ticket in this browser, and Downhill’s live sales, deployed fixes, and alert. ',
      button('Reset', 'link', () => {
        this.on.click();
        void this.resetDemo();
      }),
      ' · ',
      button('Cancel', 'link', () => this.renderDemoControl(false)),
    );
  }

  private async resetDemo(): Promise<void> {
    try {
      const response = await fetch('/api/demo/reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ timeline: 'restart' }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => undefined)) as { error?: { message?: string } } | undefined;
        throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
      }
    } catch (error) {
      this.renderDemoControl(false, `Couldn't reset: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    try {
      this.storage.removeItem(SHOP_KEY);
    } catch {
      // storage turned off: nothing was kept
    }
    forgetSupportTicket();
    location.reload();
  }

  /** The receipt over the shop: the order, what's now worn, and support when the order didn't get the discount. */
  private showReceipt(order: Order): void {
    this.receipt = order;
    const panel = el('div', 'panel');
    panel.append(el('h1', '', 'Thanks for your order!'), el('h3', '', `Order ${order.id} · Demo purchase, no real payment`));
    const lines = el('ul', 'lines');
    for (const item of order.items) {
      const li = el('li');
      li.append(el('span', 'nm', item.name), el('span', 'pr', formatCents(item.priceCents)));
      lines.append(li);
    }
    const sums = el('div', 'sums');
    const sum = (label: string, value: string, cls = '') => {
      const row = el('div', `sum ${cls}`.trim());
      row.append(el('span', '', label), el('span', '', value));
      sums.append(row);
    };
    sum('Subtotal', formatCents(order.subtotalCents));
    if (order.discountCents) sum(`Discount (${order.code})`, `−${formatCents(order.discountCents)}`, 'discount');
    sum('Total paid', formatCents(order.totalCents), 'total');
    const worn = Object.values(this.state.equipped);
    const equipped = order.items.filter((item) => worn.includes(item.sku)).map((item) => item.name);
    panel.append(lines, sums, el('p', 'wearing', `Now equipped: ${equipped.join(' and ')}. Ride to see it.`));
    if (!order.discountCents) {
      const help = el('p', 'help', `Expected 15% off with ${LAUNCH_OFFER.code}? `);
      help.append(button('Contact support', 'link', () => this.contact('receipt')));
      panel.append(help);
    }
    const ride = button(`Ride as ${this.names[this.state.rider]} ▶`, 'btn lime', () => {
      this.on.click();
      this.on.ride();
    });
    const row = el('div', 'row2');
    row.append(
      ride,
      button('Keep shopping', 'btn ghost', () => {
        this.on.click();
        this.closeReceipt();
      }),
    );
    panel.append(row);
    this.receiptEl.replaceChildren(panel);
    this.receiptEl.classList.remove('hidden');
    ride.focus({ preventScroll: true });
  }

  private contact(opener: SupportOpener): void {
    this.on.click();
    this.on.support(this.supportRequest(opener));
  }
}
