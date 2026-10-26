import type { MouseEvent, ReactNode } from "react";
import { cx } from "../../lib/cx.js";
import { navigate } from "../../lib/router.js";

export interface Column<T> {
  readonly id: string;
  readonly header: ReactNode;
  readonly cell: (row: T) => ReactNode;
  readonly className?: string;
  readonly headerClassName?: string;
  readonly align?: "left" | "right";
  /** Hide the column on narrower screens. */
  readonly hideBelow?: "lg" | "xl" | "2xl";
}

export interface DataTableProps<T> {
  /** Accessible name of the table. */
  readonly label: string;
  readonly rows: readonly T[];
  readonly columns: readonly Column<T>[];
  readonly rowKey: (row: T) => string;
  /** Clicking anywhere on a row opens this page (one cell must also hold a real link for keyboard users). */
  readonly rowHref?: (row: T) => string | undefined;
  readonly rowClassName?: (row: T) => string | undefined;
  /** Dim the rows (data from before the filters changed). */
  readonly dim?: boolean;
  readonly empty?: ReactNode;
  readonly className?: string;
}

/** Columns hide by the width the table actually has (a container query), not the viewport: the sidebar takes 256px. */
const HIDE: Readonly<Record<NonNullable<Column<unknown>["hideBelow"]>, string>> = {
  lg: "hidden @3xl:table-cell",
  xl: "hidden @4xl:table-cell",
  "2xl": "hidden @7xl:table-cell",
};

const INTERACTIVE = "a, button, input, select, textarea, summary, label, [role='button'], [data-row-ignore]";

/** A Primer data table (`Table`): muted 12px semibold headers, row hover, tabular numbers. Put it in a `Box`. */
export function DataTable<T>({ label, rows, columns, rowKey, rowHref, rowClassName, dim = false, empty, className }: DataTableProps<T>) {
  if (rows.length === 0 && empty) return <>{empty}</>;

  const onRowClick = (event: MouseEvent<HTMLTableRowElement>, href: string | undefined): void => {
    if (!href || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest(INTERACTIVE)) return;
    if (window.getSelection()?.toString()) return;
    if (event.metaKey || event.ctrlKey) {
      window.open(href, "_blank", "noopener");
      return;
    }
    navigate(href);
  };

  return (
    <div className={cx("@container relative min-w-0 overflow-x-auto", className)}>
      <table className={cx("Table transition-opacity duration-200", dim && "opacity-60")} aria-label={label} aria-busy={dim || undefined}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.id} scope="col" className={cx(column.align === "right" && "text-right", column.hideBelow && HIDE[column.hideBelow], column.headerClassName)}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const href = rowHref?.(row);
            return (
              <tr key={rowKey(row)} onClick={href ? (event) => onRowClick(event, href) : undefined} className={cx(href && "cursor-pointer", rowClassName?.(row))}>
                {columns.map((column) => (
                  <td key={column.id} className={cx(column.align === "right" && "text-right tabular-nums", column.hideBelow && HIDE[column.hideBelow], column.className)}>
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Placeholder rows while a table loads. */
export function TableSkeleton({ rows = 6, columns = 6 }: { readonly rows?: number; readonly columns?: number }) {
  return (
    <div role="status" aria-label="Loading">
      <div className="flex gap-6 border-b border-line bg-canvas-muted px-4 py-2.5">
        {Array.from({ length: columns }, (_, index) => (
          <span key={index} className="SkeletonText my-0 h-3 flex-1" aria-hidden />
        ))}
      </div>
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className={cx("flex items-center gap-6 px-4 py-3", row > 0 && "border-t border-line-muted")}>
          {Array.from({ length: columns }, (_, index) => (
            <span key={index} className={cx("SkeletonText my-0 flex-1", index === 0 && "max-w-28")} aria-hidden />
          ))}
        </div>
      ))}
    </div>
  );
}
