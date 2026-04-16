/**
 * Shutdown route (Phase 5 gap closure — GAP-05-01).
 *
 * Mount point: /api (see src/app.js).
 * Contract: POST /shutdown → ShutdownController.drain.
 */
import express from 'express';
import shutdownController from '../controllers/shutdown.controller.js';

const router = express.Router();

router.post('/shutdown', (req, res) => shutdownController.drain(req, res));

export default router;
