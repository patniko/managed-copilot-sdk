import type { CustomizationFileInfo } from "@managed-copilot/protocol/operator";

export interface FileTreeNode {
  readonly name: string;
  /** Bundle-relative POSIX path of the folder or file. */
  readonly path: string;
  readonly children: readonly FileTreeNode[];
  /** Set for files; folders have none. */
  readonly file?: CustomizationFileInfo;
}

interface MutableNode {
  name: string;
  path: string;
  children: Map<string, MutableNode>;
  file?: CustomizationFileInfo;
}

function freeze(node: MutableNode): FileTreeNode {
  const children = [...node.children.values()]
    .sort((a, b) => {
      const aFolder = a.file === undefined;
      const bFolder = b.file === undefined;
      if (aFolder !== bFolder) return aFolder ? -1 : 1;
      return a.name.localeCompare(b.name, "en");
    })
    .map(freeze);
  return node.file ? { name: node.name, path: node.path, children, file: node.file } : { name: node.name, path: node.path, children };
}

/** Folders first, then files, each alphabetically. Paths are POSIX; empty segments are ignored. */
export function buildFileTree(files: readonly CustomizationFileInfo[]): FileTreeNode[] {
  const root: MutableNode = { name: "", path: "", children: new Map() };
  for (const file of files) {
    const segments = file.path.split("/").filter(Boolean);
    let node = root;
    segments.forEach((segment, index) => {
      const path = segments.slice(0, index + 1).join("/");
      let child = node.children.get(segment);
      if (!child) {
        child = { name: segment, path, children: new Map() };
        node.children.set(segment, child);
      }
      if (index === segments.length - 1) child.file = file;
      node = child;
    });
  }
  return freeze(root).children.slice();
}

/** Folder paths that contain `path` (so the tree can expand to a selected file). */
export function ancestorFolders(path: string): string[] {
  const segments = path.split("/").filter(Boolean);
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"));
}
