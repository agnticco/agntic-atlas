/**
 * IngestionPipeline — incremental document indexing
 *
 * Designed for client deployments where documents are constantly added,
 * updated, or removed. Instead of re-indexing everything on each run,
 * the pipeline maintains a manifest that tracks which files have been
 * processed and their last-modified times.
 *
 * On each run:
 *   - NEW files    → chunked, embedded, added to VectorStore
 *   - CHANGED files → old chunks removed, re-chunked, re-embedded, re-added
 *   - DELETED files → chunks removed from VectorStore
 *   - UNCHANGED    → skipped entirely
 *
 * This makes subsequent runs fast — only the delta is processed.
 *
 * Usage:
 *   const pipeline = new IngestionPipeline({ vectorStore, embedModel, splitter });
 *   const report   = await pipeline.run('/path/to/docs');
 *   log.info(report); // { added, updated, deleted, unchanged, errors }
 *
 * @module src/rag/ingestion-pipeline.js
 */

import { promises as fs } from 'fs';
import path from 'path';
import { DocumentLoader }   from './document-loader.js';
import { DoclingProcessor } from './docling-processor.js';
import { TextSplitter }     from './text-splitter.js';
import { log }              from '../utils/logger.js';

const MANIFEST_FILE = 'ingestion-manifest.json';

export class IngestionPipeline {
  /**
   * @param {object} options
   * @param {object} options.vectorStore             - VectorStore instance (REQUIRED)
   * @param {object} options.embedModel              - EmbeddingModel instance (REQUIRED)
   * @param {object} [options.splitter]              - TextSplitter instance
   * @param {string} [options.manifestDir]           - Where to store the manifest (default: './memory/vectors')
   * @param {string[]} [options.extensions]          - File extensions to index
   * @param {number} [options.batchSize]             - Files per processing batch (default: 20)
   * @param {boolean} [options.verbose]              - Log progress per file (default: false)
   * @param {boolean|DoclingProcessor} [options.docling] - Enable Docling embed resolution + OCR.
   *   Pass true to auto-create a DoclingProcessor, or pass an existing instance.
   *   When enabled, ![[image.png]] and ![[file.pdf]] references inside .md files are
   *   resolved and their extracted text is inlined before chunking.
   *   Requires Python + docling installed: pip install docling
   * @param {string} [options.vaultRoot]             - Vault root for Obsidian embed lookup.
   *   Defaults to the directory passed to run(). Set explicitly if calling run() on a subdirectory.
   * @param {string[]} [options.categoryPatterns]    - Domain-specific filename patterns for vault summary categorization.
   *   Example (legal): ['franchise agreement', 'service agreement', 'license agreement']
   *   Example (medical): ['patient record', 'clinical trial', 'discharge summary']
   *   When empty, no categories are extracted (domain-agnostic default).
   */
  constructor(options = {}) {
    if (!options.vectorStore) throw new Error('IngestionPipeline requires a vectorStore');
    if (!options.embedModel)  throw new Error('IngestionPipeline requires an embedModel');

    this.vectorStore  = options.vectorStore;
    this.embedModel   = options.embedModel;
    this.splitter     = options.splitter ?? new TextSplitter({
      chunkSize:    parseInt(process.env.RAG_CHUNK_SIZE    ?? '800',  10),
      chunkOverlap: parseInt(process.env.RAG_CHUNK_OVERLAP ?? '150',  10),
    });
    this.manifestDir  = options.manifestDir ?? './memory/vectors';
    this.extensions   = options.extensions  ?? [
      '.md', '.txt', '.text', '.csv',
      // Rich formats extracted via Docling (requires DOCLING_ENABLED=true)
      '.pdf', '.docx', '.pptx', '.xlsx', '.epub',
      '.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp', '.gif', '.webp',
    ];
    this.batchSize    = options.batchSize   ?? 20;
    this.verbose      = options.verbose     ?? false;
    this.vaultRoot    = options.vaultRoot   ?? null;
    // Directory names (not full paths) to skip entirely during discovery.
    // Any path segment matching an entry here will be excluded.
    // e.g. ['agent-outputs', 'chat-history', 'templates']
    this.excludeDirs  = options.excludeDirs ?? [];

    // Domain-specific category patterns for vault summary (empty = agnostic)
    this._categoryPatterns = options.categoryPatterns ?? [];

    // Docling setup
    if (options.docling instanceof DoclingProcessor) {
      this._docling = options.docling;
    } else if (options.docling === true) {
      this._docling = new DoclingProcessor({ verbose: this.verbose });
    } else {
      this._docling = null;
    }

    // Loader is rebuilt at run() start when docling is active (needs vault index)
    this._loader = this._docling
      ? null  // deferred — built in run() once vaultRoot is known
      : new DocumentLoader({ extensions: this.extensions });
  }

