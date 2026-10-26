import type { Icon } from "@primer/octicons-react";
import type { ButtonHTMLAttributes, ComponentPropsWithRef, ReactNode } from "react";
import { cx } from "../../lib/cx.js";
import { Spinner } from "./Spinner.js";
import { Tooltip } from "./Tooltip.js";

export type ButtonVariant = "default" | "primary" | "danger" | "outline" | "invisible";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANTS: Readonly<Record<ButtonVariant, string | undefined>> = {
  default: undefined,
  primary: "btn-primary",
  danger: "btn-danger",
  outline: "btn-outline",
  invisible: "btn-invisible",
};

const SIZES: Readonly<Record<ButtonSize, string | undefined>> = {
  sm: "btn-sm",
  md: undefined,
  lg: "btn-lg",
};

/** Primer button classes, for links and other elements that look like buttons. */
export function buttonClass(variant: ButtonVariant = "default", size: ButtonSize = "md", extra?: string): string {
  return cx("btn", VARIANTS[variant], SIZES[size], extra);
}

export interface ButtonProps extends ComponentPropsWithRef<"button"> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** Leading Octicon; replaced by a spinner while `loading`. */
  readonly icon?: Icon;
  readonly loading?: boolean;
  readonly children?: ReactNode;
}

export function Button({ variant, size = "md", icon: Leading, loading = false, className, children, disabled, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? "button"}
      className={buttonClass(variant, size, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={16} /> : Leading ? <Leading size={16} /> : null}
      {children}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly icon: Icon;
  /** Accessible name, also shown as a tooltip. */
  readonly label: string;
  readonly size?: "sm" | "md";
  readonly variant?: "default" | "invisible";
}

/** Square, icon-only button (Primer IconButton) with a tooltip. */
export function IconButton({ icon: Glyph, label, size = "md", variant = "invisible", className, type, ...rest }: IconButtonProps) {
  return (
    <Tooltip content={label}>
      <button type={type ?? "button"} aria-label={label} className={buttonClass(variant, size, cx("btn-icon", className))} {...rest}>
        <Glyph size={16} />
      </button>
    </Tooltip>
  );
}
