# Security policy

Managed Copilot brokers GitHub identities, Copilot model access, and secrets for agents running in sandboxes, so we
take security reports seriously.

## Reporting a vulnerability

Please **do not** open a public issue. Report it privately through
[GitHub's private vulnerability reporting](https://github.com/patniko/managed-copilot-sdk/security/advisories/new)
for this repository, with:

- what an attacker can do, and under which configuration (local `aspire run` or an Azure deployment);
- steps to reproduce, or a proof of concept;
- the commit you tested.

We'll acknowledge the report, keep you updated while we investigate, and credit you in the fix unless you'd rather
stay anonymous.

## Scope

The [threat model](docs/threat-model.md) describes what the platform defends against and the limits it accepts. Reports
of particular interest: a GitHub token or vault secret reaching a sandbox, one user reading or acting on another
user's sessions, egress that bypasses an environment's network policy, and model calls billed to the wrong account.

This is a reference implementation, not a supported product. Run it in your own subscription at your own risk.
