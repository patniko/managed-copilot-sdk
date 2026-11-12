// Shared helper for the test scripts: an in-process Vite dev server with HMR and file
// watching disabled (NO_HMR), on a free port. Closing it is deterministic, so no
// orphaned servers keep serving stale code on a reused port. It serves the game only:
// the shop's checkout (its storefront code) and support need Downhill's own server
// (`pnpm dev` or `pnpm start`), which the happy path runs against.
import { createServer } from 'vite';

/** Where the scripts write screenshots and results (ignored by git). */
export const OUT = '.output';

/** Headless Edge (or DOWNHILL_BROWSER_CHANNEL) with WebGL on the GPU: the game crawls on a software rasterizer. */
export const browserOptions = {
  channel: process.env.DOWNHILL_BROWSER_CHANNEL ?? 'msedge',
  headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'win32' ? ['--use-angle=d3d11'] : []), '--autoplay-policy=no-user-gesture-required'],
};

export async function startServer(port = 5180) {
  process.env.NO_HMR = '1';
  const server = await createServer({
    logLevel: 'warn',
    clearScreen: false,
    server: { port, strictPort: false, host: '127.0.0.1' },
  });
  await server.listen();
  let url = server.resolvedUrls?.local[0] ?? `http://127.0.0.1:${server.config.server.port}/`;
  if (!url.endsWith('/')) url += '/';
  return { url, close: () => server.close() };
}

// Headless Edge occasionally never resolves browser.close(), which left test runs hanging
// after their results were printed. Bound every teardown step, then exit.
export async function shutdown(browser, server, code = 0) {
  const bounded = (p) => Promise.race([Promise.resolve(p).catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  if (browser) await bounded(browser.close());
  if (server) await bounded(server.close());
  process.exit(code);
}
