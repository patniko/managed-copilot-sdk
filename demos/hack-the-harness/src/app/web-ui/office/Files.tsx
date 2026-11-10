import { useEffect, useRef } from "react";
import { createPortal, useFrame, useThree } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { Plane, Raycaster, Vector2, Vector3, type Group, type PerspectiveCamera } from "three";
import { playerPosition } from "./Office";

/** A file dropped into the office, lying on the floor until someone walks over it. */
export type FloorFile = { id: number; file: File; x: number; z: number };
export type ToFloor = (clientX: number, clientY: number) => { x: number; z: number } | null;

const PICKUP_DISTANCE = 0.45;
const DROP_HEIGHT = 3;
const GRAVITY = 14;
const FLOOR = new Plane(new Vector3(0, 1, 0), 0);

/** Keeps `picker` able to turn a point on screen into the point on the floor under it. */
export function FloorPicker({ picker }: { picker: { current: ToFloor | null } }) {
  const camera = useThree(state => state.camera);
  const canvas = useThree(state => state.gl.domElement);

  useEffect(() => {
    picker.current = (clientX, clientY) => {
      const rect = canvas.getBoundingClientRect();
      const raycaster = new Raycaster();
      raycaster.setFromCamera(new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), camera);
      const hit = raycaster.ray.intersectPlane(FLOOR, new Vector3());
      return hit && { x: hit.x, z: hit.z };
    };
  }, [camera, canvas, picker]);

  return null;
}

/** A colour per file type, shared by the 3D papers and the chat's download cards. */
export function fileColor(name: string) {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "pdf") return "#d93f3f";
  if (["xlsx", "xls", "csv"].includes(extension)) return "#1f8a4c";
  if (["docx", "doc", "txt", "md"].includes(extension)) return "#2b6fd6";
  if (["pptx", "ppt"].includes(extension)) return "#e0752d";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extension)) return "#8a4bd6";
  return "#6b7280";
}

/** A little paper document, its band coloured by file type. */
function DocumentIcon({ name }: { name: string }) {
  return (
    <>
      <mesh castShadow>
        <boxGeometry args={[0.3, 0.4, 0.035]} />
        <meshStandardMaterial color="#f7f7f2" />
      </mesh>
      <mesh position={[0, 0.13, 0]}>
        <boxGeometry args={[0.29, 0.09, 0.04]} />
        <meshStandardMaterial color={fileColor(name)} />
      </mesh>
      {[0, -0.06, -0.12].map(y => (
        <mesh key={y} position={[-0.02, y, 0]}>
          <boxGeometry args={[0.2, 0.018, 0.04]} />
          <meshStandardMaterial color="#b8bcc4" />
        </mesh>
      ))}
    </>
  );
}

/** The files the player has picked up, gripped in a fan at the end of the arm. Goes inside the arm bone. */
export function CarriedFiles({ files }: { files: File[] }) {
  // Lie flat against the end of the arm, which the T-pose model angles outward and forward (measured from the mesh).
  return (
    <group position={[-0.279, 0.17, 0.086]} rotation={[0, -1.124, 0]}>
      {files.map((file, index) => (
        <group key={index} position={[0, 0, -index * 0.04]} rotation={[0, 0, index * 0.2]}>
          <DocumentIcon name={file.name} />
        </group>
      ))}
    </group>
  );
}

