import { LAUNCH_OFFER, PRODUCTS, type Product, type Slot } from '../../shared/catalog';
import type { BikePaint, RiderColors } from '../game/rider/types';

export { LAUNCH_OFFER, type Slot };

export interface ShopItem extends Product {
  readonly blurb: string;
  /** The card's colour swatch. */
  readonly swatch: readonly string[];
  /** A rider outfit: colours by the character's palette names. */
  readonly colors?: RiderColors;
  /** A bike paint job. */
  readonly paint?: BikePaint;
}

const LAVA = '#e2401c';
const EMBER = '#ffc83d';
const TEAL = '#18c9b5';
const VIOLET = '#7b4de0';
const PINK = '#ff5fb0';

/** How each product looks: the card, and the colours it puts on a rider or a bike. */
const LOOKS: Readonly<Record<string, Omit<ShopItem, keyof Product>>> = {
  'rider-sunset': {
    blurb: 'Blaze orange, like the last light on the ridge.',
    swatch: ['#ff6a1f', '#ff9a4d', '#141419'],
    colors: { shirt: '#ff6a1f' },
  },
  'rider-glacier': {
    blurb: 'Ice blue, cool under pressure.',
    swatch: ['#1fa2e6', '#7fd0f5', '#141419'],
    colors: { shirt: '#1fa2e6' },
  },
  'mona-neon': {
    blurb: 'Hot pink from ears to tentacle tips.',
    swatch: ['#ff2fa0', '#ff8ad0', '#ffd0ea'],
    colors: { body: '#ff2fa0', bodyLight: '#ff8ad0', earInner: '#ffd0ea', whisker: '#ffd0ea' },
  },
  'mona-gold': {
    blurb: 'Solid gold. Rides like it, too.',
    swatch: ['#c8961e', '#f0c75a', '#ffe3a3'],
    colors: { body: '#c8961e', bodyLight: '#f0c75a', earInner: '#ffe3a3', whisker: '#7a5a10' },
  },
  'copilot-stealth': {
    blurb: 'Matte black shell, neon cyan trim, pink eyes.',
    swatch: ['#2a2d36', '#19e3ff', '#ff4fd8'],
    colors: { shell: '#2a2d36', lilac: '#3b4150', purple: '#19e3ff', purpleDeep: '#0fb7d4', eyeGlow: '#ff4fd8' },
  },
  'copilot-ruby': {
    blurb: 'Candy red with gold trim and golden eyes.',
    swatch: ['#d7263d', '#ffd166', '#ff9aa8'],
    colors: { shell: '#d7263d', lilac: '#ff9aa8', purple: '#ffd166', purpleDeep: '#8c1525', eyeGlow: '#ffe066' },
  },
  'bike-lava': {
    blurb: 'Molten red frame with ember-yellow details.',
    swatch: [LAVA, EMBER, '#1c1d20'],
    paint: {
      frame: LAVA,
      swingarm: LAVA,
      downTubeBand: EMBER,
      topTubeBand: EMBER,
      accent: EMBER,
      forkLower: EMBER,
      rimStripe: EMBER,
      hub: EMBER,
      grip: EMBER,
      chainring: EMBER,
      pedal: EMBER,
      spring: EMBER,
    },
  },
  'bike-aurora': {
    blurb: 'Northern-lights teal with violet and pink.',
    swatch: [TEAL, VIOLET, PINK],
    paint: {
      frame: TEAL,
      swingarm: TEAL,
      downTubeBand: VIOLET,
      topTubeBand: PINK,
      accent: VIOLET,
      forkLower: VIOLET,
      rimStripe: PINK,
      hub: VIOLET,
      grip: PINK,
      chainring: VIOLET,
      pedal: PINK,
      spring: PINK,
      saddleAccent: PINK,
    },
  },
};

/** Everything the Downhill Shop sells, with its looks. */
export const ITEMS: readonly ShopItem[] = PRODUCTS.map((product) => ({ ...product, ...LOOKS[product.sku]! }));

export function findItem(sku: string): ShopItem | undefined {
  return ITEMS.find((item) => item.sku === sku);
}

const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** `499` → `$4.99`. */
export function formatCents(cents: number): string {
  return dollars.format(cents / 100);
}
