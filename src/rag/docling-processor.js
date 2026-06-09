/**
 * DoclingProcessor — extract text from rich documents via Docling (Python)
 *
 * Calls `scripts/docling_extract.py` as a subprocess for each file.
 * Handles images (OCR), PDFs, DOCX, PPTX, and other rich formats that
 * the plain DocumentLoader cannot read.
 *
 * Results are cached in memory so repeated calls (e.g. multiple markdown
 * files referencing the same image) only run Docling once per session.
 *
 * Supported input types:
 *   Images: .png  .jpg  .jpeg  .tiff  .bmp  .gif  .webp
 *   Docs:   .pdf  .docx .pptx  .xlsx  .html
 *
 * Usage:
 *   const processor = new DoclingProcessor();
 *   const text = await processor.extract('/path/to/screenshot.png');
 *   // Returns extracted text string, or null on failure
 *
 * @module src/rag/docling-processor.js
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from '../utils/logger.js';

const execFileAsync = promisify(execFile);
const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT  = path.resolve(__dirname, '../..');
const SCRIPT_PATH   = path.resolve(PROJECT_ROOT, 'scripts/docling_extract.py');
// Use venv Python if available (docling is installed there), fallback to system python3
const VENV_PYTHON   = path.resolve(PROJECT_ROOT, '.venv/bin/python3');
const PYTHON_BIN    = existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3';

// HTTP sidecar mode: if DOCLING_URL is set, POST to sidecar instead of spawning subprocess
const DOCLING_URL   = process.env.DOCLING_URL || null;

const SUPPORTED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp', '.gif', '.webp',
  '.pdf', '.docx', '.pptx', '.xlsx', '.html',
]);

export class DoclingProcessor {
  /**
   * @param {object} [options]
   * @param {boolean} [options.verbose=false]  - Log extraction activity
   * @param {number}  [options.timeout=60000]  - Max ms per file (default 60s)
   */
  constructor(options = {}) {
    this.verbose = options.verbose ?? false;
    this.timeout = options.timeout ?? 60000;
    this._cache  = new Map(); // filePath → extracted text
  }

  /**
   * Whether a file is a type Docling can process.
   * @param {string} filePath
   * @returns {boolean}
   */
  static supports(filePath) {
    return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  }

  /**
   * Extract text from a rich document file.
   * Returns cached result on repeated calls for the same path.
   *
   * @param {string} filePath  - Absolute path to the file
   * @returns {Promise<string|null>}  Extracted text, or null on failure
   */
  async extract(filePath) {
    if (!DoclingProcessor.supports(filePath)) return null;
    if (!existsSync(filePath)) return null;

    const abs = path.resolve(filePath);

    if (this._cache.has(abs)) return this._cache.get(abs);

    if (this.verbose) {
      process.stdout.write(`  [docling] ${path.basename(abs)} ... `);
    }

    try {
      const result = DOCLING_URL
        ? await this._extractHttp(abs)
        : await this._extractSubprocess(abs);

      if (result.error) {
        if (this.verbose) log.info(`error: ${result.error}`);
        return null;
      }

      const text = result.text?.trim() || null;
      if (this.verbose) log.info(`ok (${result.pages ?? '?'} page(s), ${text?.length ?? 0} chars)`);

      this._cache.set(abs, text);
      return text;

    } catch (err) {
      if (this.verbose) log.info(`failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Extract via local Python subprocess (default non-Docker mode).
   * @private
   */
  async _extractSubprocess(abs) {
    const { stdout } = await execFileAsync(PYTHON_BIN, [SCRIPT_PATH, abs], {
      timeout: this.timeout,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
    });
    return JSON.parse(stdout.trim());
  }

  /**
   * Extract via HTTP sidecar (Docker mode).
   * POSTs the file to the docling sidecar's /convert endpoint.
   * @private
   */
  async _extractHttp(abs) {
    const fileBuffer = readFileSync(abs);
    const filename = path.basename(abs);

    // Build multipart/form-data manually to avoid extra dependencies
    const boundary = `----docling${Date.now()}`;
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;

    const body = Buffer.concat([
      Buffer.from(header),
      fileBuffer,
      Buffer.from(footer),
    ]);

    const res = await fetch(`${DOCLING_URL}/convert`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!res.ok) {
      return { error: `HTTP ${res.status}: ${await res.text()}` };
    }
    return await res.json();
  }

  /** Clear the in-memory cache. */
  clearCache() {
    this._cache.clear();
  }
}

export default DoclingProcessor;
