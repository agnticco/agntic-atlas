/**
 * TokenCounter — approximate token counting utilities
 *
 * Uses the common heuristic: 1 token ≈ 4 characters.
 * Accurate enough for context-window budget decisions without
 * requiring a tokenizer dependency.
 *
 * @module src/utils/token-counter.js
 */

/**
 * Approximate token count for a plain string.
 * @param {string} text
 * @returns {number}
 */
export function countTokensApproximately(text) {
  if (!text) return 0;
  if (typeof text !== 'string') text = JSON.stringify(text);
  return Math.ceil(text.length / 4);
}

/**
 * Approximate token count for a single message object.
 * Adds ~4 tokens of overhead per message for role + formatting.
 * @param {object} message - BaseMessage instance
 * @returns {number}
 */
export function countMessageTokens(message) {
  const content = typeof message.content === 'string'
    ? message.content
    : JSON.stringify(message.content ?? '');
  return countTokensApproximately(content) + 4;
}

/**
 * Approximate total token count for an array of messages.
 * @param {object[]} messages - BaseMessage instances
 * @returns {number}
 */
export function countMessagesTokens(messages) {
  return messages.reduce((sum, m) => sum + countMessageTokens(m), 0);
}

/**
 * TokenCounter — stateful counter that tracks cumulative usage.
 */
export class TokenCounter {
  constructor() {
    this._total = 0;
  }

  /**
   * Count tokens in a string or message and add to running total.
   * @param {string|object} input - String or BaseMessage
   * @returns {number} tokens added
   */
  count(input) {
    const tokens = typeof input === 'string'
      ? countTokensApproximately(input)
      : countMessageTokens(input);
    this._total += tokens;
    return tokens;
  }

  /** Running total since last reset. */
  get total() { return this._total; }

  reset() { this._total = 0; }
}

export default TokenCounter;
