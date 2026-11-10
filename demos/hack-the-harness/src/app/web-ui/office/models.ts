/// <reference types="vite/client" />
import { useMemo } from "react";
import { Box3, Group, Mesh, Vector3, type Object3D } from "three";
import { useGLTF } from "@react-three/drei";

const urls = import.meta.glob<string>("./assets/**/*.glb", { eager: true, query: "?url", import: "default" });

export function modelUrl(path: string) {
  const url = urls[`./assets/${path}.glb`];

  if (!url) {
    throw new Error(`Missing office model ${path}`);
  }

  return url;
}

// Kenney's models have their origin at a corner. Re-centre each one so it sits on the floor at its own middle.
export function centred(object: Object3D) {
  const box = new Box3().setFromObject(object);
  const centre = box.getCenter(new Vector3());
  object.position.set(-centre.x, -box.min.y, -centre.z);

  const group = new Group();
  group.add(object);
  return group;
}

export function shadows(object: Object3D) {
  object.traverse(child => {
    if (child instanceof Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });

  return object;
}

export function useModel(path: string) {
  const { scene } = useGLTF(modelUrl(path));
  return useMemo(() => shadows(centred(scene.clone(true))), [scene]);
}
