/**
 * The network view's green side. The platform reports blocked requests, not allowed ones, so Repo Doctor infers which
 * allowed hosts were used from commands that succeeded: the URLs they name, and the registries installers use.
 */
import type { AllowedHost, HostRole } from "../shared/types.js";

/** The registries this sandbox's installers use, read from inside the sandbox. */
export interface Registries {
  readonly npm: readonly string[];
  readonly pip: readonly string[];
}

export const GITHUB_HOSTS: readonly string[] = ["github.com", "codeload.github.com", "objects.githubusercontent.com"];

/** pip's defaults when the sandbox names no index. */
export const PYPI_HOSTS: readonly string[] = ["pypi.org", "files.pythonhosted.org"];

const NPM_INSTALL = /(?:^|[\s;&|(])(?:(?:npm|pnpm|yarn)\s+(?:-\S+\s+)*(?:install|i|ci|add|update|up|upgrade|exec|x|dlx)\b|npx\s|yarn\s*(?:$|[;&|)]))/;
const PIP_INSTALL = /(?:^|[\s;&|(])(?:(?:pip3?|python3?\s+-m\s+pip)\s+(?:install|download|wheel)\b|uv\s+(?:pip\s+install|sync|add|lock|run)\b|poetry\s+(?:install|add|lock|update)\b|pipenv\s+(?:install|sync)\b)/;
/** Output that shows packages came down from the registry: an install with nothing to fetch doesn't count. */
const NPM_FETCHED = /\b(?:added|changed) \d+ packages?\b|\bdownloaded [1-9]\d*\b|\bSaved \d+ new dependenc|\bwill be installed\b/i;
const PIP_FETCHED = /\bDownloading\b|\bSuccessfully installed\b/;
const GIT_REMOTE = /(?:^|[\s;&|(])git\s+(?:-C\s+\S+\s+)?(?:clone|fetch|pull|ls-remote|submodule\s+update)\b/;
const URL_HOST = /\bhttps?:\/\/(?:[^\s/@'"]+@)?([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?/gi;
const SSH_HOST = /\bgit@([a-z0-9.-]+\.[a-z]{2,}):/gi;

/**
 * Hosts a `command` that exited 0 reached, as far as its text and `output` tell: the URLs it names, git's remote
 * (`gitRemote`, where the checkout's origin lives), and the registries installers fetched from.
 */
export function hostsReachedBy(command: string, output: string, registries: Registries, gitRemote?: string): string[] {
  const hosts = new Set<string>();
  for (const match of command.matchAll(URL_HOST)) hosts.add(match[1]!.toLowerCase());
  for (const match of command.matchAll(SSH_HOST)) hosts.add(match[1]!.toLowerCase());
  if (NPM_INSTALL.test(command) && NPM_FETCHED.test(output)) for (const host of registries.npm) hosts.add(host);
  if (PIP_INSTALL.test(command) && PIP_FETCHED.test(output)) for (const host of registries.pip) hosts.add(host);
  if (gitRemote && GIT_REMOTE.test(command) && !/\bhttps?:\/\/|git@/.test(command)) hosts.add(gitRemote);
  return [...hosts];
}

/** Whether `host` matches an allowlist entry: an exact name, or `*.example.com` for its subdomains only. */
export function matchesAllowed(host: string, entry: string): boolean {
  const name = host.toLowerCase();
  const pattern = entry.toLowerCase();
  return pattern.startsWith("*.") ? name.endsWith(pattern.slice(1)) && name.length > pattern.length - 1 : name === pattern;
}

/** The allowlist with what each host serves, before anything used it. */
export function describeAllowed(hosts: readonly string[], registries: Registries): AllowedHost[] {
  return hosts.map((host) => {
    const roles: HostRole[] = [];
    if (GITHUB_HOSTS.some((github) => matchesAllowed(github, host))) roles.push("github");
    if (registries.npm.some((npm) => matchesAllowed(npm, host))) roles.push("npm");
    if (registries.pip.some((pip) => matchesAllowed(pip, host))) roles.push("pip");
    return { host, roles: roles.length ? roles : ["other"] };
  });
}

/** Reads `npm config get registry` and `pip config get global.index-url` output (see REGISTRY_PROBE). */
export function parseRegistries(output: string): Registries {
  const value = (key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(output)?.[1]?.trim();
  const host = (url: string | undefined) => {
    if (!url) return undefined;
    try {
      return new URL(url).hostname.toLowerCase() || undefined;
    } catch {
      return undefined;
    }
  };
  const npm = host(value("npm"));
  const pip = host(value("pip"));
  return { npm: [npm ?? "registry.npmjs.org"], pip: pip ? [pip] : [...PYPI_HOSTS] };
}

/** Asks the sandbox which registries its installers use: the platform bakes them into the sandbox image. */
export const REGISTRY_PROBE = `printf 'npm=%s\\n' "$(npm config get registry 2>/dev/null)"; printf 'pip=%s\\n' "$(pip config get global.index-url 2>/dev/null)"`;

/** The Copilot runtime's own calls to GitHub's Copilot service; model calls go through the platform instead. */
export function isRuntimeHost(host: string): boolean {
  return /(?:^|\.)githubcopilot\.com$/i.test(host);
}
