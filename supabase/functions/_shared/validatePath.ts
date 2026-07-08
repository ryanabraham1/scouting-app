// Shared path validation for the read-only upstream proxies (tba/statbotics/nexus).
//
// Each proxy interpolates a caller-supplied `path` into `${BASE}${path}`. The
// functions are open (no auth), so we defend against path-traversal and
// protocol-relative host-escape attempts before attaching the server's API key:
//   - must start with a single "/" (not "//", which fetch could read as a host)
//   - no ".." segments (traversal to sibling/parent endpoints)
//   - no backslashes (URL-smuggling / alternate separators)
//   - no raw whitespace or control characters (chars <= 0x20 or 0x7f)
// Query strings (statbotics) are allowed; hyphens/underscores (event keys) are fine.
export function isSafeProxyPath(path: string | null): path is string {
  if (!path || !path.startsWith("/")) return false;
  if (path.startsWith("//")) return false;
  if (path.includes("..")) return false;
  if (path.includes("\\")) return false;
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return false; // control chars / whitespace
  }
  return true;
}
