/**
 * Sessions routes (Phase 5).
 *
 * Mount point: /api (see src/app.js)
 *
 * Plan 05-03 ships:
 *   GET    /sessions
 *   DELETE /sessions/:id
 *
 * Plan 05-04 adds:
 *   GET /sessions/screenshots/:basename   (image proxy)
 *   GET /sessions/:id/export.md
 *   GET /sessions/:id/export.jsonl
 *   GET /sessions/:id                      (detail)
 *
 * Plan 05-05 will add:
 *   POST /sessions/:id/retrospective
 *
 * Route ordering — literal paths MUST come BEFORE bare `/sessions/:id`:
 *   list → screenshots/:basename → :id/export.md → :id/export.jsonl → :id (GET) → :id (DELETE)
 */
import express from 'express';
import sessionsController from '../controllers/sessions.controller.js';

const router = express.Router();

// ── Sessions (Phase 5) ───────────────────────────────────────────────
router.get('/sessions',                       (req, res) => sessionsController.list(req, res));
// Screenshot proxy — must come BEFORE /sessions/:id so 'screenshots' isn't matched as :id.
router.get('/sessions/screenshots/:basename', (req, res) => sessionsController.screenshotProxy(req, res));
// Exports — also more specific than the bare :id route, register first.
router.get('/sessions/:id/export.md',         (req, res) => sessionsController.exportMarkdown(req, res));
router.get('/sessions/:id/export.jsonl',      (req, res) => sessionsController.exportJsonl(req, res));
// Detail + delete
router.get('/sessions/:id',                   (req, res) => sessionsController.detail(req, res));
// Plan 05-05: retrospective AI critique stream trigger.
router.post('/sessions/:id/retrospective',    (req, res) => sessionsController.streamRetrospective(req, res));
router.delete('/sessions/:id',                (req, res) => sessionsController.remove(req, res));

export default router;
