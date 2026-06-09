/**
 * TextSplitter — chunk documents into overlapping pieces for embedding
 *
 * Default strategy: recursive character splitting.
 * Tries separators in order [\n\n, \n, '. ', ' ', ''] so chunks respect
 * natural document structure (paragraphs → lines → sentences → words).
 *
 * @module src/rag/text-splitter.js
 */

import { Runnable } from '../core/runnable.js';

export class TextSplitter extends Runnable {
  /**
   * @param {object} [options]
   * @param {number}   [options.chunkSize=1000]     Max characters per chunk
   * @param {number}   [options.chunkOverlap=200]   Overlap between adjacent chunks
   * @param {string[]} [options.separators]          Separator priority list
   */
  constructor(options = {}) {
    super();
    this.chunkSize    = options.chunkSize    ?? 1000;
    this.chunkOverlap = options.chunkOverlap ?? 200;
    this.separators   = options.separators   ?? ['\n\n', '\n', '. ', ' ', ''];
  }

  /**
   * @param {object|object[]} input - Document or Document[]
   * @returns {Promise<Chunk[]>}
   */
  async _call(input) {
    const docs   = Array.isArray(input) ? input : [input];
    const chunks = [];

    for (const doc of docs) {
      // Split by markdown sections first, then apply character splitting within each section
      const sections = this._splitByMarkdownSections(doc.pageContent);
      const allSplits = [];
      for (const section of sections) {
        if (section.length <= this.chunkSize) {
          allSplits.push(section);
        } else {
          allSplits.push(...this._split(section));
        }
      }
      const finalSplits = this._injectTableHeaders(allSplits);
      finalSplits.forEach((pageContent, i) => {
        chunks.push({
          pageContent,
          metadata: { ...doc.metadata, chunkIndex: i },
        });
      });
    }

    return chunks;
  }

  /**
   * Split text on markdown heading boundaries (## and ###).
   * Each section keeps its heading as the first line, so retrieval
   * scores the heading + body together (e.g. "## Priya Patel" stays
   * with Priya's details). The document title (# H1) is prepended
   * to every section as context.
   *
   * @param {string} text
   * @returns {string[]}
   */
  _splitByMarkdownSections(text) {
    // Only applies to markdown content with headings
    if (!text.includes('\n#')) return [text];

    const lines = text.split('\n');
    const sections = [];
    let current = [];
    let docTitle = '';

    for (const line of lines) {
      // Capture document title (# H1) for prepending
      if (/^# [^#]/.test(line) && !docTitle) {
        docTitle = line;
      }

      // Split on ## or ### headings (not # H1 which is the doc title)
      if (/^#{2,3} /.test(line) && current.length > 0) {
        const sectionText = current.join('\n').trim();
        if (sectionText) sections.push(sectionText);
        current = [];
        // Prepend doc title to give each section document-level context
        if (docTitle && !line.startsWith('# ')) {
          current.push(docTitle);
        }
      }
      current.push(line);
    }

    // Flush last section
    const sectionText = current.join('\n').trim();
    if (sectionText) sections.push(sectionText);

    // If only 1 section was found, heading splitting didn't help — return original
    if (sections.length <= 1) return [text];

    return sections;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Recursively split text using separator priority list.
   * @param {string} text
   * @returns {string[]}
   */
  _split(text) {
    if (text.length <= this.chunkSize) return [text];

    // Find the first separator that appears in the text
    const sep = this.separators.find(s => s === '' || text.includes(s)) ?? '';

    const parts = sep === '' ? [...text] : text.split(sep);
    const chunks = [];
    let current  = '';

    for (const part of parts) {
      const candidate = current ? current + sep + part : part;

      if (candidate.length > this.chunkSize && current) {
        // Flush current chunk
        const trimmed = current.trim();
        if (trimmed) chunks.push(trimmed);

        // Carry overlap forward: take the tail of current as the new start
        const overlapStart = Math.max(0, current.length - this.chunkOverlap);
        current = current.slice(overlapStart) + sep + part;
      } else {
        current = candidate;
      }
    }

    if (current.trim()) chunks.push(current.trim());

    // Recursively split any chunk still over the limit (e.g. a very long paragraph)
    return chunks.flatMap(chunk =>
      chunk.length > this.chunkSize
        ? this._splitWithNextSeparator(chunk)
        : [chunk]
    );
  }

  /**
   * Detect markdown table headers and prepend them to continuation chunks
   * that have table rows but no header separator. This ensures every chunk
   * of a split table retains column-name context for retrieval scoring.
   *
   * @param {string[]} splits
   * @returns {string[]}
   */
  _injectTableHeaders(splits) {
    let tableHeader = null;

    return splits.map(chunk => {
      const lines      = chunk.split('\n');
      const hasSep     = lines.some(l => /^\|[-| :]+\|/.test(l));
      const hasRow     = lines.some(l => /^\|.+\|/.test(l));

      if (hasSep) {
        // Chunk contains the header separator — extract header + separator
        const sepIdx = lines.findIndex(l => /^\|[-| :]+\|/.test(l));
        if (sepIdx > 0) {
          tableHeader = lines.slice(sepIdx - 1, sepIdx + 1).join('\n');
        }
        return chunk;
      }

      if (hasRow && tableHeader && !chunk.trimStart().startsWith(tableHeader)) {
        return tableHeader + '\n' + chunk;
      }

      return chunk;
    });
  }

  /**
   * Try the next separator in the list when a chunk is still oversized.
   */
  _splitWithNextSeparator(text) {
    // Drop the first separator and try again
    const fallback = new TextSplitter({
      chunkSize:    this.chunkSize,
      chunkOverlap: this.chunkOverlap,
      separators:   this.separators.slice(1),
    });
    return fallback._split(text);
  }
}

export default TextSplitter;
