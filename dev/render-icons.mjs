// アイコンの SVG を PNG に書き出す（開発用）。
// 使い方：cd dev && npm install && node render-icons.mjs
// インストール済みの Google Chrome で描画する（playwright-core の channel: 'chrome'）。
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const icons = path.join(root, 'icons');

const jobs = [
  { src: 'icon.svg', out: 'icon-192.png', size: 192 },
  { src: 'icon.svg', out: 'icon-512.png', size: 512 },
  { src: 'icon-maskable.svg', out: 'maskable-192.png', size: 192 },
  { src: 'icon-maskable.svg', out: 'maskable-512.png', size: 512 },
  { src: 'icon-maskable.svg', out: 'apple-touch-icon.png', size: 180 },
];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const job of jobs) {
  const svg = readFileSync(path.join(icons, job.src));
  const dataUrl = `data:image/svg+xml;base64,${svg.toString('base64')}`;
  await page.setViewportSize({ width: job.size, height: job.size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent"><img src="${dataUrl}" width="${job.size}" height="${job.size}" style="display:block"></body></html>`,
  );
  await page.waitForFunction(() => document.images[0].complete);
  const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: job.size, height: job.size } });
  writeFileSync(path.join(icons, job.out), png);
  console.log(`${job.out} (${job.size}x${job.size}, ${png.length} bytes)`);
}
await browser.close();