  /**
   * Run incremental ingestion on a directory.
   * Only processes new and changed files.
   *
   * When docling is enabled, builds a vault file index once at start so that
   * ![[embed]] references can be resolved across the entire vault in O(1).
   * If the docling setting changed since the last run (on → off or vice versa),
   * all files are treated as changed and re-indexed automatically.
   *
   * @param {string} dirPath - Directory to ingest
   * @returns {Promise<IngestionReport>}
   */
  async run(dirPath) {
    const absDir   = path.resolve(dirPath);
    const manifest = await this._loadManifest();
    const report   = { added: 0, updated: 0, deleted: 0, unchanged: 0, errors: [] };

    // If docling setting changed, treat all files as new (force re-index)
    const doclingEnabled = !!this._docling;
    if ((manifest.doclingEnabled ?? false) !== doclingEnabled) {
      if (this.verbose) {
        log.info(`  [info] Docling setting changed — forcing full re-index`);
      }
      manifest.files = {};
    }
    manifest.doclingEnabled = doclingEnabled;

    // Build loader — for docling we defer until here so vaultRoot is known
    if (this._docling) {
      const root = this.vaultRoot ?? absDir;
      this._loader = new DocumentLoader({
        extensions: this.extensions,
        docling:    this._docling,
        vaultRoot:  root,
        verbose:    this.verbose,
      });
      // Pre-build vault index once for the entire run (O(n) walk, reused per file)
      const allFiles = await this._discoverAllFiles(absDir);
      this._loader._vaultIndex = await this._loader._buildVaultIndex(root, allFiles.map(f => f.filePath));
    }

    // Discover all matching files on disk
    const diskFiles = await this._discoverFiles(absDir);
    const diskPaths = new Set(diskFiles.map(f => f.filePath));

    // Detect deletions — files in manifest but not on disk
    for (const trackedPath of Object.keys(manifest.files)) {
      if (!diskPaths.has(trackedPath)) {
        const removed = await this.vectorStore.removeByMeta('filePath', trackedPath);
        delete manifest.files[trackedPath];
        report.deleted++;
        if (this.verbose) log.info(`  [deleted] ${path.basename(trackedPath)} (${removed} chunks removed)`);
      }
    }

    // Process new and changed files in batches
    const toProcess = diskFiles.filter(({ filePath, mtime }) => {
      const tracked = manifest.files[filePath];
      return !tracked || tracked.mtime !== mtime;
    });

    report.unchanged = diskFiles.length - toProcess.length;

    for (let i = 0; i < toProcess.length; i += this.batchSize) {
      const batch = toProcess.slice(i, i + this.batchSize);
      await this._processBatch(batch, manifest, report);
    }

    // Persist updated manifest and vector store
    await this._saveManifest(manifest);
    await this.vectorStore.persist();

    // Generate vault summary for conversational awareness
    await this._generateVaultSummary(manifest);

    // Run retrieval QA probes if a probes file exists
    const qa = await this.runQA();
    if (qa) {
      report.qa = qa;
      if (qa.failed > 0) {
        log.warn(`[ingest] ⚠ Retrieval QA: ${qa.passed}/${qa.total} passed, ${qa.failed} failed`);
        for (const f of qa.failures) {
          log.warn(`[ingest]   FAIL: "${f.query}" — expected "${f.expect}" not found (top score: ${f.topScore})`);
        }
      } else if (this.verbose) {
        log.info(`[ingest] ✓ Retrieval QA: ${qa.passed}/${qa.total} probes passed`);
      }
    }

    return report;
  }

