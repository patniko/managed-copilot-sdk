import * as THREE from 'three';
import type { SetPieceHandle, WorldContext } from '../types';
import { buildMegastructure } from './cityMega';
import { buildCloudDeck } from './citySky';
import { buildTown } from './cityTown';
import { buildTraffic } from './cityTraffic';
import { sunsetBlocks } from '../envs/city';

/** Sunset Blocks set pieces: the megastructure, the micro-districts below, traffic and the cloud deck. */
export function buildCitySetPieces(ctx: WorldContext): SetPieceHandle {
  const root = new THREE.Group();
  root.name = 'city';
  ctx.scene.add(root);
  buildMegastructure(ctx, root);
  buildTown(root);
  const traffic = buildTraffic();
  for (const o of traffic.objects) root.add(o);
  const deck = buildCloudDeck(sunsetBlocks.sky);
  root.add(deck.mesh);
  return {
    update(_dt, _time, camera) {
      traffic.update(camera);
      deck.update(camera);
    },
  };
}
