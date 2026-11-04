import type { Icon } from "@primer/octicons-react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "../../lib/cx.js";
import { Spinner } from "./Spinner.js";

/** Primer button variants: one `primary` (green) per view, `danger` for destructive actions, `invisible` for toolbars. */
export type ButtonVariant = "primary" | "default" | "outline" | "invisible" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANTS: Readonly<Record<ButtonVariant, string>> = {
  primary: "btn-primary",
  default: "",
  outline: "btn-outline",
  invisible: "btn-invisible",
  danger: "btn-danger",
};

const SIZES: Readonly<Record<ButtonSize, string>> = { sm: "btn-sm", md: "", lg: "btn-lg" };

export function buttonClass(variant: ButtonVariant = "default", size: ButtonSize = "md", extra?: string): string {
  return cx("btn", VARIANTS[variant], SIZES[size], extra);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** Leading Octicon. */
  readonly icon?: Icon;
  readonly loading?: boolean;
  readonly children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size = "md", icon: LeadingIcon, loading = false, className, children, disabled, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={buttonClass(variant, size, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner /> : LeadingIcon ? <LeadingIcon size={16} /> : null}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly icon: Icon;
  /** Accessible name, also shown as the native tooltip. */
  readonly label: string;
  readonly size?: "sm" | "md";
  readonly variant?: "invisible" | "default";
  /** Spin the icon (a refresh in progress). */
  readonly spin?: boolean;
}

/** A square, icon-only Primer button (Primer React's IconButton). */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: ButtonIcon, label, size = "md", variant = "invisible", spin = false, className, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      aria-label={label}
      title={label}
      className={cx("btn btn-icon", variant === "invisible" && "btn-invisible", size === "sm" && "btn-sm", className)}
      {...rest}
    >
      <ButtonIcon size={16} className={spin ? "animate-spin" : undefined} />
    </button>
  );
});
