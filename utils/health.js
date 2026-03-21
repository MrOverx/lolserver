/**
 * Health Check Utility
 * Monitors server health and provides status information
 * 
 * Usage:
 * const health = require('./utils/health');
 * health.startMonitoring();
 * app.get('/health', health.handleHealthCheck);
 */

const { Logger } = require('./logger');

class HealthMonitor {
  constructor() {
    this.startTime = Date.now();
    this.status = 'initializing';
    this.lastUpdate = Date.now();
    this.metrics = {
      uptime: 0,
      memoryUsage: 0,
      dbConnected: false,
      socketConnections: 0,
      requestCount: 0,
      errorCount: 0,
    };
    this.services = new Map();
  }

  /**
   * Register a service for health monitoring
   * @param {string} name - Service name
   * @param {Function} checkFn - Async function that returns { status, message }
   */
  registerService(name, checkFn) {
    this.services.set(name, {
      checkFn,
      status: 'unknown',
      lastCheck: null,
      lastError: null,
    });
    Logger.info('health', `Registered service: ${name}`);
  }

  /**
   * Check health of all registered services
   */
  async checkAllServices() {
    const results = {};

    for (const [name, service] of this.services.entries()) {
      try {
        const result = await service.checkFn();
        results[name] = {
          status: result.status,
          message: result.message,
          lastCheck: new Date().toISOString(),
        };
        service.status = result.status;
        service.lastCheck = Date.now();
        service.lastError = null;
      } catch (err) {
        results[name] = {
          status: 'unhealthy',
          message: err.message,
          lastCheck: new Date().toISOString(),
        };
        service.status = 'unhealthy';
        service.lastError = err.message;
      }
    }

    return results;
  }

  /**
   * Get current health status
   */
  async getStatus() {
    this.lastUpdate = Date.now();
    this.metrics.uptime = Math.floor((Date.now() - this.startTime) / 1000);
    this.metrics.memoryUsage = process.memoryUsage().heapUsed / 1024 / 1024; // MB

    const services = await this.checkAllServices();

    // Determine overall status
    const unhealthyServices = Object.values(services).filter(s => s.status !== 'healthy');
    this.status = unhealthyServices.length === 0 ? 'healthy' : 'degraded';

    return {
      status: this.status,
      timestamp: new Date().toISOString(),
      uptime: `${this.metrics.uptime}s`,
      memory: `${this.metrics.memoryUsage.toFixed(2)}MB`,
      nodeVersion: process.version,
      environment: process.env.NODE_ENV || 'development',
      services,
    };
  }

  /**
   * Express route handler for health check
   */
  handleHealthCheck = async (req, res) => {
    try {
      const status = await this.getStatus();

      if (status.status === 'healthy') {
        res.status(200).json({
          success: true,
          ...status,
        });
      } else {
        res.status(503).json({
          success: false,
          ...status,
        });
      }
    } catch (err) {
      Logger.error('health', 'Health check error', err.message);
      res.status(500).json({
        success: false,
        status: 'error',
        message: 'Health check failed',
      });
    }
  };

  /**
   * Increment request counter
   */
  recordRequest() {
    this.metrics.requestCount++;
  }

  /**
   * Increment error counter
   */
  recordError() {
    this.metrics.errorCount++;
  }

  /**
   * Update socket connection count
   */
  updateSocketConnections(count) {
    this.metrics.socketConnections = count;
  }

  /**
   * Update DB connection status
   */
  setDbConnected(connected) {
    this.metrics.dbConnected = connected;
  }

  /**
   * Get metrics summary
   */
  getSummary() {
    return {
      status: this.status,
      uptime: this.metrics.uptime,
      memory: this.metrics.memoryUsage.toFixed(2),
      requests: this.metrics.requestCount,
      errors: this.metrics.errorCount,
      socketConnections: this.metrics.socketConnections,
      dbConnected: this.metrics.dbConnected,
    };
  }

  /**
   * Log health summary
   */
  logSummary() {
    const summary = this.getSummary();
    Logger.info('health', 'Health Summary', summary);
  }

  /**
   * Start periodic monitoring
   */
  startMonitoring(intervalSeconds = 60) {
    setInterval(() => {
      this.getStatus().then(() => {
        Logger.debug('health', 'Health check complete', {
          status: this.status,
          uptime: `${this.metrics.uptime}s`,
        });
      });
    }, intervalSeconds * 1000);

    Logger.info('health', `Health monitoring started (${intervalSeconds}s interval)`);
  }
}

// Create singleton instance
const healthMonitor = new HealthMonitor();

module.exports = healthMonitor;
module.exports.HealthMonitor = HealthMonitor;
