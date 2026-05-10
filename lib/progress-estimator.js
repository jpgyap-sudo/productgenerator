// ═══════════════════════════════════════════════════════════════════
//  lib/progress-estimator.js — Progress Bar + ETA Calculation
//
//  Calculates estimated time remaining for batch processing based on
//  completed items, total items, and elapsed time. Provides progress
//  percentage and human-readable ETA strings for the UI.
//
//  Architecture:
//    1. Track start time and per-item completion times
//    2. Calculate rolling average time per item
//    3. Estimate remaining time based on remaining items
//    4. Provide progress percentage and ETA string
//
//  Key rules:
//    - ETA updates after each completed item
//    - Uses rolling average of last N items for stability
//    - Falls back to simple average if not enough samples
// ═══════════════════════════════════════════════════════════════════

const ROLLING_WINDOW_SIZE = 10; // Use last 10 items for rolling average
const MIN_SAMPLES_FOR_ROLLING = 3;

/**
 * Create a progress estimator instance.
 *
 * @param {object} [options]
 * @param {number} [options.totalItems=0] - Total items to process
 * @param {number} [options.rollingWindow=10] - Items for rolling average
 * @returns {object} Progress estimator instance
 */
export function createProgressEstimator(options = {}) {
  const totalItems = options.totalItems || 0;
  const rollingWindow = options.rollingWindow || ROLLING_WINDOW_SIZE;

  const itemTimes = []; // Array of { itemIndex, durationMs }
  const stageTimes = []; // Array of { stageName, durationMs }
  let startTime = null;
  let currentItem = 0;
  let currentStage = '';
  let stageStartTime = null;

  return {
    /**
     * Start the timer.
     */
    start() {
      startTime = Date.now();
      stageStartTime = Date.now();
    },

    /**
     * Set the total number of items to process.
     * @param {number} total
     */
    setTotal(total) {
      totalItems = total;
    },

    /**
     * Get the total number of items.
     * @returns {number}
     */
    getTotal() {
      return totalItems;
    },

    /**
     * Set the current processing stage.
     * @param {string} stage - Stage name (e.g. "Fingerprinting ZIP Images", "Verifying with OpenAI")
     */
    setStage(stage) {
      if (currentStage && stageStartTime) {
        const elapsed = Date.now() - stageStartTime;
        stageTimes.push({ stageName: currentStage, durationMs: elapsed });
      }
      currentStage = stage;
      stageStartTime = Date.now();
    },

    /**
     * Get the current stage name.
     * @returns {string}
     */
    getCurrentStage() {
      return currentStage;
    },

    /**
     * Record completion of an item.
     * @param {number} itemIndex - Index of the completed item
     */
    completeItem(itemIndex) {
      currentItem = itemIndex + 1;
      if (startTime) {
        itemTimes.push({
          itemIndex,
          durationMs: Date.now() - startTime
        });
      }
    },

    /**
     * Get the current progress state.
     * @returns {{
     *   progressPercent: number,
     *   elapsedMs: number,
     *   estimatedTotalMs: number,
     *   estimatedRemainingMs: number,
     *   estimatedRemainingSec: number,
     *   etaString: string,
     *   avgTimePerItemMs: number,
     *   completedItems: number,
     *   totalItems: number,
     *   currentStage: string
     * }}
     */
    getProgress() {
      const now = Date.now();
      const elapsedMs = startTime ? (now - startTime) : 0;
      const completedItems = currentItem;
      const remainingItems = Math.max(0, totalItems - completedItems);

      // Calculate average time per item
      let avgTimePerItemMs = 0;

      if (itemTimes.length >= MIN_SAMPLES_FOR_ROLLING) {
        // Use rolling average of last N items
        const windowItems = itemTimes.slice(-rollingWindow);
        let totalDuration = 0;
        for (let i = 1; i < windowItems.length; i++) {
          totalDuration += windowItems[i].durationMs - windowItems[i - 1].durationMs;
        }
        avgTimePerItemMs = windowItems.length > 1
          ? totalDuration / (windowItems.length - 1)
          : 0;
      } else if (itemTimes.length > 0) {
        // Simple average
        avgTimePerItemMs = elapsedMs / itemTimes.length;
      } else if (totalItems > 0) {
        // No data yet — estimate based on elapsed time
        avgTimePerItemMs = elapsedMs / Math.max(1, completedItems);
      }

      // Calculate ETA
      const estimatedRemainingMs = avgTimePerItemMs > 0
        ? avgTimePerItemMs * remainingItems
        : 0;

      const estimatedTotalMs = elapsedMs + estimatedRemainingMs;

      // Progress percentage
      const progressPercent = totalItems > 0
        ? Math.min(100, Math.round((completedItems / totalItems) * 100))
        : 0;

      // Human-readable ETA string
      const etaString = formatDuration(estimatedRemainingMs);

      return {
        progressPercent,
        elapsedMs,
        estimatedTotalMs,
        estimatedRemainingMs,
        estimatedRemainingSec: Math.round(estimatedRemainingMs / 1000),
        etaString,
        avgTimePerItemMs: Math.round(avgTimePerItemMs),
        completedItems,
        totalItems,
        currentStage
      };
    },

    /**
     * Get stage timing breakdown.
     * @returns {Array<{ stageName: string, durationMs: number, durationSec: number }>}
     */
    getStageTimes() {
      const stages = [...stageTimes];
      if (currentStage && stageStartTime) {
        stages.push({
          stageName: currentStage,
          durationMs: Date.now() - stageStartTime,
          durationSec: Math.round((Date.now() - stageStartTime) / 1000)
        });
      }
      return stages.map(s => ({
        ...s,
        durationSec: Math.round(s.durationMs / 1000)
      }));
    },

    /**
     * Get a formatted summary string for logging.
     * @returns {string}
     */
    getSummary() {
      const p = this.getProgress();
      const stageTimes = this.getStageTimes();
      const stageSummary = stageTimes.map(s =>
        `${s.stageName}: ${s.durationSec}s`
      ).join(', ');

      return [
        `Progress: ${p.progressPercent}% (${p.completedItems}/${p.totalItems})`,
        `ETA: ${p.etaString}`,
        `Stage: ${p.currentStage}`,
        `Stages: ${stageSummary}`
      ].join(' | ');
    }
  };
}

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Formatted duration (e.g. "5 min 30 sec", "45 sec", "2 hr 15 min")
 */
export function formatDuration(ms) {
  if (ms <= 0) return '0 sec';

  const totalSeconds = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (hours > 0) parts.push(`${hours} hr`);
  if (minutes > 0) parts.push(`${minutes} min`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds} sec`);

  return parts.join(' ');
}

/**
 * Format a timestamp to a time string (HH:MM:SS).
 *
 * @param {Date|number} date - Date object or timestamp
 * @returns {string} Formatted time (e.g. "12:04:11")
 */
export function formatTimestamp(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toTimeString().slice(0, 8);
}

/**
 * Create a progress bar string for display.
 *
 * @param {number} percent - Progress percentage (0-100)
 * @param {number} [width=20] - Width of the progress bar in characters
 * @returns {string} Progress bar string (e.g. "[███████████░░░░░░░░░] 51%")
 */
export function createProgressBar(percent, width = 20) {
  const clampedPercent = Math.max(0, Math.min(100, percent));
  const filledWidth = Math.round((clampedPercent / 100) * width);
  const emptyWidth = width - filledWidth;

  const filled = '█'.repeat(filledWidth);
  const empty = '░'.repeat(emptyWidth);

  return `[${filled}${empty}] ${clampedPercent}%`;
}
