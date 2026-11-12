/// <reference lib="webworker" />
import { generateHumanData, humanDataTransferables } from './human';

/** Builds the human rider's meshes off the main thread (see `preloadHumanRider`). */
self.onmessage = () => {
  const data = generateHumanData();
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(data, humanDataTransferables(data));
};
