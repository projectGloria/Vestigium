import { createDemoServer } from './server.js';
const number = (key: string, fallback: number) => process.env[key] === undefined ? fallback : Number(process.env[key]);
const server = await createDemoServer({
  port: number('DEMO_PORT', 4173), hostPort: number('DEMO_HOST_PORT', 4174), seed: number('DEMO_SEED', 1),
  largeBytes: number('DEMO_LARGE_BYTES', 64 * 1024 * 1024),
  throttleBytesPerSecond: number('DEMO_THROTTLE_BPS', 0),
  rangeEnabled: process.env.DEMO_RANGE !== 'off', tokenLifetimeMs: number('DEMO_TOKEN_TTL_MS', 5000),
  sessionRequests: number('DEMO_SESSION_REQUESTS', 5), loginRequired: process.env.DEMO_LOGIN === '1',
});
console.log(`Vestigium demo: ${server.origin}\nFile host: ${server.hostOrigin}\nPress Ctrl+C to stop.`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void server.close().then(() => process.exit(0)));
