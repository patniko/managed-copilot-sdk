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

const HIDE: Readonly<Record<NonNullable<Column<unknown>["hideBelow"]>, string>> = {
  lg: "hidden lg:table-cell",
  xl: "hidden xl:table-cell",
  "2xl": "hidden 2xl:table-cell",
};

const INTERACTIVE = "a, button, input, select, textarea, summary, label, [role='button'], [data-row-ignore]";

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
    <div className={cx("min-w-0 overflow-x-auto", className)}>
      <table className={cx("w-full border-collapse text-left text-[13px] transition-opacity", dim && "opacity-55")} aria-label={label} aria-busy={dim || undefined}>
        <thead>
          <tr className="border-b border-zinc-800 text-[11px] uppercase tracking-[0.06em] text-zinc-500">
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                className={cx(
                  "px-3 py-2 font-medium whitespace-nowrap first:pl-4 last:pr-4",
                  column.align === "right" && "text-right",
                  column.hideBelow && HIDE[column.hideBelow],
                  column.headerClassName,
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const href = rowHref?.(row);
            return (
              <tr
                key={rowKey(row)}
                onClick={href ? (event) => onRowClick(event, href) : undefined}
                className={cx(
                  "border-b border-zinc-800/60 last:border-b-0",
                  href ? "cursor-pointer hover:bg-zinc-800/35" : "hover:bg-zinc-800/20",
                  rowClassName?.(row),
                )}
              >
                {columns.map((column) => (
                  <td
                    key={column.id}
                    className={cx(
                      "px-3 py-2.5 align-middle first:pl-4 last:pr-4",
                      column.align === "right" && "text-right tabular",
                      column.hideBelow && HIDE[column.hideBelow],
                      column.className,
                    )}
                  >
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
    <div className="p-4" role="status" aria-label="Loading">
      <div className="mb-4 flex gap-6">
        {Array.from({ length: columns }, (_, index) => (
          <div key={index} className="skeleton h-2.5 flex-1 rounded" aria-hidden />
        ))}
      </div>
      <div className="space-y-3.5">
        {Array.from({ length: rows }, (_, row) => (
          <div key={row} className="flex items-center gap-6">
            {Array.from({ length: columns }, (_, index) => (
              <div key={index} className={cx("skeleton h-3.5 flex-1 rounded", index === 0 && "max-w-28")} aria-hidden />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
