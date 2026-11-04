import type { BlueprintKind } from "../../shared/types.js";
import { KIND_ICON, KIND_LANE } from "../lib/blueprints.js";
import { cx } from "../lib/cx.js";

/** A blueprint's icon in its lane color, so a sandbox's kind is recognizable at a glance. */
export function BlueprintIcon({ kind, size = 16, className }: { readonly kind: BlueprintKind; readonly size?: number; readonly className?: string }) {
  const Glyph = KIND_ICON[kind];
  return (
    <span className={cx("inline-flex shrink-0", className)} style={{ color: KIND_LANE[kind] }} aria-hidden>
      <Glyph size={size} />
    </span>
  );
}
