/**
 * ✅ MONGODB CONNECTION MANAGER
 * Handles connection retries, pooling, and graceful fallbacks
 */

const mongoose = require('mongoose');
const { Logger } = require('./logger');

class MongoDBManager {
  constructor() {
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 2000; // Start with 2 seconds
    this.maxReconnectDelay = 30000; // Cap at 30 seconds
    this.connectionStartTime = null;
  }

  /**
   * Initialize MongoDB connection with exponential backoff retry
   * @param {string} mongodbUri - MongoDB connection string
   * @param {object} options - Mongoose connection options
   * @returns {Promise<boolean>} - True if connected, false if failed
   */
  async connect(mongodbUri, options = {}) {
    if (!mongodbUri) {
      Logger.error('MongoDBManager', 'MongoDB URI is required');
      return false;
    }

    // Default options with optimizations
    const defaultOptions = {
      maxPoolSize: 15,
      minPoolSize: 5,
      socketTimeoutMS: 45000,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000,
      retryWrites: true,
      retryReads: true,
      writeConcern: { w: 'majority' },
      ...options,
    };

    this.connectionStartTime = Date.now();

    try {
      // Mask the URI for logging
      const safeUri = mongodbUri.replace(/^(mongodb(?:\+srv)?:\/\/)([^@]+@)?/, '$1****@');
      Logger.info('MongoDBManager', `🔄 Connecting to MongoDB...`, { uri: safeUri });

      await mongoose.connect(mongodbUri, defaultOptions);

      this.isConnected = true;
      this.reconnectAttempts = 0;

      const connectionTime = (Date.now() - this.connectionStartTime) / 1000;
      Logger.info('MongoDBManager', `✅ Connected to MongoDB`, {
        connectionTimeSeconds: connectionTime.toFixed(2),
        poolSize: defaultOptions.maxPoolSize,
      });

      return true;
    } catch (err) {
      Logger.error('MongoDBManager', `❌ MongoDB connection failed`, {
        error: err.message,
        attempt: this.reconnectAttempts + 1,
        willRetry: this.reconnectAttempts < this.maxReconnectAttempts,
      });

      this.isConnected = false;
      return false;
    }
  }

  /**
   * Attempt to reconnect with exponential backoff
   * @param {string} mongodbUri - MongoDB connection string
   * @param {object} options - Mongoose connection options
   * @returns {Promise<boolean>}
   */
  async reconnect(mongodbUri, options = {}) {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      Logger.error('MongoDBManager', '❌ Max reconnection attempts reached');
      return false;
    }

    // Calculate exponential backoff delay
    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );

    this.reconnectAttempts++;

    Logger.warn('MongoDBManager', `⏳ Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})`, {
      delayMs: delay,
    });

    return new Promise((resolve) => {
      setTimeout(() => {
        this.connect(mongodbUri, options).then(resolve);
      }, delay);
    });
  }

  /**
   * Check if database is connected
   * @returns {boolean}
   */
  getConnectionStatus() {
    const readyState = mongoose.connection.readyState;
    // 1 = connected, 2 = connecting, 0 = disconnected, 3 = disconnecting
    return readyState === 1;
  }

  /**
   * Get connection stats
   * @returns {object}
   */
  getStats() {
    const readyState = mongoose.connection.readyState;
    const stateLabels = {
      0: 'disconnected',
      1: 'connected',
      2: 'connecting',
      3: 'disconnecting',
    };

    return {
      state: stateLabels[readyState] || 'unknown',
      stateCode: readyState,
      isConnected: readyState === 1,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts,
      connectionUptime: this.isConnected
        ? (Date.now() - this.connectionStartTime) / 1000
        : 0,
    };
  }

  /**
   * Close connection gracefully
   * @returns {Promise<void>}
   */
  async disconnect() {
    try {
      if (this.getConnectionStatus()) {
        await mongoose.connection.close();
        this.isConnected = false;
        Logger.info('MongoDBManager', '✅ MongoDB connection closed gracefully');
      }
    } catch (err) {
      Logger.error('MongoDBManager', 'Error closing MongoDB connection', err.message);
    }
  }
}

// Export singleton instance
const mongoDBManager = new MongoDBManager();

module.exports = { MongoDBManager, mongoDBManager };
