const BUMPS = ["patch", "minor", "major"];

/**
 * The release a conventional commit message calls for: "major", "minor", "patch", or undefined when it doesn't
 * release anything (docs, chores, tests).
 */
export function releaseType(message) {
  const header = message.split("\n", 1)[0];
  const match = /^(\w+)(?:\([^)]*\))?(!)?:/.exec(header);
  if (!match) return undefined;
  const [, type, breaking] = match;
  if (breaking || /^BREAKING[ -]CHANGE:/m.test(message)) return "major";
  if (type === "feature") return "minor";
  if (type === "fix" || type === "perf") return "patch";
  return undefined;
}

/** `version` with one part bumped: "1.4.2" and "minor" give "1.5.0". */
export function bump(version, release) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new TypeError(`Not a version: ${version}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (release === "major") return `${major + 1}.0.0`;
  if (release === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** The version after `current` for these commit messages: the biggest bump wins, and no release keeps `current`. */
export function nextVersion(current, messages) {
  const bumps = messages.map(releaseType).filter(Boolean);
  if (bumps.length === 0) return current;
  const biggest = bumps.reduce((a, b) => (BUMPS.indexOf(b) > BUMPS.indexOf(a) ? b : a));
  return bump(current, biggest);
}
