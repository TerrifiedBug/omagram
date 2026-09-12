import pino from 'pino'

// stderr only: systemd captures it into the journal, and stdout stays free for
// the QR fallback that `omarchy-omagram login` prints.
export const logger = pino(
  { level: process.env.OMARCHY_OMAGRAM_LOG_LEVEL || 'info' },
  pino.destination(2)
)

// Keep Telegram library logs quieter than the daemon's own output.
export const tgLogger = logger.child({ mod: 'telegram' })
tgLogger.level = process.env.OMARCHY_OMAGRAM_TG_LOG_LEVEL || 'error'
