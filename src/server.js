import http from 'http';
import { Server } from 'socket.io';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import app from './app.js';
import screenshotMonitorService from './services/screenshot-monitor.service.js';
import DataHandler from './sockets/dataHandler.js';
import imageProcessingService from './services/image-processing.service.js';
import { CONFIG } from './config/constants.js';
import logger from './utils/logger.js';
import sessionRecorder from './services/session-recorder.service.js';

const log = logger('Server');

// ── Clear logs on every startup ───────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILES_TO_CLEAR = ['app.jsonl', 'memory.jsonl', 'transcriber.log'];
try {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  for (const filename of LOG_FILES_TO_CLEAR) {
    const filepath = path.join(LOGS_DIR, filename);
    try { fs.writeFileSync(filepath, ''); } catch {}
  }
} catch {}

// Initialize services
try {
  screenshotMonitorService.start();
  log.debug('Screenshot monitoring service started');
} catch (error) {
  log.error('Failed to start screenshot monitoring service', error);
}

// HTTP server
const httpServer = http.createServer(app);

// Initialize Socket.io
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket'],
  allowEIO3: true,
});

// Setup WebSocket handlers
const dataHandler = new DataHandler(io);
imageProcessingService.setDataHandlers([dataHandler]);

// Security: bind to loopback only. The backend exposes unauthenticated
// endpoints (POST /api/shutdown drains the session recorder; GET
// /api/sessions/screenshots/* serves user screenshots) that must not be
// reachable from LAN/VPN peers. Electron HUD and Settings page both run
// on the same host.
httpServer.listen(CONFIG.PORT, '127.0.0.1', () => {
  log.info('Server started');
  log.info(`API: http://localhost:${CONFIG.PORT}`);
  log.info(`Data Updates: ws://localhost:${CONFIG.PORT}/data-updates`);
});

// Graceful shutdown handlers
const gracefulShutdown = async () => {
  log.info('Shutting down...');
  // Plan 05-01 / D-01 / Pitfall 1: drain session_end footer before exit.
  try {
    await sessionRecorder.shutdown('app_shutdown');
  } catch (err) {
    log.warn('Session recorder shutdown failed', { error: err.message });
  }
  screenshotMonitorService.stop && screenshotMonitorService.stop();

  if (httpServer) {
    httpServer.close(() => {
      log.info('Server closed');
      process.exit(0);
    });
  }

  setTimeout(() => {
    log.warn('Force exit');
    process.exit(1);
  }, 5000);
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
