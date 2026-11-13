import { Html } from "@react-three/drei";
import { useFrame, type ThreeElements } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";
import { CanvasTexture, RepeatWrapping, SRGBColorSpace, type Group } from "three";
import { useModel } from "./models";
import { Character, type CharacterName } from "./Character";
import { screenTexture, type ScreenName } from "./screens";
import type { Thought } from "./Conversation";

export const ROOM = { width: 12, depth: 10 };
const WALL_HEIGHT = 2.2;

// Alice is the data scientist who uses the spreadsheet skill; Bob is the programmer who doesn't.
export type Npc = { name: string; role?: string; model: CharacterName; screen: ScreenName };

export const TALK_DISTANCE = 1.6;
// Updated every frame by the player so NPCs can turn to face them.
export const playerPosition = { x: 0, z: 0 };

export const DESKS: Array<{ x: number; z: number; npc: Npc }> = [
  { x: 3, z: 3, npc: { name: "Bob", role: "Programmer", model: "male-c", screen: "bsod" } },
  { x: 6.5, z: 3, npc: { name: "Alice", role: "Data scientist", model: "female-b", screen: "excel" } },
  { x: 3, z: 6.5, npc: { name: "Dave", model: "male-e", screen: "minesweeper" } },
  { x: 6.5, z: 6.5, npc: { name: "Carol", model: "female-d", screen: "word" } },
];

// Axis-aligned boxes the player can't walk into: [minX, minZ, maxX, maxZ].
// Where each NPC's chair sits, just behind the desk.
export function seat(desk: { x: number; z: number }) {
  return { x: desk.x - 0.15, z: desk.z + 0.45 };
}

export const OBSTACLES: Array<[number, number, number, number]> = [
  ...DESKS.flatMap(({ x, z }) => [
    [x - 0.55, z - 0.85, x + 0.55, z + 0.75] as [number, number, number, number],
    [x - 1.2, z - 1.25, x + 1.2, z - 1.15] as [number, number, number, number],
    [x - 1.25, z - 1.2, x - 1.15, z + 0.4] as [number, number, number, number],
  ]),
  [10.2, 0, 12, 1.2],
  [0, 8.4, 1.4, 10],
  [8.6, 7.6, 11.4, 9.6],
];

function Model({ path, ...props }: ThreeElements["group"] & { path: string }) {
  const object = useModel(path);
  return (
    <group {...props}>
      <primitive object={object} />
    </group>
  );
}

function Box({ size, color, ...props }: ThreeElements["mesh"] & { size: [number, number, number]; color: string }) {
  return (
    <mesh castShadow receiveShadow {...props}>
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} />
    </mesh>
  );
}

// One-sided wall that faces into the room, so it's invisible from the isometric camera outside.
let ceilingTiles: CanvasTexture | undefined;

/** A faint drop-ceiling tile grid. */
function ceilingTexture() {
  if (ceilingTiles) return ceilingTiles;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#b9b4a8";
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = "#a39e92";
  ctx.fillRect(0, 0, 64, 2);
  ctx.fillRect(0, 0, 2, 64);
  ceilingTiles = new CanvasTexture(canvas);
  ceilingTiles.wrapS = ceilingTiles.wrapT = RepeatWrapping;
  ceilingTiles.repeat.set(ROOM.width / 0.4, ROOM.depth / 0.4);
  ceilingTiles.colorSpace = SRGBColorSpace;
  ceilingTiles.anisotropy = 8;
  return ceilingTiles;
}

/** Faces down only, so the isometric camera sees straight through it. */
function Ceiling() {
  return (
    <mesh position={[ROOM.width / 2, WALL_HEIGHT, ROOM.depth / 2]} rotation={[Math.PI / 2, 0, 0]}>
      <planeGeometry args={[ROOM.width, ROOM.depth]} />
      <meshBasicMaterial map={ceilingTexture()} />
    </mesh>
  );
}

function InnerWall({ length, color, ...props }: ThreeElements["group"] & { length: number; color: string }) {
  return (
    <group {...props}>
      <mesh receiveShadow position={[0, WALL_HEIGHT / 2, 0]}>
        <planeGeometry args={[length, WALL_HEIGHT]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.35} />
      </mesh>
      <mesh position={[0, 0.06, 0.005]}>
        <planeGeometry args={[length, 0.12]} />
        <meshStandardMaterial color="#7a5c3e" />
      </mesh>
    </group>
  );
}

/** When each NPC last started a tool call, and whether they have since started replying. Set by the chat panel. */
export const atComputer: Record<string, { since: number; replying: boolean }> = {};

const SWIVEL_SECONDS = 0.35;
const MIN_AT_COMPUTER_MS = 2000;

