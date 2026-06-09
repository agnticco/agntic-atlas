/**
 * SourceRegistry — Curated, credibility-ranked catalog of data sources.
 *
 * Each source describes: what it is, why it's credible, how to fetch it,
 * and what format the output comes in. Sources are seeded at startup and
 * are not user-editable (they're editorial choices by the product).
 *
 * This is durable IP — the registry is a first-class module, not a config blob.
 *
 * @module src/workflows/source-registry.js
 */

import Database from 'better-sqlite3';
import { log } from '../utils/logger.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL,
  credibility    TEXT NOT NULL,
  url_template   TEXT NOT NULL,
  output_format  TEXT NOT NULL DEFAULT 'text',
  category       TEXT NOT NULL DEFAULT 'general',
  fetch_module   TEXT NOT NULL
);
`;

/** Seed sources — the editorial catalog. */
const SEEDS = [
  {
    id:            'nws_afd',
    name:          'NWS Area Forecast Discussion',
    description:   'Detailed meteorological discussion written by National Weather Service forecasters. Updated multiple times daily. Contains technical analysis of synoptic patterns, mesoscale features, and forecast reasoning.',
    credibility:   'Government primary source — NWS forecasters write these directly. No aggregation, no ads, no editorial filter. This is the raw forecast reasoning that drives all downstream weather products.',
    url_template:  'https://forecast.weather.gov/product.php?site=NWS&issuedby={office}&product=AFD&format=CI&version=1&glossary=1',
    output_format: 'text',
    category:      'weather',
    fetch_module:  'nws-afd',
  },
];

export class SourceRegistry {
  /**
   * @param {object} options
   * @param {string} [options.dbPath] — Path to SQLite file
   */
  constructor({ dbPath = './memory/workflows/sources.sqlite' } = {}) {
    this.dbPath = dbPath;
    this.db = null;
  }

  async init() {
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);
    this._seed();
    log.info(`[source-registry] ${this.getAll().length} sources loaded`);
  }

  /** Upsert seed sources so new ones appear on restart. */
  _seed() {
    const upsert = this.db.prepare(`
      INSERT INTO sources (id, name, description, credibility, url_template, output_format, category, fetch_module)
      VALUES (@id, @name, @description, @credibility, @url_template, @output_format, @category, @fetch_module)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, description=excluded.description, credibility=excluded.credibility,
        url_template=excluded.url_template, output_format=excluded.output_format,
        category=excluded.category, fetch_module=excluded.fetch_module
    `);
    const tx = this.db.transaction(() => {
      for (const seed of SEEDS) upsert.run(seed);
    });
    tx();
  }

  /** Get a source by ID. */
  get(id) {
    return this.db.prepare('SELECT * FROM sources WHERE id = ?').get(id) ?? null;
  }

  /** List all sources. */
  getAll() {
    return this.db.prepare('SELECT * FROM sources ORDER BY category, name').all();
  }

  /** Find sources by category. */
  getByCategory(category) {
    return this.db.prepare('SELECT * FROM sources WHERE category = ? ORDER BY name').all(category);
  }

  close() {
    this.db?.close();
  }
}
