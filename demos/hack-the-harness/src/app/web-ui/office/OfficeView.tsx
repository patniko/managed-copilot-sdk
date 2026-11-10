import { Suspense, useEffect, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrthographicCamera, PerspectiveCamera } from "@react-three/drei";
import { MathUtils, Vector3, type Group, type OrthographicCamera as OrthoCamera } from "three";
import { Eye, Loader2, LogOut, Map, Paperclip, Trash2, ZoomIn } from "lucide-react";
import { Character } from "./Character";
import { DESKS, OBSTACLES, Office, ROOM, TALK_DISTANCE, playerPosition, seat } from "./Office";
import { CarriedFiles, DeskFiles, FloorFiles, HeldFiles, FloorPicker, type DeskFile, type FloorFile, type ToFloor } from "./Files";
import { ChatPanel, currentThought, forgetNpc, forgottenLine, npcSession, type Sessions, type Thought } from "./Conversation";

const SPEED = 3.64;
/** The walk clip matches a speed of 2.6, so play it faster to keep the feet planted. */
const WALK_TIME_SCALE = SPEED / 2.6;
const CAMERA_OFFSET = new Vector3(10, 10, 10);
// Screen directions mapped onto the isometric floor.
const UP = new Vector3(-1, 0, -1).normalize();
const RIGHT = new Vector3(1, 0, -1).normalize();
const EYE_HEIGHT = 0.85;
const JUMP_SPEED = 3.6;
const GRAVITY = 14;
const TALK_ZOOM = 230;
/** How far from the NPC the player stands while talking, which the first-person shot is framed for. */
const TALK_STAND = 1.3;

function typing(event: KeyboardEvent) {
  return event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
}

export const VIEWS = [
  { name: "Isometric", zoom: 105, Icon: Map },
  { name: "Close", zoom: 190, Icon: ZoomIn },
  { name: "First person", zoom: 0, Icon: Eye },
] as const;
export type View = (typeof VIEWS)[number];

// Mouse-look angles for first person; yaw 0 looks along -z.
const look = { yaw: 0, pitch: 0 };

function useMouseLook(enabled: boolean) {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const onMove = (event: MouseEvent) => {
      if (!document.pointerLockElement) {
        return;
      }

      look.yaw -= event.movementX * 0.0025;
      look.pitch = Math.max(-1.4, Math.min(1.4, look.pitch - event.movementY * 0.0025));
    };

    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
      document.exitPointerLock?.();
    };
  }, [enabled]);
}

function useKeys() {
  const keys = useRef(new Set<string>());

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (typing(event)) return;
      if (event.key === " ") event.preventDefault();
      keys.current.add(event.key.toLowerCase());
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === " ") event.preventDefault();
      keys.current.delete(event.key.toLowerCase());
    };
    const clear = () => keys.current.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clear);
    };
  }, []);

  return keys;
}

function blocked(x: number, z: number, r = 0.2) {

  if (x < r || z < r || x > ROOM.width - r || z > ROOM.depth - r) {
    return true;
  }

  return OBSTACLES.some(([minX, minZ, maxX, maxZ]) => x + r > minX && x - r < maxX && z + r > minZ && z - r < maxZ);
}

/** The nearest spot to (x, z) where a dropped file can lie without ending up inside a wall or desk. */
function clearSpot(x: number, z: number) {
  for (let radius = 0; radius < 4; radius += 0.1) {
    for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 8) {
      const spot = { x: x + radius * Math.cos(angle), z: z + radius * Math.sin(angle) };
      if (!blocked(spot.x, spot.z, 0.3)) return spot;
    }
  }

  return { x, z };
}

// Keeps the camera on the player's side of any wall or partition between them.
function pullInFront(camera: Vector3, x: number, z: number) {
  const dx = camera.x - x;
  const dz = camera.z - z;

  for (let i = 1; i <= 20; i++) {
    if (blocked(x + (dx * i) / 20, z + (dz * i) / 20, 0.08)) {
      camera.x = x + (dx * (i - 1)) / 20;
      camera.z = z + (dz * (i - 1)) / 20;
      return;
    }
  }
}