function Swivel({ x, z, npc }: { x: number; z: number; npc: Npc }) {
  const group = useRef<Group>(null);
  // Only the seat turns; the legs stay planted.
  const chairModel = useModel("furniture/chairDesk");
  const seatPart = chairModel.getObjectByName("chair");
  // Each turn eases out from where the chair was when the NPC decided to face somewhere new.
  const swing = useRef({ facing: "desk", from: Math.PI, elapsed: SWIVEL_SECONDS });

  useFrame((_, delta) => {
    const chair = group.current;

    if (!chair) {
      return;
    }

    const dx = playerPosition.x - x;
    const dz = playerPosition.z - z;
    const work = atComputer[npc.name];
    const working = work && (!work.replying || performance.now() - work.since < MIN_AT_COMPUTER_MS);
    const facing = !working && Math.hypot(dx, dz) < TALK_DISTANCE ? "player" : "desk";
    const target = facing === "player" ? Math.atan2(dx, dz) : Math.PI;
    const s = swing.current;

    if (facing !== s.facing) {
      Object.assign(s, { facing, from: chair.rotation.y, elapsed: 0 });
    }
    s.elapsed += delta;

    const t = Math.min(1, s.elapsed / SWIVEL_SECONDS);
    const turn = Math.atan2(Math.sin(target - s.from), Math.cos(target - s.from));
    chair.rotation.y = s.from + turn * (1 - (1 - t) ** 3);
    if (seatPart) seatPart.rotation.y = chair.rotation.y - Math.PI;
  });

  return (
    <>
      <group position={[x, 0, z]} rotation={[0, Math.PI, 0]} scale={1.4}>
        <primitive object={chairModel} />
      </group>
      <group ref={group} position={[x, 0, z]} rotation={[0, Math.PI, 0]}>
        <Character model={npc.model} animation="sit" position={[0, SEAT_HEIGHT, 0.05]} />
      </group>
    </>
  );
}

const SEAT_HEIGHT = 0.4;

const THOUGHT_LINGER_MS = 2500;

/** Whether a bubble is showing: from when it appears until it has lingered for a while after it's done. */
function useShowing(thought: Thought | null) {
  const [showing, setShowing] = useState(false);
  const { text, done, at } = thought ?? {};
  const visible = !!thought;

  useEffect(() => {
    setShowing(visible);
    if (done) {
      const timer = setTimeout(() => setShowing(false), THOUGHT_LINGER_MS);
      return () => clearTimeout(timer);
    }
  }, [visible, text, done, at]);

  return showing;
}

/** A transient bubble over an NPC's head: the end of their current reasoning, or something they say. */
function ThoughtBubble({ text, speech, visible }: Thought & { visible: boolean }) {
  const shown = text.length > 120 ? `…${text.slice(-120)}` : text;

  return (
    <div className={`pointer-events-none relative w-56 transition-opacity duration-700 ${visible ? "opacity-100" : "opacity-0"}`}>
      {speech ? (
        <>
          <div className="w-fit rounded-[1.25rem] bg-white px-3 py-2 text-sm font-medium leading-snug text-neutral-900 shadow-lg">{shown}</div>
          <div className="absolute -bottom-1.5 left-4 size-3 rotate-45 bg-white" />
        </>
      ) : (
        <>
          <div className="rounded-[1.25rem] bg-white/90 px-3 py-2 text-xs italic leading-snug text-neutral-600 shadow-lg">{shown}</div>
          <div className="absolute -bottom-2 left-3 size-2.5 rounded-full bg-white/90 shadow" />
          <div className="absolute -bottom-4 left-1 size-1.5 rounded-full bg-white/90 shadow" />
        </>
      )}
    </div>
  );
}

