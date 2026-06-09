/**
 * VaultWatcher — file system watcher that auto-triggers RAG ingestion
 *
 * Watches a directory for file changes and automatically runs the
 * IngestionPipeline when new or modified files are detected.
 *
 * Key behaviours:
 *   - Uses chokidar for cross-platform watching (macOS FSEvents, Linux inotify)
 *   - Debounces rapid changes — waits until file activity settles before ingesting
 *     (handles sync tools like Obsidian Sync, Dropbox, iCloud that write many files at once)
 *   - Optional startup ingest — catches any changes that happened while the watcher was offline
 *   - Ignores hidden files and directories (.obsidian, .git, .trash)
 *   - Emits events so the API server or other processes can react to ingestion results
 *
 * Designed to run as a long-lived process alongside the API server.
 * Managed by PM2 in production:
 *   pm2 start examples/watch-vault.js --name "vault-watcher"
 *
 * @module src/rag/vault-watcher.js
 */

import { EventEmitter } from 'events';
import path from 'path';
import chokidar from 'chokidar';
import { log } from '../utils/logger.js';

export class VaultWatcher extends EventEmitter {
  /**
   * @param {object} options
   * @param {object} options.pipeline          - IngestionPipeline instance (REQUIRED)
   * @param {string} options.watchPath         - Directory to watch (REQUIRED)
   * @param {number} [options.debounceMs=2000] - Ms to wait after last change before ingesting
   *                                             Increase for slow sync tools (Dropbox: try 5000)
   * @param {boolean} [options.ingestOnStart=true] - Run incremental sync at startup to catch
   *                                                 changes that occurred while offline
   * @param {string[]} [options.extensions]    - File extensions to watch (default: .md .txt .text)
   * @param {boolean} [options.verbose=false]  - Log each file event
   */
  constructor(options = {}) {
    super();

    if (!options.pipeline)  throw new Error('VaultWatcher requires a pipeline option');
    if (!options.watchPath) throw new Error('VaultWatcher requires a watchPath option');

    this.pipeline      = options.pipeline;
    this.watchPath     = path.resolve(options.watchPath);
    this.debounceMs    = options.debounceMs    ?? parseInt(process.env.WATCHER_DEBOUNCE_MS ?? '2000', 10);
    this.ingestOnStart = options.ingestOnStart ?? process.env.WATCHER_INGEST_ON_START !== 'false';
    this.extensions    = options.extensions    ?? ['.md', '.txt', '.text'];
    this.verbose       = options.verbose       ?? (process.env.VERBOSE === 'true');

    this._watcher      = null;
    this._debounceTimer = null;
    this._pendingCount  = 0;
    this._isIngesting   = false;
    this._running       = false;
  }

  /**
   * Start watching. Optionally runs an initial incremental ingest first.
   * @returns {Promise<void>} resolves after startup ingest completes (if enabled)
   */
  async start() {
    if (this._running) return;
    this._running = true;

    this.emit('start', { watchPath: this.watchPath });
    log.info(`[VaultWatcher] Watching: ${this.watchPath}`);
    log.info(`[VaultWatcher] Debounce: ${this.debounceMs}ms | Startup ingest: ${this.ingestOnStart}`);

    // Catch up on changes that happened while we were offline
    if (this.ingestOnStart) {
      log.info('[VaultWatcher] Running startup ingest...');
      await this._runIngestion('startup');
    }

    // Start the file watcher
    this._watcher = chokidar.watch(this.watchPath, {
      // Ignore hidden files and directories
      ignored: /(^|[/\\])\./,
      persistent:    true,
      ignoreInitial: true,    // don't fire events for files already there at startup
      // Wait for write to finish before triggering (handles editors that do atomic saves)
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval:       100,
      },
    });

    this._watcher
      .on('add',    filePath => this._onFileEvent(filePath, 'add'))
      .on('change', filePath => this._onFileEvent(filePath, 'change'))
      .on('unlink', filePath => this._onFileEvent(filePath, 'delete'))
      .on('error',  error    => {
        log.error(`[VaultWatcher] Error: ${error.message}`);
        this.emit('error', error);
      });

    log.info('[VaultWatcher] Ready — watching for changes');
    this.emit('ready', { watchPath: this.watchPath });
  }

  /**
   * Stop watching and clean up.
   */
  async stop() {
    this._running = false;
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    if (this._watcher) await this._watcher.close();
    this._watcher = null;
    log.info('[VaultWatcher] Stopped');
    this.emit('stop');
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _onFileEvent(filePath, event) {
    const ext = path.extname(filePath).toLowerCase();
    if (!this.extensions.includes(ext)) return;

    this._pendingCount++;

    if (this.verbose) {
      log.info(`[VaultWatcher] ${event}: ${path.relative(this.watchPath, filePath)}`);
    }

    this.emit('change', { filePath, event });

    // Reset debounce — we want to wait until file activity fully settles
    clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      const count = this._pendingCount;
      this._pendingCount = 0;
      this._runIngestion('watch', count);
    }, this.debounceMs);
  }

  async _runIngestion(trigger, changedCount = 0) {
    // Don't stack ingestion runs — if one is already in progress, skip
    if (this._isIngesting) {
      if (this.verbose) log.info('[VaultWatcher] Ingestion already running, skipping');
      return;
    }

    this._isIngesting = true;

    if (trigger === 'watch') {
      log.info(`[VaultWatcher] ${changedCount} change(s) detected — running ingestion...`);
    }

    const startTime = Date.now();

    try {
      const report  = await this.pipeline.run(this.watchPath);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const summary = `+${report.added} ~${report.updated} -${report.deleted} =${report.unchanged}`;

      log.info(`[VaultWatcher] Ingestion complete (${elapsed}s): ${summary}`);

      if (report.errors.length > 0) {
        log.warn(`[VaultWatcher] ${report.errors.length} error(s):`);
        report.errors.forEach(e =>
          log.warn(`  - ${path.basename(e.filePath)}: ${e.error}`)
        );
      }

      this.emit('ingested', { trigger, report, elapsed: parseFloat(elapsed) });

    } catch (err) {
      log.error(`[VaultWatcher] Ingestion failed: ${err.message}`);
      this.emit('error', err);
    } finally {
      this._isIngesting = false;
    }
  }
}

export default VaultWatcher;
