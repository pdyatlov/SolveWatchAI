/**
 * ShutdownController — graceful drain trigger for GAP-05-01 (SESS-01 R-09).
 *
 * Why HTTP? The tray (electron/main.js onTrayStopAll) cannot deliver a POSIX
 * signal to the Node child on Windows — process.kill(pid, 'SIGTERM') on Win32
 * calls TerminateProcess, which is immediate (no SIGINT/SIGTERM handler fires).
 * See electron/main.js:61-64 comment + Node docs.
 *
 * This endpoint awaits sessionRecorder.shutdown('app_shutdown') so the JSONL
 * session_end footer is written BEFORE the tray proceeds to taskkill.
 *
 * Contract:
 *   - POST /api/shutdown
 *   - Body: ignored
 *   - Response: 200 {success:true, drained:<bool>} only AFTER drain completes.
 *   - Never throws to the HTTP layer — errors are logged + 500 returned.
 */
import logger from '../utils/logger.js';
import sessionRecorder from '../services/session-recorder.service.js';

const log = logger('ShutdownController');

class ShutdownController {
  async drain(req, res) {
    log.info('Shutdown drain requested via HTTP');
    try {
      // Idempotent: shutdown() returns immediately if no active session.
      await sessionRecorder.shutdown('app_shutdown');
      log.info('Shutdown drain complete');
      return res.status(200).json({ success: true, drained: true });
    } catch (err) {
      log.error('Shutdown drain failed', { error: err.message });
      return res.status(500).json({ success: false, drained: false, error: err.message });
    }
  }
}

export default new ShutdownController();
