/**
 * DocumentLoader — load text content into Document objects
 *
 * Accepts:
 *   string              — raw text (single Document) or file path
 *   { text, metadata }  — Document literal pass-through
 *   directory path      — recursively loads all matching files
 *   array               — maps each item through the above rules
 *
 * Markdown support:
 *   .md files have YAML frontmatter stripped and extracted as metadata.
 *   The note title is taken from the first # heading or the filename.
 *
 * Docling support (optional):
 *   When a DoclingProcessor is provided, Obsidian-style embed references
 *   (![[image.png]], ![[file.pdf]]) inside .md files are resolved to their
 *   actual files on disk, OCR'd / extracted via Docling, and their text is
 *   inlined into the document before chunking. This means screenshots and
 *   PDF attachments become fully searchable alongside the note text.
 *
 *   Embed resolution uses Obsidian's flat-namespace lookup: searches the
 *   vaultRoot (if provided) for the filename, falling back to the note's
 *   own directory.
 *
 * @module src/rag/document-loader.js
 */

import { promises as fs } from 'fs';
import path from 'path';
import { unzipSync, strFromU8 } from 'fflate';
import { Runnable } from '../core/runnable.js';
import { DoclingProcessor } from './docling-processor.js';

export class DocumentLoader extends Runnable {
  /**
   * @param {object} [options]
   * @param {string}          [options.source]           - Label for the source (used in metadata)
   * @param {string}          [options.encoding]         - File encoding (default 'utf-8')
   * @param {string[]}        [options.extensions]       - File extensions to load from directories
   *                                                       Default: ['.md', '.txt', '.text']
   * @param {DoclingProcessor|boolean} [options.docling] - DoclingProcessor instance, or true to
   *                                                       auto-create one. Enables ![[embed]]
   *                                                       resolution and OCR for images/PDFs.
   * @param {string}          [options.vaultRoot]        - Root directory for Obsidian embed lookup.
   *                                                       Defaults to the directory being loaded.
   * @param {boolean}         [options.verbose]          - Log Docling extraction activity
   */
  constructor(options = {}) {
    super();
    this.source     = options.source     ?? null;
    this.encoding   = options.encoding   ?? 'utf-8';
    this.extensions = options.extensions ?? ['.md', '.txt', '.text'];
    this.vaultRoot  = options.vaultRoot  ?? null;
    this.verbose    = options.verbose    ?? false;

    if (options.docling === true) {
      this.docling = new DoclingProcessor({ verbose: this.verbose });
    } else if (options.docling instanceof DoclingProcessor) {
      this.docling = options.docling;
    } else {
      this.docling = null;
    }

    // Cache of vault file paths for fast embed lookup: basename → absolute path
    this._vaultIndex = null;
  }

