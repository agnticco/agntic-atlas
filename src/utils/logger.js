/**
 * Logger — structured terminal logging for the agent framework.
 *
 * Each turn is a boxed section you can read top-to-bottom:
 *   ┌ QUERY   — what the user asked
 *   │ ROUTE   — how the agent classified it
 *   │ TOOLS   — what tools were called and what came back
 *   │ LLM     — each model call with token count and cost
 *   └ OUTPUT  — the response + cumulative totals
 *
 * @module src/utils/logger.js
 */

// ── ANSI ─────────────────────────────────────────────────────────────────────
const R  = '\x1b[0m';
const B  = '\x1b[1m';
const D  = '\x1b[2m';
const CYAN    = '\x1b[36m';
const GREEN   = '\x1b[32m';
const YELLOW  = '\x1b[33m';
const RED     = '\x1b[31m';
const MAGENTA = '\x1b[35m';
const BLUE    = '\x1b[34m';
const WHITE   = '\x1b[37m';
const GRAY    = '\x1b[90m';
const BLACK   = '\x1b[30m';
const BG_CYAN  = '\x1b[46m';
const BG_GREEN = '\x1b[42m';
const BG_RED   = '\x1b[41m';
const BG_YELLOW = '\x1b[43m';

const trunc = (s, n = 70) => s && s.length > n ? s.slice(0, n) + '…' : (s || '');
const money = (usd) => usd != null && usd > 0 ? `$${usd.toFixed(4)}` : '';
const comma = (n) => Number(n).toLocaleString();

export class Logger {
  constructor() {
    this._enabled = false;
    this._turnTokens = 0;
    this._turnCost = 0;
    this._turnCalls = 0;
    this._postBracketTokens = 0;
    this._postBracketCost = 0;
  }

  enable()  { this._enabled = true; }
  disable() { this._enabled = false; }

  _out(msg) { if (this._enabled) console.log(msg); }

  // ═══════════════════════════════════════════════════════════════════════════
  // TURN START
  // ═══════════════════════════════════════════════════════════════════════════

