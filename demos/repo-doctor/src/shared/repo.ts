/** Reading a GitHub repository from what a person pastes: a URL, `github.com/owner/repo`, or `owner/repo`. */

export interface GitHubRepo {
  readonly owner: string;
  readonly repo: string;
  /** A branch or tag, from a `/tree/<ref>` URL. */
  readonly ref?: string;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const REF = /^(?![-/.])(?!.*(?:\.\.|\/\/|@\{))[A-Za-z0-9._/+-]{1,200}(?<![/.])$/;

/** Parses a repository reference, or explains in plain words why it isn't one Repo Doctor can clone. */
export function parseRepoInput(input: string): GitHubRepo | { readonly error: string } {
  let text = input.trim();
  if (!text) return { error: "Paste a GitHub repository, like github.com/owner/repo." };
  const ssh = /^git@github\.com:(.+)$/i.exec(text);
  if (ssh) text = ssh[1]!;
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(?:www\.)?github\.com\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
      text = decodeURIComponent(url.pathname);
    } catch {
      return { error: "That isn't a URL Repo Doctor can read." };
    }
    if (!/^(?:www\.)?github\.com$/i.test(url.hostname) || (url.protocol !== "https:" && url.protocol !== "http:")) {
      return { error: "Repo Doctor clones public repositories from github.com." };
    }
  }
  const [owner, rawName, kind, ...rest] = text.replace(/^\/+|\/+$/g, "").split("/");
  const name = rawName?.replace(/\.git$/i, "");
  if (!owner || !name) return { error: "Include the owner and the repository, like owner/repo." };
  if (!OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") return { error: `"${owner}/${name}" isn't a valid GitHub repository name.` };
  if (kind === "tree" && rest.length > 0) {
    const ref = rest.join("/");
    if (!REF.test(ref)) return { error: `"${ref}" isn't a branch or tag name Repo Doctor can check out.` };
    return { owner, repo: name, ref };
  }
  return { owner, repo: name };
}

export function cloneUrl(repo: GitHubRepo): string {
  return `https://github.com/${repo.owner}/${repo.repo}.git`;
}

export function repoUrl(repo: GitHubRepo): string {
  return `https://github.com/${repo.owner}/${repo.repo}${repo.ref ? `/tree/${repo.ref}` : ""}`;
}
