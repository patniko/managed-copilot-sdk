import * as THREE from 'three';

export function createRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    powerPreference: 'high-performance',
    reversedDepthBuffer: true,
    preserveDrawingBuffer: false,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  return renderer;
}

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';

export interface QualityPreset {
  level: QualityLevel;
  renderScale: number;
  pixelRatioCap: number;
  radius: number;
  grassNear: number;
  grassFar: number;
  shadowMap: number;
}

export const QUALITY: Record<QualityLevel, QualityPreset> = {
  low: { level: 'low', renderScale: 0.6, pixelRatioCap: 1, radius: 5, grassNear: 22000, grassFar: 14000, shadowMap: 1024 },
  medium: { level: 'medium', renderScale: 0.75, pixelRatioCap: 1, radius: 6, grassNear: 50000, grassFar: 30000, shadowMap: 2048 },
  high: { level: 'high', renderScale: 0.9, pixelRatioCap: 1.25, radius: 8, grassNear: 90000, grassFar: 50000, shadowMap: 2048 },
  ultra: { level: 'ultra', renderScale: 1, pixelRatioCap: 2, radius: 8.5, grassNear: 140000, grassFar: 70000, shadowMap: 4096 },
};
