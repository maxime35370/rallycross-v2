import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = 'file://' + path.join(__dirname, 'showcase.html');
const scenes = ['race', 'standings', 'grid', 'next', 'intermission'];

const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--force-color-profile=srgb'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });

for (const s of scenes) {
  await page.goto(`${file}?scene=${s}`, { waitUntil: 'networkidle0' });
  try { await page.evaluate(() => document.fonts.ready); } catch {}
  await new Promise(r => setTimeout(r, 500));
  const out = path.join(__dirname, `preview-${s}.png`);
  await page.screenshot({ path: out });
  console.log('✓', out);
}
await browser.close();
console.log('done');
