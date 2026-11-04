import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from "react";
import { forwardRef } from "react";
import { isPlainLeftClick, navigate } from "../../lib/router.js";

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  readonly href: string;
  readonly replace?: boolean;
  readonly children?: ReactNode;
}

/** An anchor that navigates within the console without reloading (modifier clicks still open new tabs). */
export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link({ href, replace = false, onClick, target, children, ...rest }, ref) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    onClick?.(event);
    if (event.defaultPrevented || (target && target !== "_self") || !isPlainLeftClick(event)) return;
    event.preventDefault();
    navigate(href, { replace });
  };
  return (
    <a ref={ref} href={href} target={target} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
});
