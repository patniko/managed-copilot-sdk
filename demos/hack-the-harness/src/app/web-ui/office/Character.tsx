import { forwardRef, useEffect, useMemo, type ReactNode } from "react";
import { useAnimations, useGLTF } from "@react-three/drei";
import { LoopOnce, LoopRepeat, type Group } from "three";
import { createPortal, type ThreeElements } from "@react-three/fiber";
import { clone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { modelUrl, shadows } from "./models";

export type CharacterName = "male-a" | "male-c" | "male-e" | "female-a" | "female-b" | "female-d";

type Props = ThreeElements["group"] & {
  model: CharacterName;
  animation: string;
  timeScale?: number;
  /** Something held in the right hand, which swings with the arm. */
  inHand?: ReactNode;
};

export const Character = forwardRef<Group, Props>(function Character({ model, animation, timeScale = 1, inHand, children, ...props }, ref) {
  const { scene, animations } = useGLTF(modelUrl(`characters/character-${model}`));
  const body = useMemo(() => shadows(clone(scene)), [scene]);
  const { actions } = useAnimations(animations, body);
  const arm = useMemo(() => body.getObjectByName("arm-right"), [body]);

  useEffect(() => {
    const action = actions[animation];

    if (!action) {
      return;
    }

    const once = animation === "pick-up" || animation.startsWith("emote") || animation.startsWith("interact");
    action.reset().setLoop(once ? LoopOnce : LoopRepeat, Infinity);
    action.clampWhenFinished = once;
    action.timeScale = timeScale;
    action.fadeIn(0.15).play();
    return () => void action.fadeOut(0.15);
  }, [actions, animation, timeScale]);

  return (
    <group ref={ref} {...props}>
      <primitive object={body} />
      {children}
      {arm && inHand && createPortal(inHand, arm)}
    </group>
  );
});
