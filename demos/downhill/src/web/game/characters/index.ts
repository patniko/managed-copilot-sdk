import type { CharacterDef, CharacterId } from '../rider/types';
import { createBike } from './bike';
import { COPILOT_BIKE, MONA_BIKE, RIDER_BIKE } from './bikeStyles';
import { createCopilotRider } from './copilot';
import { createMonaRider } from './mona';
import { createHumanRider, preloadHumanRider } from './human';

export { COPILOT_BIKE, MONA_BIKE, RIDER_BIKE } from './bikeStyles';

export const CHARACTERS: CharacterDef[] = [
  {
    id: 'rider',
    name: 'Rider',
    tagline: 'Straight out of the painting.',
    accent: '#4f8a6f',
    ridesSeated: true,
    preload: preloadHumanRider,
    createBike: (paint) => createBike({ ...RIDER_BIKE, ...paint }),
    createRider: (colors) => createHumanRider(colors),
  },
  {
    id: 'mona',
    name: 'Mona',
    tagline: 'Five tentacles, zero brakes.',
    accent: '#8957e5',
    createBike: (paint) => createBike({ ...MONA_BIKE, ...paint }),
    createRider: (colors) => createMonaRider(colors),
  },
  {
    id: 'copilot',
    name: 'Copilot',
    tagline: 'Always suggests the fastest line.',
    accent: '#2fd3c6',
    createBike: (paint) => createBike({ ...COPILOT_BIKE, ...paint }),
    createRider: (colors) => createCopilotRider(colors),
  },
];

export function getCharacter(id: CharacterId): CharacterDef {
  return CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];
}

/** Start generating every character's heavy assets in the background (call early, await before riding). */
export function preloadCharacters(): Promise<void> {
  return Promise.all(CHARACTERS.map((c) => c.preload?.())).then(() => undefined);
}

export { createBike, type BikeStyle } from './bike';
