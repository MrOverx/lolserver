/**
 * Centralized Logger Utility
 * Replaces mixed console.log / console.error / Logger calls
 * Provides consistent timestamp, context, and formatting across backend
 */

class Logger {
  static LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
  };

  static _currentLevel = Logger.LOG_LEVELS.INFO;

  /**
   * Set minimum log level for filtering output
   * @param {number} level - Log level threshold
   */
  static setLevel(level) {
    this._currentLevel = level;
  }

  /**
   * Core logging method - all others delegate to this
   * @param {number} level - Log level
   * @param {string} context - Context/module name
   * @param {string} message - Log message
   * @param {object} data - Optional data object
   */
  static _log(level, context, message, data = null) {
    if (level < this._currentLevel) return;

    const timestamp = new Date().toISOString();
    const levelName = Object.keys(this.LOG_LEVELS).find(k => this.LOG_LEVELS[k] === level);
    const logEntry = `[${timestamp}] [${levelName}] [${context}] ${message}`;

    const logFn = level === this.LOG_LEVELS.ERROR ? console.error : console.log;
    if (data) {
      logFn(logEntry, data);
    } else {
      logFn(logEntry);
    }
  }

  static debug(context, message, data = null) {
    this._log(this.LOG_LEVELS.DEBUG, context, message, data);
  }

  static info(context, message, data = null) {
    this._log(this.LOG_LEVELS.INFO, context, message, data);
  }

  static warn(context, message, data = null) {
    this._log(this.LOG_LEVELS.WARN, context, message, data);
  }

  static error(context, message, data = null) {
    this._log(this.LOG_LEVELS.ERROR, context, message, data);
  }
}

module.exports = { Logger };
