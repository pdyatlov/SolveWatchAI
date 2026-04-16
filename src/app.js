import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import imageRoutes from './routes/image.routes.js';
import contextRoutes from './routes/context.routes.js';
import configRoutes from './routes/config.routes.js';
import sessionsRoutes from './routes/sessions.routes.js';
import shutdownRoutes from './routes/shutdown.routes.js';
import {
  errorHandler,
  notFoundHandler,
} from './middleware/error.middleware.js';
import { CONFIG } from './config/constants.js';
import logger from './utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

dotenv.config();

const log = logger('App');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static assets from src/public
app.use(express.static(path.join(__dirname, 'public')));

// Browser settings page (must be before notFoundHandler)
app.get('/settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

// API Routes
app.use('/api', imageRoutes);
app.use('/api', contextRoutes);
app.use('/api', configRoutes);
app.use('/api', sessionsRoutes);
app.use('/api', shutdownRoutes);

// Error handling middleware (must be last)
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