  /**
   * Full re-index — wipes all existing vectors and re-processes everything.
   * Use when switching embedding models or doing a clean rebuild.
   *
   * @param {string} dirPath
   * @returns {Promise<IngestionReport>}
   */
  async runFull(dirPath) {
    await this.vectorStore.clear();
    await this._saveManifest({ files: {} });
    return this.run(dirPath);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  async _processBatch(files, manifest, report) {
    for (const { filePath, mtime } of files) {
      try {
        const isUpdate = !!manifest.files[filePath];

        // Remove stale chunks if this is an update
        if (isUpdate) {
          await this.vectorStore.removeByMeta('filePath', filePath);
        }

        // Load and chunk the file
        const docs   = await this._loader.invoke(filePath);
        const chunks = await this.splitter.invoke(docs);

        if (chunks.length === 0) {
          if (this.verbose) log.info(`  [skip] ${path.basename(filePath)} — no content`);
          return;
        }

        // Embed all chunks
        const texts      = chunks.map(c => c.pageContent);
        const embeddings = await this.embedModel.invoke(texts);

        // Add to vector store
        await this.vectorStore.add(chunks, embeddings);

        // Update manifest
        manifest.files[filePath] = { mtime, chunkCount: chunks.length };

        if (isUpdate) {
          report.updated++;
          if (this.verbose) log.info(`  [updated] ${path.basename(filePath)} (${chunks.length} chunks)`);
        } else {
          report.added++;
          if (this.verbose) log.info(`  [added] ${path.basename(filePath)} (${chunks.length} chunks)`);
        }

      } catch (err) {
        report.errors.push({ filePath, error: err.message });
        if (this.verbose) log.info(`  [error] ${path.basename(filePath)}: ${err.message}`);
      }
    }
  }

  /**
   * Discover files matching this.extensions (for ingestion).
   */
  async _discoverFiles(dirPath) {
    const entries = await fs.readdir(dirPath, { withFileTypes: true, recursive: true });
    const files   = [];

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!this.extensions.includes(ext)) continue;

      const filePath = path.join(entry.parentPath ?? entry.path ?? dirPath, entry.name);

      // Skip hidden files and directories (e.g. .obsidian, .git)
      if (filePath.split(path.sep).some(p => p.startsWith('.'))) continue;

      // Skip excluded directories
      if (this.excludeDirs.length > 0 &&
          filePath.split(path.sep).some(p => this.excludeDirs.includes(p))) continue;

      try {
        const stat = await fs.stat(filePath);
        files.push({ filePath, mtime: stat.mtimeMs });
      } catch {
        // skip unreadable files
      }
    }

