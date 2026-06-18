// Capture des maquettes de scènes overlay via Puppeteer (validation visuelle hors-ligne).
// usage: node _shot.js scene1 scene2 ...   (défaut : liste ci-dessous)
const puppeteer = require('puppeteer');

const scenes = process.argv.slice(2);
const list = scenes.length ? scenes
  : ['dashboard', 'grid', 'df-combo', 'fin-combo', 'dash-fin'];

(async () => {
  const browser = await puppeteer.launch({
    headless: 'shell',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--force-color-profile=srgb'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  for (const s of list) {
    await page.goto(`http://localhost:8099/overlay/demo/_render-test.html?scene=${s}`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 350));
    const out = `/tmp/shot-${s}.png`;
    await page.screenshot({ path: out });
    console.log('saved', out);
  }
  await browser.close();
})();
