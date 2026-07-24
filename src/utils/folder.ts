export function isDirectChildFolder(parentFolder: string, candidateFolder: string): boolean {
  if (candidateFolder === "/" || candidateFolder === parentFolder) return false;

  if (parentFolder === "/") {
    return candidateFolder.split("/").filter(Boolean).length === 1;
  }

  if (!candidateFolder.startsWith(`${parentFolder}/`)) return false;
  const relative = candidateFolder.slice(parentFolder.length + 1);
  return relative.length > 0 && !relative.includes("/");
}

export function getFolderName(path: string): string {
  if (path === "/") return "My Drive";
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

export function getFolderItemCount(
  files: { folder: string }[],
  folders: string[],
  path: string
): number {
  const directFileCount = files.filter((f) => f.folder === path).length;
  const directFolderCount = folders.filter((candidate) =>
    isDirectChildFolder(path, candidate)
  ).length;
  return directFileCount + directFolderCount;
}

export function ancestorsOf(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const chain: string[] = [];
  let acc = "";
  for (const part of parts) {
    acc += "/" + part;
    chain.push(acc);
  }
  return chain;
}
