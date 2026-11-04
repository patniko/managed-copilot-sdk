// Owner: operator workstream. The operator control plane (spec section 16): the operator API under /v1/operator,
// console sign-in, the audit log, and the console itself at /console.
import { CONSOLE_PATH } from "@managed-copilot/protocol";
import type { GatewayModule } from "../../app.js";
import { OperatorAccess } from "./access.js";
import { OperatorAudit } from "./audit.js";
import { registerOperatorRoutes } from "./routes.js";
import { registerConsole } from "./static.js";
import { OperatorViews } from "./views.js";

export const operatorModule: GatewayModule = {
  name: "operator",
  register(app) {
    const log = app.log.child("operator");
    const access = new OperatorAccess({ app, log });
    const audit = new OperatorAudit(app.db, log);
    const views = new OperatorViews({ app, access });
    registerOperatorRoutes(app, { access, audit, views, log });
    const served = registerConsole(app, { log });
    if (access.enabled) app.capabilities.add("operator");

    app.onStart(() => {
      const url = `${app.config.publicUrl}${CONSOLE_PATH}`;
      if (!access.enabled) {
        log.info("The operator console is off", { reason: access.offReason });
        return;
      }
      log.info("Operator console ready; sign in with `npx managed-copilot console`", {
        url,
        operators: access.localDefault ? "every account that can use this local gateway" : [...access.rules.githubUsers.map((user) => `@${user}`), ...access.rules.githubOrgs.map((org) => `members of ${org}`)].join(", "),
        ...(served.built ? {} : { built: false }),
      });
    });
  },
};
