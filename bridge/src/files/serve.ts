import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Largest file the phone may download. */
export const FILE_MAX_BYTES = 100 * 1024 * 1024;

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', json: 'application/json',
  csv: 'text/csv; charset=utf-8', zip: 'application/zip', log: 'text/plain; charset=utf-8',
};

export function mimeFor(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

/** A path as the terminal printed it → absolute: `/x`, `~/x`, or relative to the pane's cwd (null without one). */
export function resolveUserPath(p: string, cwd: string | null, home = os.homedir()): string | null {
  if (p.startsWith('/')) return path.normalize(p);
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return cwd ? path.join(cwd, p) : null;
}

const fail = (status: number, code: string) => Response.json({ code }, { status });

/**
 * Streams a regular file (symlinks followed) of at most FILE_MAX_BYTES.
 * Not restricted to a folder on purpose: a paired phone can already run any command in a pane, so reading a file
 * grants nothing new; the route stays behind the device token like every other.
 */
export async function serveFile(abs: string): Promise<Response> {
  let st;
  try {
    st = await stat(abs);
  } catch {
    return fail(404, 'not_found');
  }
  if (!st.isFile()) return fail(400, 'not_file');
  if (st.size > FILE_MAX_BYTES) return fail(413, 'too_large');
  const name = path.basename(abs);
  return new Response(Bun.file(abs), {
    headers: {
      'content-type': mimeFor(name),
      'content-length': String(st.size),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    },
  });
}