/** In first person, the carried files held at the bottom right of the view, bobbing as the player walks. */
export function HeldFiles({ files, moving }: { files: File[]; moving: boolean }) {
  const camera = useThree(state => state.camera);
  const held = useRef<Group>(null);
  const stride = useRef(0);

  useFrame((_, delta) => {
    if (!held.current) return;
    if (moving) stride.current += delta * 9;
    const swing = moving ? 1 : 0;
    // Pin to the bottom-right corner of the view whatever the window shape, so the paper is half off screen.
    const perspective = camera as PerspectiveCamera;
    const halfHeight = 0.5 * Math.tan((perspective.fov * Math.PI) / 360);
    const halfWidth = halfHeight * perspective.aspect;
    held.current.position.set(halfWidth - 0.04 + Math.sin(stride.current) * 0.015 * swing, -halfHeight + 0.07 + Math.abs(Math.cos(stride.current)) * 0.025 * swing, -0.5);
  });

  return createPortal(
    <group ref={held} rotation={[-0.35, -0.3, 0.3]} scale={0.8}>
      {files.map((file, index) => (
        <group key={index} position={[index * 0.04, 0, -index * 0.04]} rotation={[0, 0, index * -0.15]}>
          <DocumentIcon name={file.name} />
        </group>
      ))}
    </group>,
    camera,
  );
}

/** A spinning document that drops from above, bounces, then hovers until the player walks onto it. */
function FloorFileIcon({ item, onPickUp }: { item: FloorFile; onPickUp: (item: FloorFile) => void }) {
  const icon = useRef<Group>(null);
  const fall = useRef({ height: DROP_HEIGHT, speed: 0, taken: false });

  useFrame(({ clock }, delta) => {
    const body = icon.current;
    const state = fall.current;

    if (!body) {
      return;
    }

    const step = Math.min(delta, 0.05);
    if (state.height > 0 || state.speed !== 0) {
      state.speed -= GRAVITY * step;
      state.height += state.speed * step;
      if (state.height <= 0) {
        state.height = 0;
        state.speed = Math.abs(state.speed) > 1.5 ? -state.speed * 0.35 : 0;
      }
    }

    const landed = state.height === 0 && state.speed === 0;
    body.position.y = 0.3 + state.height + (landed ? Math.sin(clock.elapsedTime * 2.5) * 0.04 : 0);
    body.rotation.y += step * 1.6;

    if (landed && !state.taken && Math.hypot(playerPosition.x - item.x, playerPosition.z - item.z) < PICKUP_DISTANCE) {
      state.taken = true;
      onPickUp(item);
    }
  });

  return (
    <group position={[item.x, 0, item.z]}>
      <group ref={icon} position={[0, 0.3 + DROP_HEIGHT, 0]}>
        <DocumentIcon name={item.file.name} />
        <Html position={[0, 0.38, 0]} center zIndexRange={[10, 0]}>
          <div className="pointer-events-none max-w-40 truncate rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] text-white">{item.file.name}</div>
        </Html>
      </group>
    </group>
  );
}

export function FloorFiles({ files, onPickUp }: { files: FloorFile[]; onPickUp: (item: FloorFile) => void }) {
  return files.map(item => <FloorFileIcon key={item.id} item={item} onPickUp={onPickUp} />);
}

/** A file handed to an NPC, flying from where the player stood to land flat on their desk, where it stays. */
export type DeskFile = { id: number; file: File; from: { x: number; z: number }; to: { x: number; z: number; y: number } };

const FLIGHT_SECONDS = 0.8;

function DeskFileIcon({ item }: { item: DeskFile }) {
  const icon = useRef<Group>(null);
  const elapsed = useRef(0);

  useFrame((_, delta) => {
    if (!icon.current || elapsed.current >= FLIGHT_SECONDS) return;
    elapsed.current = Math.min(elapsed.current + delta, FLIGHT_SECONDS);
    const t = elapsed.current / FLIGHT_SECONDS;
    const { from, to } = item;
    icon.current.position.set(from.x + (to.x - from.x) * t, 1 + (to.y - 1) * t + Math.sin(t * Math.PI) * 0.8, from.z + (to.z - from.z) * t);
    // Tumble on the way, then settle flat.
    icon.current.rotation.set(-Math.PI / 2 * t, (1 - t) * 4 * Math.PI, 0);
  });

  return (
    <group ref={icon} position={[item.from.x, 1, item.from.z]}>
      <DocumentIcon name={item.file.name} />
    </group>
  );
}

export function DeskFiles({ files }: { files: DeskFile[] }) {
  return files.map(item => <DeskFileIcon key={item.id} item={item} />);
}