function nearest(position: Vector3) {
  let best: { name: string; distance: number } | null = null;

  for (const desk of DESKS) {
    const { npc } = desk;
    const chair = seat(desk);
    const distance = Math.hypot(position.x - chair.x, position.z - chair.z);

    if (distance < TALK_DISTANCE && (!best || distance < best.distance)) {
      best = { name: npc.name, distance };
    }
  }

  return best?.name ?? null;
}

type PlayerProps = {
  onNear: (name: string | null) => void;
  firstPerson: boolean;
  zoom: number;
  /** Where the NPC being talked to sits, to frame the conversation. */
  talkTarget: { x: number; z: number } | null;
  carrying: File[];
};

function Player({ onNear, firstPerson, zoom, talkTarget, carrying }: PlayerProps) {
  const player = useRef<Group>(null);
  const keys = useKeys();
  const [moving, setMoving] = useState(false);
  const near = useRef<string | null>(null);
  const camera = useThree(state => state.camera);
  const size = useThree(state => state.size);
  const direction = new Vector3();
  const forward = new Vector3();
  const right = new Vector3();
  const fall = useRef(0);
  // 0 for the normal camera, 1 for the conversation shot, eased in between.
  const blend = useRef(0);
  const lastTarget = useRef({ x: 0, z: 0 });
  const normalPosition = new Vector3();
  const normalFocus = new Vector3();
  const talkPosition = new Vector3();
  const talkFocus = new Vector3();

  useEffect(() => {
    if (firstPerson && player.current) {
      look.yaw = player.current.rotation.y - Math.PI;
      look.pitch = 0;
    }
  }, [firstPerson]);

  useFrame((_, delta) => {
    const body = player.current;

    if (!body) {
      return;
    }

    // While talking the player is walked into place, so movement keys are ignored.
    const pressed = talkTarget ? new Set<string>() : keys.current;
    if (firstPerson) {
      forward.set(-Math.sin(look.yaw), 0, -Math.cos(look.yaw));
      right.set(Math.cos(look.yaw), 0, -Math.sin(look.yaw));
    } else {
      forward.copy(UP);
      right.copy(RIGHT);
    }

    direction.set(0, 0, 0);
    if (pressed.has("w") || pressed.has("arrowup")) direction.add(forward);
    if (pressed.has("s") || pressed.has("arrowdown")) direction.sub(forward);
    if (pressed.has("d") || pressed.has("arrowright")) direction.add(right);
    if (pressed.has("a") || pressed.has("arrowleft")) direction.sub(right);

    const grounded = body.position.y <= 0;

    if (pressed.has(" ") && grounded) {
      fall.current = JUMP_SPEED;
    }

    if (!grounded || fall.current > 0) {
      fall.current -= GRAVITY * Math.min(delta, 0.05);
      body.position.y = Math.max(0, body.position.y + fall.current * Math.min(delta, 0.05));
      if (body.position.y === 0) fall.current = 0;
    }

    // Step straight towards or away from the NPC to the talking distance.
    if (talkTarget) {
      const dx = body.position.x - talkTarget.x;
      const dz = body.position.z - talkTarget.z;
      const distance = Math.hypot(dx, dz);
      const step = (TALK_STAND - distance) * Math.min(1, delta * 4);
      if (Math.abs(TALK_STAND - distance) > 0.02 && distance > 0) {
        direction.set((dx / distance) * step, 0, (dz / distance) * step);
      }
    }

    const { x: startX, z: startZ } = body.position;

    if (direction.lengthSq() > 0) {
      if (!talkTarget) direction.normalize().multiplyScalar(SPEED * Math.min(delta, 0.05));
      const { x, z } = body.position;

      if (!blocked(x + direction.x, z)) body.position.x += direction.x;
      if (!blocked(body.position.x, z + direction.z)) body.position.z += direction.z;

      if (!firstPerson && !talkTarget) {
        const target = Math.atan2(direction.x, direction.z);
        const turn = Math.atan2(Math.sin(target - body.rotation.y), Math.cos(target - body.rotation.y));
        body.rotation.y += turn * Math.min(1, delta * 14);
      }
    }

    // Animate only while actually covering ground, not while easing in or pushing against a wall.
    const isMoving = Math.hypot(body.position.x - startX, body.position.z - startZ) > 0.3 * Math.min(delta, 0.05);

    if (isMoving !== moving) {
      setMoving(isMoving);
    }

    playerPosition.x = body.position.x;
    playerPosition.z = body.position.z;

    if (talkTarget) lastTarget.current = talkTarget;
    blend.current += ((talkTarget ? 1 : 0) - blend.current) * Math.min(1, delta * 4);
    const t = MathUtils.smoothstep(blend.current, 0, 1);
    const npc = lastTarget.current;
    const { x, y, z } = body.position;

    if (talkTarget) {
      body.rotation.y = Math.atan2(npc.x - x, npc.z - z);
      // Face the NPC when first person resumes.
      look.yaw = Math.atan2(x - npc.x, z - npc.z);
      look.pitch = -0.15;
    }

    if (firstPerson) {
      if (!talkTarget) body.rotation.y = look.yaw + Math.PI;
      normalPosition.set(x, y + EYE_HEIGHT, z);
      normalFocus.set(-Math.sin(look.yaw) * Math.cos(look.pitch), Math.sin(look.pitch), -Math.cos(look.yaw) * Math.cos(look.pitch)).add(normalPosition);
      // Over the shoulder, looking past the player to the NPC.
      forward.set(npc.x - x, 0, npc.z - z).normalize();
      right.set(-forward.z, 0, forward.x);
      // Low behind the player's right shoulder, so the NPC sits up and right of their head.
      talkPosition.set(x, y + 0.5, z).addScaledVector(forward, -0.68).addScaledVector(right, 0.65);
      talkFocus.copy(talkPosition).addScaledVector(forward, 0.86).addScaledVector(right, -0.5).setY(talkPosition.y - 0.09);
      pullInFront(talkPosition, x, z);
    } else {
      normalFocus.set(x, 0, z);
      talkFocus.set((x + npc.x) / 2, 0.5, (z + npc.z) / 2);
      normalPosition.copy(normalFocus).add(CAMERA_OFFSET);
      talkPosition.copy(talkFocus).add(CAMERA_OFFSET);
      const ortho = camera as OrthoCamera;
      const targetZoom = MathUtils.lerp(zoom, Math.max(zoom, TALK_ZOOM), t);
      if (Math.abs(ortho.zoom - targetZoom) > 0.01) {
        ortho.zoom = targetZoom;
        ortho.updateProjectionMatrix();
      }
    }

    body.visible = !firstPerson || t > 0.3;
    camera.position.lerpVectors(normalPosition, talkPosition, t);
    camera.lookAt(normalFocus.lerp(talkFocus, t));

    // Shift the picture left so the characters sit in the left half, beside the chat panel.
    if (t > 0.001) {
      camera.setViewOffset(size.width, size.height, size.width * 0.25 * t, 0, size.width, size.height);
    } else if (camera.view?.enabled) {
      camera.clearViewOffset();
    }

    const current = nearest(body.position);

    if (current !== near.current) {
      near.current = current;
      onNear(current);
    }
  });

  return (
    <>
      <Character ref={player} model="male-a" animation={moving ? "walk" : "idle"} timeScale={moving ? WALK_TIME_SCALE : 1} position={[5, 0, 8.5]} rotation={[0, Math.PI, 0]} inHand={carrying.length > 0 && <CarriedFiles files={carrying} />} />
      {firstPerson && !talkTarget && carrying.length > 0 && <HeldFiles files={carrying} moving={moving} />}
    </>
  );
}