    return files;
  }

  /**
   * Discover ALL files in the vault regardless of extension.
   * Used to build the vault index for Docling embed resolution —
   * images and PDFs need to be findable even though they aren't ingested directly.
   */
  async _discoverAllFiles(dirPath) {
    const entries = await fs.readdir(dirPath, { withFileTypes: true, recursive: true });
    const files   = [];

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = path.join(entry.parentPath ?? entry.path ?? dirPath, entry.name);
      if (filePath.split(path.sep).some(p => p.startsWith('.'))) continue;
      files.push({ filePath });
    }

    return files;
  }

  async _loadManifest() {
    await fs.mkdir(this.manifestDir, { recursive: true });
    const manifestPath = path.join(this.manifestDir, MANIFEST_FILE);
    try {
      const raw = await fs.readFile(manifestPath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return { files: {} };
    }
  }

  async _saveManifest(manifest) {
    await fs.mkdir(this.manifestDir, { recursive: true });
    const manifestPath = path.join(this.manifestDir, MANIFEST_FILE);
    manifest.lastRun = new Date().toISOString();
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  }

  // ── Vault Summary ──────────────────────────────────────────────────────────

  /**
   * Generate a lightweight vault summary for conversational awareness.
   * Stored as vault-summary.json alongside the manifest. The agent can
   * reference this when users ask exploratory questions like "what's in
   * my files?" without needing to search the vault.
   *
   * @private
   */
  async _generateVaultSummary(manifest) {
    const files = Object.keys(manifest.files ?? {});
    if (files.length === 0) return;

    // Count by file extension
    const byExt = {};
    for (const f of files) {
      const ext = f.includes('.') ? f.split('.').pop().toLowerCase() : 'unknown';
      byExt[ext] = (byExt[ext] ?? 0) + 1;
    }

    // Extract document categories from filenames.
    // Category patterns are injected via constructor (vertical-specific) or
    // auto-detected from filename structure (domain-agnostic fallback).
    const categories = {};
    const categoryPatterns = this._categoryPatterns ?? [];
    for (const f of files) {
      const lower = f.split('/').pop().toLowerCase();
      for (const pat of categoryPatterns) {
        if (lower.includes(pat)) {
          const label = pat.replace(/\b\w/g, c => c.toUpperCase());
          categories[label] = (categories[label] ?? 0) + 1;
          break;
        }
      }
    }

    // Build a compact natural-language summary
    const topCategories = Object.entries(categories)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    const categoryList = topCategories
      .map(([name, count]) => `${name} (${count})`)
      .join(', ');

    const summary = {
      totalFiles: files.length,
      totalVectors: this.vectorStore?.size ?? 0,
      fileTypes: byExt,
      categories,
      description:
        `The knowledge base contains ${files.length} documents with ${this.vectorStore?.size ?? 0} indexed chunks. ` +
        (topCategories.length > 0
          ? `Document categories include: ${categoryList}. `
          : '') +
        `File types: ${Object.entries(byExt).map(([e, c]) => `.${e} (${c})`).join(', ')}.`,
      generatedAt: new Date().toISOString(),
    };

    const summaryPath = path.join(this.manifestDir, 'vault-summary.json');
    await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
    if (this.verbose) log.info(`[ingest] ✓ Vault summary generated (${files.length} files, ${topCategories.length} categories)`);
  }

  // ── Retrieval QA ──────────────────────────────────────────────────────────

  /**
   * Run retrieval quality probes after ingestion to verify chunk coverage.
   *
   * Looks for a `retrieval-probes.json` file in the manifest directory.
   * Each probe is a query + expected substring that MUST appear in the
   * top-k retrieved chunks. No LLM calls — pure vector search + string match.
   *
   * Probe file format:
   * [
   *   { "query": "Hanover Direct governing law", "expect": "New York", "source": "optional filename hint" },
   *   { "query": "BorrowMoney.com parties", "expect": "JVLS" }
   * ]
   *
   * @param {number} [k=6] - Number of chunks to retrieve per probe
   * @returns {Promise<{ total, passed, failed, failures: Array }>}
   */
  async runQA(k = 6) {
    const probesPath = path.join(this.manifestDir, 'retrieval-probes.json');
    let probes;
    try {
      const raw = await fs.readFile(probesPath, 'utf-8');
      probes = JSON.parse(raw);
    } catch {
      return null; // No probes file — QA skipped
    }

    if (!Array.isArray(probes) || probes.length === 0) return null;

    const results = { total: probes.length, passed: 0, failed: 0, failures: [] };

    for (const probe of probes) {
      const { query, expect, source } = probe;
      if (!query || !expect) continue;

      try {
        const qVec = await this.embedModel.invoke(query);
        const hits = this.vectorStore.search(qVec, k);
        const combined = hits.map(h => (h.pageContent ?? h.text ?? '').toLowerCase()).join(' ');
        const found = combined.includes(expect.toLowerCase());

        if (found) {
          results.passed++;
        } else {
          results.failed++;
          const topScore = hits[0]?.score?.toFixed(3) ?? 'N/A';
          results.failures.push({
            query,
            expect,
            source: source ?? null,
            topScore,
            topChunkPreview: (hits[0]?.pageContent ?? hits[0]?.text ?? '').slice(0, 100),
          });
        }
      } catch (err) {
        results.failed++;
        results.failures.push({ query, expect, error: err.message });
      }
    }

    return results;
  }
}

/**
 * @typedef {object} IngestionReport
 * @property {number}   added     - New files indexed
 * @property {number}   updated   - Changed files re-indexed
 * @property {number}   deleted   - Removed files cleaned up
 * @property {number}   unchanged - Files skipped (no changes)
 * @property {object[]} errors    - [{ filePath, error }] for any failures
 */

export default IngestionPipeline;
