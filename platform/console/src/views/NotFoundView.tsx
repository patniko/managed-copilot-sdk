import { Compass } from "lucide-react";
import { hrefs } from "../lib/routes.js";
import { Page } from "../components/layout/Page.js";
import { buttonClass } from "../components/ui/Button.js";
import { EmptyState } from "../components/ui/Feedback.js";
import { Link } from "../components/ui/Link.js";

export function NotFoundView({ path }: { readonly path: string }) {
  return (
    <Page title="Page not found" documentTitle="Not found">
      <EmptyState
        icon={Compass}
        title="This page doesn't exist"
        action={
          <Link href={hrefs.overview()} className={buttonClass("primary", "md")}>
            Go to the overview
          </Link>
        }
      >
        Nothing in the console lives at <code className="font-mono break-all text-zinc-300">{path}</code>. Check the address, or pick a view from the sidebar.
      </EmptyState>
    </Page>
  );
}