export default function OfficeView({ onExit, data }: { onExit: () => void; data: Sessions }) {
  const [viewIndex, setViewIndex] = useState(0);
  const view: View = VIEWS[viewIndex];
  const firstPerson = view.name === "First person";
  useMouseLook(firstPerson);
  const [nearNpc, setNearNpc] = useState<string | null>(null);
  const [talkingTo, setTalkingTo] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [talkError, setTalkError] = useState<string | null>(null);
  const desk = DESKS.find(desk => desk.npc.name === talkingTo);
  const talkTarget = desk ? seat(desk) : null;
  const thought = talkingTo && sessionId ? currentThought(data.events[sessionId] ?? []) : null;
  // What an NPC says after their conversation is deleted.
  const [remark, setRemark] = useState<(Thought & { npc: string }) | null>(null);
  const [forgetting, setForgetting] = useState(false);
  // Files dropped onto the floor, and the ones the player has picked up to attach to their next message.
  const [floorFiles, setFloorFiles] = useState<FloorFile[]>([]);
  const [carrying, setCarrying] = useState<File[]>([]);
  const picker = useRef<ToFloor | null>(null);
  const nextFileId = useRef(0);

  function dropFiles(event: React.DragEvent) {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files);
    // If the drop point isn't on the floor (looking up in first person), drop them in front of the player.
    const point = picker.current?.(event.clientX, event.clientY) ?? { x: playerPosition.x, z: playerPosition.z - 1 };
    setFloorFiles(current => [...current, ...files.map((file, index) => ({ id: nextFileId.current++, file, ...clearSpot(point.x + index * 0.5, point.z) }))]);
  }

  // Sent files fly onto the NPC's desk, stacking up beside the keyboard.
  const [deskFiles, setDeskFiles] = useState<DeskFile[]>([]);
  function giveFiles(sent: File[]) {
    setCarrying(current => current.filter(file => !sent.includes(file)));
    const from = { x: playerPosition.x, z: playerPosition.z };
    setDeskFiles(current => {
      const already = current.filter(item => item.to.x === desk!.x + 0.35 && item.to.z === desk!.z - 0.2).length;
      return [...current, ...sent.map((file, index) => ({
        id: nextFileId.current++, file, from,
        to: { x: desk!.x + 0.35, y: 0.63 + (already + index) * 0.04, z: desk!.z - 0.2 },
      }))];
    });
  }

  function pickUp(item: FloorFile) {
    setFloorFiles(current => current.filter(other => other !== item));
    setCarrying(current => [...current, item.file]);
  }

  async function forget() {
    const npc = talkingTo!;
    setForgetting(true);
    try {
      await forgetNpc(npc, sessionId!, data);
      setTalkingTo(null);
      setRemark({ npc, text: forgottenLine(), done: true, speech: true, at: Date.now() });
    } catch (error) {
      setTalkError((error as Error).message);
    } finally {
      setForgetting(false);
    }
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (typing(event)) {
        return;
      }

      if (event.key.toLowerCase() === "e" && nearNpc && !talkingTo) {
        // Don't let the E land in the input that's about to take focus.
        event.preventDefault();
        document.exitPointerLock?.();
        setTalkingTo(nearNpc);
        setRemark(null);
        setSessionId(null);
        setTalkError(null);
        npcSession(nearNpc, data)
          .then(id => {
            setSessionId(id);
            return data.open(id);
          })
          .catch(error => setTalkError((error as Error).message));
      }

      if (event.key === "Escape") {
        setTalkingTo(null);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nearNpc, talkingTo, data]);

  useEffect(() => {
    if (!nearNpc) {
      setTalkingTo(null);
    }
  }, [nearNpc]);

  return (
    <div className="fixed inset-0 z-50 bg-[#1d2430]" onDragOver={event => event.preventDefault()} onDrop={dropFiles}>
      <Canvas
        shadows
        dpr={[1, 2]}
        onClick={event => firstPerson && (event.currentTarget as HTMLElement).requestPointerLock()}
      >
        {firstPerson ? (
          <PerspectiveCamera makeDefault fov={55} near={0.05} far={100} />
        ) : (
          <OrthographicCamera key={view.name} makeDefault zoom={view.zoom} near={0.1} far={100} />
        )}
        <FloorPicker picker={picker} />
        <color attach="background" args={["#1d2430"]} />
        <hemisphereLight args={["#fff6e5", "#3a4250", 1.4]} />
        <directionalLight
          castShadow
          position={[14, 18, 8]}
          intensity={1.8}
          shadow-mapSize={[2048, 2048]}
          shadow-camera-left={-12}
          shadow-camera-right={12}
          shadow-camera-top={12}
          shadow-camera-bottom={-12}
          shadow-bias={-0.0005}
          target-position={[6, 0, 5]}
        />
        <Suspense fallback={null}>
          <Office nearNpc={talkingTo ? null : nearNpc} thought={thought ? { ...thought, npc: talkingTo! } : remark} />
          <FloorFiles files={floorFiles} onPickUp={pickUp} />
          <DeskFiles files={deskFiles} />
          <Player onNear={setNearNpc} firstPerson={firstPerson} zoom={view.zoom} talkTarget={talkTarget} carrying={carrying} />
        </Suspense>
      </Canvas>

      <div className="absolute right-4 top-4 z-20 flex gap-2">
        <div className="flex rounded-lg bg-black/60 p-1">
          {VIEWS.map(({ name, Icon }, index) => (
            <button
              key={name}
              type="button"
              title={name}
              aria-label={name}
              aria-pressed={index === viewIndex}
              className={`rounded-md p-1.5 text-white ${index === viewIndex ? "bg-white/25" : "opacity-70 hover:bg-white/10 hover:opacity-100"}`}
              onClick={() => setViewIndex(index)}
            >
              <Icon className="size-4" />
            </button>
          ))}
        </div>
        <button
          type="button"
          title="Leave office"
          aria-label="Leave office"
          className="rounded-lg bg-black/60 p-2.5 text-white hover:bg-black/80"
          onClick={onExit}
        >
          <LogOut className="size-4" />
        </button>
      </div>

      {!talkingTo && carrying.length > 0 && (
        <div className="pointer-events-none absolute left-4 top-4 z-20 flex flex-col items-start gap-1">
          {carrying.map((file, index) => (
            <div key={index} className="flex items-center gap-1.5 rounded-lg bg-black/60 px-3 py-1.5 text-xs text-white">
              <Paperclip className="size-3.5" /> {file.name}
            </div>
          ))}
          <div className="px-1 text-[10px] text-white [text-shadow:0_1px_3px_black]">Attached to your next message</div>
        </div>
      )}

      {!talkingTo && (
        <div className="pointer-events-none absolute bottom-4 left-4 z-20 rounded-lg bg-black/60 px-3 py-2 text-xs text-white">
          WASD to move · Drag in files
        </div>
      )}


      {/* Overlays use z-20 to sit above the drei Html name labels (z-index up to 10). */}
      {talkingTo && (
        <ChatPanel npc={desk!.npc} data={data} sessionId={sessionId} error={talkError} onEnd={() => setTalkingTo(null)}
          carrying={carrying} onSent={giveFiles} />
      )}
      {talkingTo && sessionId && (
        <button
          type="button"
          disabled={forgetting}
          className="absolute bottom-4 left-4 z-20 flex items-center gap-2 rounded-lg bg-black/60 px-3 py-2 text-xs text-white hover:bg-black/80 disabled:opacity-60"
          onClick={() => void forget()}
        >
          {forgetting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />} Delete conversation
        </button>
      )}
    </div>
  );
}
