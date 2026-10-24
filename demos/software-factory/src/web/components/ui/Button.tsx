import type { LucideIcon } from "lucide-react";
import { LoaderCircle } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-solid";
export type ButtonSize = "xs" | "sm" | "md" | "lg";

const VARIANTS: Readonly<Record<ButtonVariant, string>> = {
  primary:
    "bg-amber-500 font-semibold text-zinc-950 shadow-sm shadow-amber-500/20 hover:bg-amber-400 active:bg-amber-500 disabled:bg-amber-500/40 disabled:text-zinc-950/70 disabled:shadow-none",
  secondary:
    "bg-zinc-800/80 font-medium text-zinc-100 ring-1 ring-inset ring-white/10 hover:bg-zinc-700/80 hover:ring-white/15 disabled:hover:bg-zinc-800/80",
  ghost: "font-medium text-zinc-300 hover:bg-zinc-800/70 hover:text-zinc-100 disabled:hover:bg-transparent",
  danger:
    "bg-rose-500/10 font-medium text-rose-300 ring-1 ring-inset ring-rose-400/30 hover:bg-rose-500/20 hover:text-rose-200 disabled:hover:bg-rose-500/10",
  "danger-solid": "bg-rose-600 font-semibold text-white shadow-sm shadow-rose-900/30 hover:bg-rose-500 disabled:hover:bg-rose-600",
};

const SIZES: Readonly<Record<ButtonSize, string>> = {
  xs: "h-6 gap-1 rounded-md px-2 text-[11px]",
  sm: "h-7 gap-1.5 rounded-md px-2.5 text-xs",
  md: "h-8 gap-2 rounded-lg px-3 text-[13px]",
  lg: "h-10 gap-2 rounded-lg px-4 text-sm",
};

const ICON_SIZES: Readonly<Record<ButtonSize, string>> = {
  xs: "size-3",
  sm: "size-3.5",
  md: "size-4",
  lg: "size-4",
};

export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", extra?: string): string {
  return cx(
    "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60",
    VARIANTS[variant],
    SIZES[size],
    extra,
  );
}

export function buttonIconClass(size: ButtonSize = "md"): string {
  return cx("shrink-0", ICON_SIZES[size]);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly icon?: LucideIcon;
  readonly loading?: boolean;
  readonly children?: ReactNode;
}

export function Button({ variant, size = "md", icon: Icon, loading = false, className, children, disabled, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? "button"}
      className={buttonClass(variant, size, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <LoaderCircle className={cx(buttonIconClass(size), "animate-spin")} aria-hidden />
      ) : Icon ? (
        <Icon className={buttonIconClass(size)} aria-hidden />
      ) : null}
      {children}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly size?: "sm" | "md";
}

export function IconButton({ icon: Icon, label, size = "md", className, type, ...rest }: IconButtonProps) {
  return (
    <button
      type={type ?? "button"}
      aria-label={label}
      title={label}
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "size-6" : "size-8",
        className,
      )}
      {...rest}
    >
      <Icon className={size === "sm" ? "size-3.5" : "size-4"} aria-hidden />
    </button>
  );
}
