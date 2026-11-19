import { chromium } from 'playwright';
const PORT = process.env.PORT ?? '8791';
const url = process.env.URL ?? `http://127.0.0.1:${PORT}/public/warehouse.html`;
const b = await chromium.launch();
const ctx = await b.newContext({ ignoreHTTPSErrors: true });
const p = await ctx.newPage();
p.on('pageerror', e => console.log('ERR', e.message.slice(0,150)));
await p.goto(url, {waitUntil:'load'});
await p.waitForFunction(() => !!window.__wh, null, {timeout: 20000});
console.log(JSON.stringify(await p.evaluate(() => ({
  origin: location.origin,
  isSecureContext: window.isSecureContext,
  hasOPFS: !!navigator.storage?.getDirectory,
  hasLocks: !!navigator.locks,
  hasSAB: typeof SharedArrayBuffer !== 'undefined',
  crossOriginIsolated: window.crossOriginIsolated,
})), null, 1));
const init = await p.evaluate(() => Promise.race([
  window.__wh.init().then(r => 'role=' + r),
  new Promise(r => setTimeout(() => r('TIMEOUT'), 20000)),
]));
console.log('init:', init);
if (init.startsWith('role=')) {
  await p.evaluate(() => window.__wh.write(100));
  await p.evaluate(() => window.__wh.flush());
  console.log('count:', await p.evaluate(() => window.__wh.count()));
}
await b.close();
