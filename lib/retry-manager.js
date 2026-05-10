// ═══════════════════════════════════════════════════════════════════
//  lib/retry-manager.js — Exponential Backoff Retry Manager
//
//  Handles retry logic for OpenAI/Gemini API calls with configurable
//  backoff delays. Prevents 429 rate limit errors from causing
//  silent failures or auto-accepting bad matches.
//
//  Retry schedule:
//    1st retry → 15 seconds
//    2nd retry → 45 seconds
//    3rd retry → 90 seconds
//    Max retries: 3
//
//  Key rules:
//    - NEVER auto-accept on API failure
//    - Track retry count per item
//    - Report status: "retry_needed" instead of fake fallback
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_RETRY_DELAYS = [15000, 45000, 90000]; // 15s, 45s, 90s
const DEFAULT_MAX_RETRIES = 3;

/**
 * Create a retry manager instance for tracking retries across items.
 *
 * @param {object} [options]
 * @param {number[]} [options.delays] - Array of delays in ms for each retry attempt
 * @param {number} [options.maxRetries] - Maximum number of retry attempts
 * @returns {object} Retry manager instance
 */
export function createRetryManager(options = {}) {
  const delays = options.delays || DEFAULT_RETRY_DELAYS;
  const maxRetries = options.maxRetries || DEFAULT_MAX_RETRIES;

  // Track retry state per item (keyed by item ID or index)
  const retryState = new Map();

  return {
    /**
     * Get the current retry state for an item.
     * @param {string|number} itemKey - Unique identifier for the item
     * @returns {{ attempt: number, maxRetries: number, isExhausted: boolean, nextDelay: number|null }}
     */
    getState(itemKey) {
      const state = retryState.get(itemKey) || { attempt: 0 };
      return {
        attempt: state.attempt,
        maxRetries,
        isExhausted: state.attempt >= maxRetries,
        nextDelay: state.attempt < maxRetries ? delays[state.attempt] : null
      };
    },

    /**
     * Record a retry attempt for an item.
     * @param {string|number} itemKey - Unique identifier for the item
     * @returns {{ attempt: number, delay: number, isExhausted: boolean }}
     */
    recordRetry(itemKey) {
      const state = retryState.get(itemKey) || { attempt: 0 };
      state.attempt += 1;
      retryState.set(itemKey, state);

      const delayIndex = Math.min(state.attempt - 1, delays.length - 1);
      const delay = delays[delayIndex] || delays[delays.length - 1];

      return {
        attempt: state.attempt,
        delay,
        isExhausted: state.attempt >= maxRetries
      };
    },

    /**
     * Reset retry state for an item (e.g. after successful processing).
     * @param {string|number} itemKey
     */
    reset(itemKey) {
      retryState.delete(itemKey);
    },

    /**
     * Reset retry state for all items.
     */
    resetAll() {
      retryState.clear();
    },

    /**
     * Get a summary of retry states.
     * @returns {{ total: number, active: number, exhausted: number }}
     */
    getSummary() {
      let active = 0;
      let exhausted = 0;
      for (const state of retryState.values()) {
        if (state.attempt >= maxRetries) {
          exhausted++;
        } else {
          active++;
        }
      }
      return {
        total: retryState.size,
        active,
        exhausted
      };
    },

    /**
     * Get all items that need retry (not yet exhausted).
     * @returns {Array<{ itemKey: string|number, attempt: number, nextDelay: number }>}
     */
    getPendingRetries() {
      const pending = [];
      for (const [itemKey, state] of retryState.entries()) {
        if (state.attempt < maxRetries) {
          const delayIndex = Math.min(state.attempt, delays.length - 1);
          pending.push({
            itemKey,
            attempt: state.attempt,
            nextDelay: delays[delayIndex]
          });
        }
      }
      return pending;
    },

    /**
     * Get all items that have exhausted retries.
     * @returns {Array<{ itemKey: string|number, attempt: number }>}
     */
    getExhaustedItems() {
      const exhausted = [];
      for (const [itemKey, state] of retryState.entries()) {
        if (state.attempt >= maxRetries) {
          exhausted.push({ itemKey, attempt: state.attempt });
        }
      }
      return exhausted;
    }
  };
}

/**
 * Execute a function with retry logic.
 * Wraps an async function with exponential backoff retry.
 *
 * @param {Function} fn - Async function to execute
 * @param {object} [options]
 * @param {number} [options.maxRetries=3] - Max retry attempts
 * @param {number[]} [options.delays] - Custom delay array
 * @param {function} [options.onRetry] - Callback on retry (attempt, delay, error)
 * @param {function} [options.shouldRetry] - Custom function to determine if retry should happen
 * @returns {Promise<{ success: boolean, data: any, attempts: number, error: string|null }>}
 */
export async function withRetry(fn, options = {}) {
  const maxRetries = options.maxRetries || DEFAULT_MAX_RETRIES;
  const delays = options.delays || DEFAULT_RETRY_DELAYS;
  const onRetry = options.onRetry || null;
  const shouldRetry = options.shouldRetry || defaultShouldRetry;

  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const result = await fn();
      return {
        success: true,
        data: result,
        attempts: attempt,
        error: null
      };
    } catch (err) {
      lastError = err;

      if (attempt <= maxRetries && shouldRetry(err, attempt)) {
        const delayIndex = Math.min(attempt - 1, delays.length - 1);
        const delay = delays[delayIndex];

        if (onRetry) {
          onRetry(attempt, delay, err);
        }

        console.log(`[RETRY-MANAGER] Attempt ${attempt}/${maxRetries + 1} failed, retrying in ${(delay / 1000).toFixed(0)}s: ${err.message}`);
        await sleep(delay);
      } else {
        // Don't retry — either max retries reached or error is not retryable
        break;
      }
    }
  }

  return {
    success: false,
    data: null,
    attempts: maxRetries + 1,
    error: lastError ? lastError.message : 'Unknown error'
  };
}

/**
 * Default function to determine if an error should trigger a retry.
 * Retries on: 429 (rate limit), 5xx (server errors), timeouts, network errors.
 *
 * @param {Error} err - The error object
 * @param {number} attempt - Current attempt number
 * @returns {boolean} Whether to retry
 */
function defaultShouldRetry(err, attempt) {
  const message = (err.message || '').toLowerCase();
  const statusCode = err.status || err.statusCode || 0;

  // Rate limiting
  if (statusCode === 429 || message.includes('rate limit') || message.includes('429')) {
    return true;
  }

  // Server errors
  if (statusCode >= 500 && statusCode < 600) {
    return true;
  }

  // Timeout errors
  if (message.includes('timeout') || message.includes('abort') || message.includes('etimedout')) {
    return true;
  }

  // Network errors
  if (message.includes('econnrefused') || message.includes('enotfound') || message.includes('network')) {
    return true;
  }

  // Malformed response (sometimes transient)
  if (message.includes('unexpected token') || message.includes('parse') || message.includes('malformed')) {
    return attempt <= 2; // Only retry parse errors once
  }

  return false;
}

/**
 * Sleep helper.
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