  turn(sessionId, query) {
    // Reset per-turn accumulators
    this._turnTokens = 0;
    this._turnCost = 0;
    this._turnCalls = 0;
    this._postBracketTokens = 0;
    this._postBracketCost = 0;
    this._turnStartMs = Date.now();

    this._out('');
    this._out(`${GRAY}┌──────────────────────────────────────────────────────────────────────┐${R}`);
    this._out(`${GRAY}│${R} ${B}${WHITE}QUERY${R}  ${WHITE}${trunc(query, 58)}${R}`);
    this._out(`${GRAY}│${R} ${D}session ${sessionId.slice(0, 12)}${R}`);
    this._out(`${GRAY}│${R}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TURN END — shows output preview + totals
  // ═══════════════════════════════════════════════════════════════════════════

  done(sessionId, strategy, latencyMs, tokens, costUsd, output = '') {
    const secs = (latencyMs / 1000).toFixed(1);
    const totalTokens = this._turnTokens || (tokens ? tokens.input + tokens.output : 0);
    const totalCost = this._turnCost || costUsd || 0;
    const calls = this._turnCalls;

    // Save for grand total after compression
    this._lastTurnTokens = totalTokens;
    this._lastTurnCost = totalCost;
    this._lastTurnSecs = secs;
    this._lastTurnCalls = calls;
    this._lastTurnStrategy = strategy;

    this._out(`${GRAY}│${R}`);
    this._out(`${GRAY}│${R} ${B}${GREEN}OUTPUT${R}  ${D}${trunc(output, 58)}${R}`);
    this._out(`${GRAY}│${R}`);
    this._out(`${GRAY}│${R}  ${B}${WHITE}${comma(totalTokens)} tokens${R}   ${B}${YELLOW}${money(totalCost) || '$0.0000'}${R}   ${D}${secs}s   ${calls} llm call${calls !== 1 ? 's' : ''}   ${strategy || 'direct'}${R}`);
    this._out(`${GRAY}└──────────────────────────────────────────────────────────────────────┘${R}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UNDERSTANDING
  // ═══════════════════════════════════════════════════════════════════════════

  rewrite(raw, rewritten, skipped = false) {
    if (skipped) return;
    this._out(`${GRAY}│${R} ${CYAN}REWRITE${R}  ${D}"${trunc(rewritten, 55)}"${R}`);
  }

  route({ artifact_type, strategy, model_tier, tool_hints = [], vault_context }) {
    const strat = strategy === 'planning' ? 'multi-step plan'
               : strategy === 'structured' ? 'structured output'
               : artifact_type === 'document' ? 'document'
               : 'direct';

    const tools = tool_hints.length > 0
      ? tool_hints.map(t => `${MAGENTA}${t.replace('_', ' ')}${R}`).join(', ')
      : `${D}none${R}`;

    this._out(`${GRAY}│${R} ${GREEN}ROUTE${R}   ${B}${strat}${R}  ${this._tierBadge(model_tier)}  tools: ${tools}`);
    if (vault_context) this._out(`${GRAY}│${R}         ${D}+ vault overview injected${R}`);
  }

  agent(mode, detail = '') {
    if (mode === 'general') return;
    if (mode === 'force_synthesis') {
      this._out(`${GRAY}│${R} ${YELLOW}■ SYNTHESIZE${R}  ${D}enough context gathered, writing answer${R}`);
    } else if (mode === 'document') {
      this._out(`${GRAY}│${R} ${MAGENTA}■ DOCUMENT${R}  ${D}drafting${R}`);
    } else if (mode === 'structured') {
      this._out(`${GRAY}│${R} ${BLUE}■ STRUCTURED${R}  ${D}building JSON${R}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TOOL CALLS
  // ═══════════════════════════════════════════════════════════════════════════

  toolCall(name, args = {}) {
    const label = name === 'vault_search'  ? 'VAULT SEARCH'
               : name === 'web_search'    ? 'WEB SEARCH'
               : name === 'calculator'    ? 'CALCULATE'
               : name === 'data_analyzer' ? 'ANALYZE'
               : name.toUpperCase();

    const detail = name === 'vault_search' ? args.query
                 : name === 'web_search'   ? args.query
                 : name === 'calculator'   ? args.expression
                 : name === 'data_analyzer' ? args.file
                 : Object.values(args).filter(v => typeof v === 'string')[0] ?? '';

    this._out(`${GRAY}│${R}`);
    this._out(`${GRAY}│${R} ${MAGENTA}→ ${label}${R}  ${D}"${trunc(detail, 50)}"${R}`);
  }

  toolResult(name, summary) {
    // Handled by vaultConfidence — avoid duplication
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RETRIEVAL RESULTS
  // ═══════════════════════════════════════════════════════════════════════════

  vaultConfidence(query, confidence) {
    const badge = confidence === 'HIGH'   ? `${BG_GREEN}${BLACK}${B} HIGH ${R}`
               : confidence === 'MEDIUM' ? `${BG_YELLOW}${BLACK}${B} MED ${R}`
               : `${BG_RED}${WHITE}${B} LOW ${R}`;
    this._out(`${GRAY}│${R}   ← ${badge}`);
  }

  vaultRetry(original, rewritten) {
    this._out(`${GRAY}│${R}   ${YELLOW}↻ retrying${R}  ${D}"${trunc(rewritten, 50)}"${R}`);
  }

  grade(type, reason, query = '') {
    const pass = reason.includes('pass') || reason.includes('improved');
    const icon = pass ? `${GREEN}✓${R}` : `${YELLOW}△${R}`;
    this._out(`${GRAY}│${R}   ${icon} ${D}grade ${type}: ${reason}${R}`);
  }

  checkTools(rounds, forcing = false) {
    if (forcing) {
      this._out(`${GRAY}│${R}`);
      this._out(`${GRAY}│${R} ${YELLOW}■ PLATEAU${R}  ${D}${rounds} tool rounds — forcing synthesis${R}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LLM CALLS — prominent token + cost display
  // ═══════════════════════════════════════════════════════════════════════════

  llmCall(tier, model, context, inputTokens, outputTokens, costUsd) {
    const total = inputTokens + outputTokens;
    const cost = money(costUsd);

    // Compression fires after the bracket closes
    if (context === 'compression') {
      const grandTokens = (this._lastTurnTokens ?? 0) + total;
      const grandCost = (this._lastTurnCost ?? 0) + (costUsd ?? 0);
      const totalSecs = this._turnStartMs ? ((Date.now() - this._turnStartMs) / 1000).toFixed(1) : '?';
      this._out(`  ${D}⚡ compression${R}  ${B}${comma(total)}${R}${D} tok${R}  ${YELLOW}${cost}${R}`);
      this._out(`  ${D}⚡ turn total${R}   ${B}${WHITE}${comma(grandTokens)}${R}${D} tok${R}  ${B}${YELLOW}${money(grandCost)}${R}  ${D}${totalSecs}s${R}`);
      this._out('');
      return;
    }

    const ctx = context && context !== 'agent' ? ` ${D}(${context})${R}` : '';

    // Accumulate for turn totals
    this._turnTokens += total;
    this._turnCost += costUsd ?? 0;
    this._turnCalls += 1;

    this._out(`${GRAY}│${R}   ${WHITE}⚡${R} ${this._tierLabel(tier)}  ${B}${comma(total)}${R} tok  ${YELLOW}${cost}${R}${ctx}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PLANNING
  // ═══════════════════════════════════════════════════════════════════════════

  planning(action, detail = '') {
    if (action === 'generate') {
      this._out(`${GRAY}│${R}`);
      this._out(`${GRAY}│${R} ${BLUE}◇ PLAN${R}  ${D}generating task breakdown${R}`);
    } else if (action === 'execute') {
      this._out(`${GRAY}│${R} ${BLUE}◇ EXECUTE${R}  ${D}${detail}${R}`);
    } else if (action === 'synthesize') {
      this._out(`${GRAY}│${R} ${BLUE}◇ SYNTHESIZE${R}  ${D}combining task results${R}`);
    } else if (action === 'fallback') {
      this._out(`${GRAY}│${R} ${YELLOW}◇ PLAN FAILED${R}  ${D}falling back to direct answer${R}`);
    }
  }

  taskWorker(taskId, description, status = 'start') {
    if (status === 'start') {
      this._out(`${GRAY}│${R}   ${CYAN}→ #${taskId}${R}  ${D}${trunc(description, 50)}${R}`);
    } else if (status === 'done') {
      this._out(`${GRAY}│${R}   ${GREEN}✓ #${taskId} done${R}`);
    } else {
      this._out(`${GRAY}│${R}   ${RED}✗ #${taskId} failed${R}`);
    }
  }

  wave(waveNum, taskCount) {
    this._out(`${GRAY}│${R}   ${BLUE}wave ${waveNum}${R}  ${D}(${taskCount} parallel)${R}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RECOVERY
  // ═══════════════════════════════════════════════════════════════════════════

  nudge(type, detail = '') {
    const msgs = {
      tool_nudge:    'model described tool instead of calling it — retrying',
      answer_retry:  'answer too brief — retrying',
      leaked_intent: 'tool intent in plain text — redirecting',
      insufficient:  'response insufficient — retrying',
    };
    this._out(`${GRAY}│${R} ${YELLOW}! ${msgs[type] || type}${R}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DOCUMENTS
  // ═══════════════════════════════════════════════════════════════════════════

  document(action, detail = '') {
    if (action === 'inject') {
      this._out(`${GRAY}│${R} ${MAGENTA}◆ DOCUMENT${R}  ${D}${detail}${R}`);
    } else if (action === 'route') {
      this._out(`${GRAY}│${R} ${MAGENTA}◆ DOCUMENT${R}  ${D}${detail}${R}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GENERIC
  // ═══════════════════════════════════════════════════════════════════════════

  evaluation(grade) {
    if (!this._enabled || !grade) return;
    const s = (n) => {
      if (n === null || n === undefined) return `${D}—${R}`;
      const num = Number(n) || 0;
      const color = num >= 0.8 ? GREEN : num >= 0.6 ? YELLOW : RED;
      return `${color}${B}${num.toFixed(2)}${R}`;
    };
    // Hallucination is inverted: 0.0 is best, 1.0 is worst
    const h = (n) => {
      if (n === null || n === undefined) return `${D}—${R}`;
      const num = Number(n) || 0;
      const color = num <= 0.1 ? GREEN : num <= 0.3 ? YELLOW : RED;
      return `${color}${B}${num.toFixed(2)}${R}`;
    };
    const task = grade.taskCompleted ? `${GREEN}✓${R}` : `${RED}✗${R}`;
    const tools = grade.toolCalls > 0 ? `tools ${s(grade.toolEfficiency)} ${D}(${grade.toolsUseful}/${grade.toolCalls})${R}` : '';
    console.log(`  ${D}⚡ eval${R}  relevancy ${s(grade.answer_relevancy)}  faithful ${s(grade.faithfulness)}  hallucin ${h(grade.hallucination)}  task ${task}  ${tools}`);
    if (grade.reasoning) {
      console.log(`  ${D}⚡ judge${R}  ${D}${grade.reasoning}${R}`);
    }
    if (grade.flags?.length > 0) {
      console.log(`  ${D}⚡ flags${R}  ${YELLOW}[${grade.flags.join(']  [')}]${R}`);
    }
  }

  info(msg)  { this._out(`${GRAY}│${R} ${D}${msg}${R}`); }
  warn(msg)  { this._out(`${GRAY}│${R} ${YELLOW}! ${msg}${R}`); }
  error(msg) { this._out(`${GRAY}│${R} ${RED}✗ ${msg}${R}`); }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _tierBadge(tier) {
    if (tier === 'powerful') return `${BG_RED}${WHITE}${B} powerful ${R}`;
    if (tier === 'fast')     return `${BG_GREEN}${BLACK}${B} fast ${R}`;
    return `${BG_CYAN}${BLACK}${B} balanced ${R}`;
  }

  _tierLabel(tier) {
    if (tier === 'powerful') return `${RED}powerful${R}`;
    if (tier === 'fast')     return `${GREEN}fast${R}`;
    return `${CYAN}balanced${R}`;
  }

  _tierColor(tier) { return this._tierLabel(tier); }
}

export const log = new Logger();
export default Logger;
