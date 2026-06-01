import { defineConfig } from 'vite';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function getDaemonUrl(): string {
  try {
    const pidFile = join(tmpdir(), 'codebrain-daemon.pid');
    const content = readFileSync(pidFile, 'utf-8').trim();
    const port = content.split('\n')[1];
    if (port) return `http://127.0.0.1:${port}`;
  } catch { /* daemon not running */ }
  return 'http://127.0.0.1:9999';
}

export default defineConfig({
  root: '.',
  base: '/',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: getDaemonUrl(),
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