function Cubicle({ x, z, npc, near, thought }: { x: number; z: number; npc: Npc; near: boolean; thought: Thought | null }) {
  const chair = seat({ x, z });
  const showing = useShowing(thought);

  return (
    <group>
      <Box size={[2.4, 0.75, 0.08]} color="#8c8f97" position={[x, 0.375, z - 1.2]} />
      <Box size={[0.08, 0.75, 1.6]} color="#8c8f97" position={[x - 1.2, 0.375, z - 0.4]} />
      <Model path="furniture/desk" position={[x, 0, z - 0.35]} scale={1.6} />
      <group position={[x - 0.15, 0.61, z - 0.55]} scale={1.1}>
        <Model path="furniture/televisionVintage" />
        {/* The CRT's screen face, in the model's centred coordinates. */}
        <mesh position={[-0.054, 0.135, 0.116]}>
          <planeGeometry args={[0.23, 0.2]} />
          <meshBasicMaterial map={screenTexture(npc.screen)} toneMapped={false} />
        </mesh>
      </group>
      <Model path="furniture/computerKeyboard" position={[x - 0.15, 0.61, z - 0.2]} scale={1.4} />
      <Model path="furniture/books" position={[x + 0.4, 0.61, z - 0.5]} scale={1.4} />
      <Swivel {...chair} npc={npc} />
      <Html position={[chair.x, 1.25, chair.z]} center zIndexRange={[10, 0]}>
        <div className="relative">
          {/* The name gives way to a bubble, and fades back in once the bubble has gone. */}
          <div className={`pointer-events-none whitespace-nowrap rounded-md bg-black/70 px-2 py-0.5 text-center text-xs font-medium text-white transition-opacity ${showing ? "opacity-0 duration-300" : "opacity-100 delay-700 duration-500"}`}>
            {npc.name}
            {npc.role && <div className="text-[10px] font-normal text-white/70">{npc.role}</div>}
            {near && <div className="text-[10px] font-normal text-yellow-300">Press E to talk</div>}
          </div>
          {/* The tail's tip sits on the label's anchor, right over the NPC's head. */}
          {thought && (
            <div className={`absolute bottom-1/2 left-1/2 ${thought.speech ? "-ml-[22px] mb-[9px]" : "-ml-[7px] mb-4"}`}>
              <ThoughtBubble {...thought} visible={showing} />
            </div>
          )}
        </div>
      </Html>
    </group>
  );
}

export function Office({ nearNpc, thought }: { nearNpc: string | null; thought: (Thought & { npc: string }) | null }) {
  const { width, depth } = ROOM;

  return (
    <group>
      <Box size={[width, 0.1, depth]} color="#5b6b7a" position={[width / 2, -0.05, depth / 2]} />
      <Box size={[width, WALL_HEIGHT, 0.15]} color="#e8dcc0" position={[width / 2, WALL_HEIGHT / 2, -0.075]} />
      <Box size={[0.15, WALL_HEIGHT, depth]} color="#ddd0b2" position={[-0.075, WALL_HEIGHT / 2, depth / 2]} />
      <Box size={[width, 0.12, 0.17]} color="#7a5c3e" position={[width / 2, 0.06, -0.06]} />
      <Box size={[0.17, 0.12, depth]} color="#7a5c3e" position={[-0.06, 0.06, depth / 2]} />
      <InnerWall length={width} color="#e8dcc0" position={[width / 2, 0, depth]} rotation={[0, Math.PI, 0]} />
      <InnerWall length={depth} color="#ddd0b2" position={[width, 0, depth / 2]} rotation={[0, -Math.PI / 2, 0]} />
      <Ceiling />

      {[2.5, 6, 9.5].map(x => (
        <Box key={x} size={[1.4, 0.6, 0.04]} color="#a9d3ef" position={[x, 0.85, 0.02]} />
      ))}

      {DESKS.map(desk => (
        <Cubicle key={desk.npc.name} {...desk} near={nearNpc === desk.npc.name} thought={thought?.npc === desk.npc.name ? thought : null} />
      ))}

      <Model path="furniture/kitchenCabinet" position={[10.6, 0, 0.5]} scale={1.6} />
      <Model path="furniture/kitchenCabinet" position={[11.4, 0, 0.5]} scale={1.6} />
      <Model path="furniture/kitchenCoffeeMachine" position={[10.6, 0.68, 0.45]} scale={1.6} />
      <Model path="furniture/radio" position={[11.4, 0.68, 0.45]} scale={1.6} />
      <Model path="furniture/pottedPlant" position={[9.4, 0, 0.5]} scale={1.8} />
      <Model path="furniture/bookcaseClosedWide" position={[0.45, 0, 9]} rotation={[0, Math.PI / 2, 0]} scale={1.6} />
      <Model path="furniture/plantSmall1" position={[0.4, 0, 0.4]} scale={2} />
      <Model path="furniture/coatRackStanding" position={[0.5, 0, 7.6]} scale={1.6} />
      <Model path="furniture/trashcan" position={[4.6, 0, 1.2]} scale={1.6} />
      <Model path="furniture/trashcan" position={[4.6, 0, 4.7]} scale={1.6} />
      <Model path="furniture/rugRectangle" position={[10, 0.01, 8.6]} scale={2.2} />
      <Model path="furniture/loungeSofa" position={[10, 0, 9.4]} rotation={[0, Math.PI, 0]} scale={1.6} />
      <Model path="furniture/tableCoffee" position={[10, 0, 8.3]} scale={1.6} />
      <Model path="furniture/lampSquareFloor" position={[11.5, 0, 9.5]} scale={1.6} />
      <Model path="furniture/cardboardBoxClosed" position={[8.6, 0, 0.4]} scale={1.6} />
      <Model path="furniture/cardboardBoxOpen" position={[8.4, 0, 1]} scale={1.6} />
    </group>
  );
}
