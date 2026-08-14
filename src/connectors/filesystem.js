/**
 * Filesystem connector — tenant-scoped read + list capabilities.
 *
 * Security model: every operation is sandboxed to the tenant's approved folders,
 * which are stored in sources.json (managed via the Filesystem / Knowledge page).
 * Only entries with an ABSOLUTE path are eligible for workflow file access — the check
 * is on the path, not on where the entry came from.
 *
 * ⚠️ THIS COMMENT USED TO SAY browser uploads "have no stable server path and are
 * RAG-only". THAT IS NO LONGER TRUE and it misled a reader on 2026-07-30 into telling
 * the operator, twice, that an uploaded document could never be used in a workflow.
 * `POST /rag/upload` (server.js) PERSISTS uploaded files under an app-managed folder and
 * records that ABSOLUTE path — its own comment says "so filesystem_read/list can reach
 * it and the converger treats it as a filesystem folder". So an uploaded document IS
 * readable by a workflow. The one exception is an upload where nothing was persisted
 * (image-only), which falls back to storing the folder NAME and therefore stays
 * RAG-only — which is what the line below actually filters on.
 *
 * _tenantId is stamped into node config by injectFilesystemContext() in server.js
 * before each run, mirroring the injectInboxContext() / injectTenantTokens() pattern.
 */

import { readFileSync, readdirSync, statSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve }                                                from 'node:path';

/**
 * Resolve a path for containment checking, following symlinks where possible.
 *
 * `resolve()` alone normalises `..` — which stops the obvious traversal — but it
 * does NOT follow symlinks, so a link sitting inside an approved folder and
 * pointing at `/etc` would pass a purely textual check and then be read through.
 * `realpathSync` collapses the link, so the comparison is against where the file
 * ACTUALLY is rather than where its name suggests.
 *
 * Falls back to the textual form when the path does not exist yet: a miss must be
 * decided by the containment check below (and then fail as "not found"), never by
 * throwing out of the guard, which would turn a typo into a crash.
 */
function realOrResolved(p) {
  const abs = resolve(p);
  try { return realpathSync(abs); } catch { return abs; }
}

function findApprovedRoot(approvedFolders, filePath) {
  const abs = realOrResolved(filePath);
  for (const entry of approvedFolders) {
    if (!entry.path || !entry.path.startsWith('/')) continue; // no absolute path ⇒ nothing was persisted (image-only upload)
    // The ROOT is resolved the same way, so an approved folder that is itself a
    // symlink (a common way to expose a synced drive) still matches its contents.
    const root = realOrResolved(entry.path);
    if (abs === root || abs.startsWith(root + '/')) return root;
  }
  return null;
}

export function registerFilesystemCapabilities(registry, { getApprovedFolders }) {
  function guard(tenantId, filePath) {
    if (!tenantId) throw new Error('filesystem: _tenantId not injected — is injectFilesystemContext() called before this run?');
    if (!filePath)  throw new Error('filesystem: `path` is required in node config');
    const folders = getApprovedFolders(tenantId);
    const root    = findApprovedRoot(folders, filePath);
    if (!root) {
      throw new Error(
        `filesystem: "${filePath}" is not within any approved folder for this tenant. ` +
        `Connect the folder first via the Filesystem page.`,
      );
    }
  }

  registry.register({
    id:          'filesystem_read',
    connector:   'atlas',
    name:        'Read file',
    description: 'Read a file from a tenant-approved folder and pass its content to the next step.',
    positions:   ['step'],
    configSchema: [
      { key: 'path', label: 'File path', type: 'text',
        hint: 'Absolute path to a file inside a connected folder.' },
    ],
    isReady: () => true,
    handle: async ({ config }) => {
      const filePath = config.path;
      guard(config._tenantId, filePath);
      if (!existsSync(filePath)) throw new Error(`filesystem_read: file not found: ${filePath}`);
      const st = statSync(filePath);
      if (st.isDirectory()) throw new Error(`filesystem_read: path is a directory: ${filePath}`);
      const content = readFileSync(filePath, 'utf8');
      return { path: filePath, content, bytes: content.length };
    },
  });

  registry.register({
    id:          'filesystem_list',
    connector:   'atlas',
    name:        'List folder',
    description: 'List files and subdirectories in a tenant-approved folder.',
    positions:   ['step'],
    configSchema: [
      { key: 'path', label: 'Folder path', type: 'text',
        hint: 'Absolute path to a connected folder or subfolder within it.' },
    ],
    isReady: () => true,
    handle: async ({ config }) => {
      const folderPath = config.path;
      guard(config._tenantId, folderPath);
      if (!existsSync(folderPath)) throw new Error(`filesystem_list: folder not found: ${folderPath}`);
      const st = statSync(folderPath);
      if (!st.isDirectory()) throw new Error(`filesystem_list: path is a file, not a folder: ${folderPath}`);
      const entries = readdirSync(folderPath, { withFileTypes: true }).map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
        path: join(folderPath, e.name),
      }));
      return { path: folderPath, count: entries.length, entries };
    },
  });
}

// Identifies filesystem capability node types for context injection.
export const FILESYSTEM_CAPABILITY_IDS = new Set(['filesystem_read', 'filesystem_list']);