  /**
   * @param {string|object|Array} input
   * @returns {Promise<Document[]>}
   */
  async _call(input) {
    const items = Array.isArray(input) ? input : [input];
    const docs  = [];

    for (const item of items) {
      const loaded = await this._loadOne(item);
      docs.push(...loaded);
    }

    return docs;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  async _loadOne(item) {
    // Already a Document object
    if (item && typeof item === 'object' && typeof item.pageContent === 'string') {
      return [{ pageContent: item.pageContent, metadata: item.metadata ?? {} }];
    }

    if (typeof item !== 'string') {
      throw new Error(`DocumentLoader: unsupported input type "${typeof item}"`);
    }

    const trimmed = item.trim();

    // Check if this is a path that exists on disk
    try {
      const stat = await fs.stat(trimmed);

      if (stat.isDirectory()) {
        return await this._loadDirectory(trimmed);
      }

      if (stat.isFile()) {
        return await this._loadFile(trimmed, stat);
      }
    } catch {
      // Not a valid path — treat as raw text
    }

    // Plain text string
    return [{
      pageContent: trimmed,
      metadata:    { source: this.source ?? 'inline' },
    }];
  }

  /**
   * Recursively load all matching files from a directory.
   */
  async _loadDirectory(dirPath) {
    const allFiles = await this._walkDir(dirPath);
    const matching = allFiles.filter(f =>
      this.extensions.includes(path.extname(f).toLowerCase())
    );

    // Build vault index for embed resolution if Docling is active
    if (this.docling && !this._vaultIndex) {
      this._vaultIndex = await this._buildVaultIndex(dirPath, allFiles);
    }

    const docs = [];
    for (const filePath of matching) {
      try {
        const stat   = await fs.stat(filePath);
        const loaded = await this._loadFile(filePath, stat);
        docs.push(...loaded);
      } catch {
        // Skip unreadable files silently
      }
    }
    return docs;
  }

  /**
   * Build a filename → absolute path index for the entire vault.
   * Used to resolve Obsidian embeds like ![[screenshot.png]] regardless
   * of where the image lives in the vault hierarchy.
   * @private
   */
  async _buildVaultIndex(dirPath, allFiles) {
    const root  = this.vaultRoot ?? dirPath;
    const files = allFiles ?? await this._walkDir(root);
    const index = new Map();
    for (const f of files) {
      index.set(path.basename(f).toLowerCase(), f);
    }
    return index;
  }

  /**
   * Recursively walk a directory and return all file paths.
   */
  async _walkDir(dirPath) {
    const entries = await fs.readdir(dirPath, { withFileTypes: true, recursive: true });
    return entries
      .filter(e => e.isFile())
      .map(e => path.join(e.parentPath ?? e.path ?? dirPath, e.name));
  }

  /**
   * Load a single file. Applies markdown processing for .md files.
   * If a DoclingProcessor is attached, resolves ![[embed]] references and
   * inlines extracted text from images and PDFs.
   */
  async _loadFile(filePath, stat) {
    const absPath = path.resolve(filePath);
    const raw     = await fs.readFile(absPath, this.encoding);
    const ext     = path.extname(absPath).toLowerCase();
    const source  = this.source ?? path.basename(absPath);

    const baseMetadata = {
      source,
      filePath:  absPath,
      mtime:     stat?.mtimeMs   ?? 0,
      createdAt: stat?.birthtimeMs > 0
        ? stat.birthtimeMs
        : (stat?.mtimeMs ?? 0),
    };

    if (ext === '.md') {
      const { text, metadata: frontmatter } = parseMarkdown(raw, absPath);
      const enriched = this.docling
        ? await this._inlineEmbeds(text, absPath)
        : text;
      return [{
        pageContent: enriched,
        metadata:    { ...baseMetadata, ...frontmatter },
      }];
    }

    // Rich formats (PDF, DOCX, images, etc.) — extract via Docling if available
    if (this.docling && DoclingProcessor.supports(absPath)) {
      const extracted = await this.docling.extract(absPath);
      if (!extracted) return [];  // Docling failed — skip rather than ingest binary
      return [{
        pageContent: extracted,
        metadata:    { ...baseMetadata, title: path.basename(absPath, ext) },
      }];
    }

    // EPUB — one Document per spine section (chapter), with heading metadata
    if (ext === '.epub') {
      const sections = await extractEpubSections(absPath);
      if (!sections.length) return [];
      return sections.map(({ text, heading, sectionIndex }) => ({
        pageContent: text,
        metadata: {
          ...baseMetadata,
          title: path.basename(absPath, ext),
          sectionIndex,
          ...(heading ? { heading } : {}),
        },
      }));
    }

    // Binary formats with no extractor — skip rather than ingest garbage
    const binaryExts = new Set(['.pdf', '.docx', '.pptx', '.xlsx', '.png', '.jpg',
      '.jpeg', '.tiff', '.tif', '.bmp', '.gif', '.webp']);
    if (binaryExts.has(ext)) return [];

    return [{
      pageContent: raw,
      metadata:    baseMetadata,
    }];
  }

  /**
   * Scan markdown text for Obsidian embed syntax ![[filename]] and
   * replace each supported embed with its Docling-extracted text.
   *
   * Unsupported embeds (other .md files, unknown types) are removed
   * from the text to avoid polluting chunks with raw link syntax.
   *
   * @private
   * @param {string} text      - Markdown text content
   * @param {string} notePath  - Absolute path of the parent .md file
   * @returns {Promise<string>} Text with embeds replaced by extracted content
   */
  async _inlineEmbeds(text, notePath) {
    // Match ![[filename]] and ![[filename|alias]] and ![[filename#heading]]
    const embedPattern = /!\[\[([^\]|#]+)(?:[|#][^\]]*)?]]/g;
    const noteDir      = path.dirname(notePath);
    const matches      = [...text.matchAll(embedPattern)];

    if (matches.length === 0) return text;

    let result = text;

    for (const match of matches) {
      const embedName = match[1].trim();
      const resolved  = await this._resolveEmbed(embedName, noteDir);

      if (!resolved || !DoclingProcessor.supports(resolved)) {
        // Remove unsupported embed syntax rather than leaving ![[...]] in chunks
        result = result.replace(match[0], '');
        continue;
      }

      const extracted = await this.docling.extract(resolved);
      if (extracted) {
        const label = `\n\n[Extracted from: ${path.basename(resolved)}]\n${extracted}\n`;
        result = result.replace(match[0], label);
      } else {
        result = result.replace(match[0], '');
      }
    }

    return result.trim();
  }

  /**
   * Resolve an Obsidian embed name to an absolute file path.
   *
   * Obsidian uses a flat namespace — you reference files by name only,
   * regardless of folder depth. Resolution order:
   *   1. Exact match in vault index (built from all files in the vault root)
   *   2. Exact match in the same directory as the note
   *   3. Case-insensitive match in vault index
   *
   * @private
   * @param {string} embedName  - Filename from ![[embedName]]
   * @param {string} noteDir    - Directory containing the parent note
   * @returns {Promise<string|null>} Absolute path, or null if not found
   */
  async _resolveEmbed(embedName, noteDir) {
    const basename = path.basename(embedName);

    // 1. Vault index lookup (fast, exact basename match)
    if (this._vaultIndex) {
      const hit = this._vaultIndex.get(basename.toLowerCase());
      if (hit) return hit;
    }

    // 2. Same-directory fallback
    const local = path.join(noteDir, basename);
    try {
      await fs.access(local);
      return local;
    } catch { /* not there */ }

    return null;
  }
}

// ── Markdown helpers ──────────────────────────────────────────────────────────

/**
 * Strip YAML frontmatter from a markdown file and extract it as metadata.
 * Also extracts the first # heading as the document title.
 */
function parseMarkdown(raw, filePath) {
  let text     = raw;
  let metadata = {};

  // Extract and strip YAML frontmatter (--- ... ---)
  const frontmatterMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (frontmatterMatch) {
    metadata = parseSimpleYAML(frontmatterMatch[1]);
    text     = raw.slice(frontmatterMatch[0].length).trim();
  }

  // Extract title from first # heading if not in frontmatter
  if (!metadata.title) {
    const headingMatch = text.match(/^#{1,3}\s+(.+)/m);
    metadata.title = headingMatch
      ? headingMatch[1].trim()
      : path.basename(filePath, path.extname(filePath));
  }

  return { text, metadata };
}

/**
 * Minimal YAML key: value parser for frontmatter.
 * Handles strings, numbers, booleans, and simple arrays.
 * Does not handle nested objects — sufficient for Obsidian frontmatter.
 */
function parseSimpleYAML(yaml) {
  const result = {};

  for (const line of yaml.split('\n')) {
    const match = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    const v = rawValue.trim();

    if (v === '' || v === 'null' || v === '~') {
      result[key] = null;
    } else if (v === 'true') {
      result[key] = true;
    } else if (v === 'false') {
      result[key] = false;
    } else if (!isNaN(Number(v))) {
      result[key] = Number(v);
    } else if (v.startsWith('[') && v.endsWith(']')) {
      // Simple inline array: [a, b, c]
      result[key] = v.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
    } else {
      // Strip surrounding quotes if present
      result[key] = v.replace(/^['"]|['"]$/g, '');
    }
  }

  return result;
}

export default DocumentLoader;

// ── EPUB extractor ────────────────────────────────────────────────────────────

/**
 * Extract structured sections from an EPUB file.
 *
 * EPUBs are ZIP archives. The OPF package file defines the spine (reading
 * order). Each spine item is typically one chapter. We return one section
 * object per content file so the ingestion pipeline can create one Document
 * per chapter — preserving chapter boundaries as chunk boundaries.
 *
 * Each section carries:
 *   text         — extracted plain text with paragraph newlines intact
 *   heading      — chapter/section title from the HTML heading tags (or null)
 *   sectionIndex — position in spine reading order (0-based)
 *
 * @param {string} filePath - Absolute path to the .epub file
 * @returns {Promise<Array<{text:string, heading:string|null, sectionIndex:number}>>}
 */
async function extractEpubSections(filePath) {
  try {
    const buf      = await fs.readFile(filePath);
    const unzipped = unzipSync(new Uint8Array(buf));

    // ── 1. Find the OPF package file via META-INF/container.xml ──────────────
    let orderedFiles = [];
    const containerData = unzipped['META-INF/container.xml'];
    if (containerData) {
      const containerXml  = strFromU8(containerData);
      const opfPathMatch  = containerXml.match(/full-path="([^"]+\.opf)"/i);
      if (opfPathMatch) {
        const opfPath = opfPathMatch[1];
        const opfData = unzipped[opfPath];
        if (opfData) {
          const opfDir = opfPath.includes('/')
            ? opfPath.split('/').slice(0, -1).join('/')
            : '';
          orderedFiles = parseOpfSpine(strFromU8(opfData), opfDir, unzipped);
        }
      }
    }

    // ── 2. Fallback: alphabetical sort, skip known nav/toc files ─────────────
    if (!orderedFiles.length) {
      orderedFiles = Object.keys(unzipped)
        .filter(n => /\.(html|xhtml|htm)$/i.test(n) && !/\b(nav|toc|ncx|cover)\b/i.test(n))
        .sort();
    }

    // ── 3. Extract one section per content file ───────────────────────────────
    const sections = [];
    for (let i = 0; i < orderedFiles.length; i++) {
      const data = unzipped[orderedFiles[i]];
      if (!data) continue;
      const html    = strFromU8(data);
      const heading = extractHtmlHeading(html);
      const text    = htmlToText(html);
      if (text.length > 100) {
        sections.push({ text, heading, sectionIndex: i });
      }
    }

    return sections;
  } catch {
    return [];
  }
}

/**
 * Parse OPF spine to get content files in reading order.
 * Uses regex rather than a full XML parser — OPF is well-formed enough for this.
 *
 * @param {string} opfContent  - OPF file text
 * @param {string} opfDir      - Directory of the OPF file (for resolving relative hrefs)
 * @param {object} unzipped    - fflate unzip result (filename → Uint8Array)
 * @returns {string[]} Ordered list of zip-entry paths for content files
 */
function parseOpfSpine(opfContent, opfDir, unzipped) {
  // Build manifest: id → href
  const manifest = {};
  for (const m of opfContent.matchAll(/<item\b[^>]+>/gi)) {
    const idMatch   = m[0].match(/\bid="([^"]+)"/i);
    const hrefMatch = m[0].match(/\bhref="([^"]+)"/i);
    if (idMatch && hrefMatch) manifest[idMatch[1]] = hrefMatch[1];
  }

  // Get spine itemrefs in order
  const spineBlock = opfContent.match(/<spine[\s\S]*?>([\s\S]*?)<\/spine>/i)?.[1] ?? '';
  const orderedFiles = [];

  for (const m of spineBlock.matchAll(/<itemref\b[^>]+idref="([^"]+)"/gi)) {
    const href = manifest[m[1]];
    if (!href) continue;

    // Resolve relative to OPF directory; try both with and without the prefix
    const withDir  = opfDir ? `${opfDir}/${href}` : href;
    const resolved = unzipped[withDir] ? withDir : unzipped[href] ? href : null;
    if (resolved) orderedFiles.push(resolved);
  }

  return orderedFiles;
}

/**
 * Extract the first meaningful heading from an HTML content file.
 * Checks h1 → h2 → h3 → <title> in that order.
 *
 * @param {string} html
 * @returns {string|null}
 */
function extractHtmlHeading(html) {
  for (const tag of ['h1', 'h2', 'h3', 'title']) {
    const m = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    if (!m) continue;
    const text = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length > 0 && text.length < 200) return text;
  }
  return null;
}

/**
 * Convert HTML to plain text while preserving paragraph / block-level structure
 * as newlines. This gives the TextSplitter \n\n boundaries to prefer when
 * chunking, so chunks break at paragraph edges rather than mid-sentence.
 *
 * @param {string} html
 * @returns {string}
 */
function htmlToText(html) {
  return html
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|li|h[1-6]|blockquote|tr|td|th)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g,   (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
