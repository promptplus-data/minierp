/** On-prem shift-close backup hook (docs/DEPLOY.md §4): runs BACKUP_SCRIPT -Reason shift-close, fire-and-forget. */
import { spawn } from 'node:child_process';
import type { FastifyBaseLogger } from 'fastify';

export function runBackupHook(script: string, log: FastifyBaseLogger, reason = 'shift-close'): void {
  try {
    const isPs1 = /\.ps1$/i.test(script);
    const [cmd, args] = isPs1
      ? [process.platform === 'win32' ? 'powershell.exe' : 'pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Reason', reason]]
      : [script, ['-Reason', reason]];
    // Not the server's DATABASE_URL: that role is RLS-restricted; backup.ps1 then uses the owner from secrets.json.
    const { DATABASE_URL: _serverDb, ...env } = process.env;
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, env });
    child.on('error', (err) => log.warn({ err, script }, 'backup hook failed to start'));
    child.on('exit', (code) => (code ? log.warn({ code, script }, 'backup hook exited with an error') : log.info({ script }, 'backup hook finished')));
    child.unref();
  } catch (err) {
    log.warn({ err, script }, 'backup hook failed to start');
  }
}
