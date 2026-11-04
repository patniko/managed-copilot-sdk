import { QuestionIcon } from "@primer/octicons-react";
import { hrefs } from "../lib/routes.js";
import { Page } from "../components/layout/Page.js";
import { buttonClass } from "../components/ui/Button.js";
import { Code, EmptyState } from "../components/ui/Feedback.js";
import { Link } from "../components/ui/Link.js";

export function NotFoundView({ path }: { readonly path: string }) {
  return (
    <Page title="Page not found" documentTitle="Not found">
      <div className="Box">
        <EmptyState
          icon={QuestionIcon}
          title="This page doesn't exist"
          spacious
          action={
            <Link href={hrefs.overview()} className={buttonClass("primary")}>
              Go to the overview
            </Link>
          }
        >
          Nothing in the console lives at <Code className="break-all">{path}</Code>. Check the address, or pick a view from the sidebar.
        </EmptyState>
      </div>
    </Page>
  );
}
