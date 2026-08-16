// まとめるくんのストア用スクショ撮影：Chrome for Testing + CDP
// 4拡張をunpackedで読み込み、seedデータを入れてハブの実表示を撮る。
// 640x400 + deviceScaleFactor 2 で 1280x800 のPNGが直接出る（うながすくんの型）。
// 使い方:
//   CHROME_FOR_TESTING=<実行ファイル> node test/store_shots.mjs [--lang=en]
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CHROME = process.env.CHROME_FOR_TESTING;
if (!CHROME) {
  console.log('NG: 環境変数 CHROME_FOR_TESTING を設定してください');
  process.exit(1);
}
const LANG = process.argv.includes('--lang=en') ? 'en' : 'ja';
const SCRATCH = mkdtempSync(path.join(tmpdir(), 'hub-shots-'));
const BASE = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const OUT = path.join(BASE, 'matomerukun', 'store-assets');
mkdirSync(OUT, { recursive: true });
const EXTS = [
  `${BASE}/matomerukun/extension`,
  `${BASE}/Github-mamorukun/mamorukun/extension`,
  `${BASE}/osamukun/extension`,
  `${BASE}/unagasukun/extension`,
];
const PORT = 9334;

const args = [
  `--user-data-dir=${SCRATCH}/profile`,
  `--load-extension=${EXTS.join(',')}`,
  `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--no-default-browser-check', '--disable-sync',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  '--window-size=800,600',
];
if (LANG === 'en') args.push('--lang=en');
args.push('about:blank');
const chrome = spawn(CHROME, args, { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    wsUrl = (await res.json()).webSocketDebuggerUrl;
    break;
  } catch { /* まだ起動中 */ }
}
if (!wsUrl) { console.log('NG: Chromeが起動しない'); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((ok, ng) => { ws.onopen = ok; ws.onerror = ng; });
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { ok, ng } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? ng(new Error(msg.error.message)) : ok(msg.result);
  }
};
function send(method, params = {}, sessionId) {
  const id = ++seq;
  return new Promise((ok, ng) => {
    pending.set(id, { ok, ng });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
async function attach(targetId) {
  return (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
}
async function evalIn(sid, expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

await sleep(2000);

// ---- 拡張IDの特定（E2Eと同じ判定）----
const targets = (await send('Target.getTargets', { filter: [{}] })).targetInfos;
const sws = targets.filter((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
const ids = {};
const swSids = {};
for (const t of sws) {
  const sid = await attach(t.targetId);
  const info = await evalIn(sid, `(() => { const m = chrome.runtime.getManifest(); return { name: m.name, perms: (m.permissions||[]).join(',') }; })()`);
  const id = new URL(t.url).host;
  if (info.name === 'まとめるくん' || info.name === 'Matomerukun') { ids.hub = id; swSids.hub = sid; }
  else if (info.perms.includes('alarms')) { ids.unagasukun = id; swSids.unagasukun = sid; }
  else if (info.perms.includes('tabs')) { ids.mamorukun = id; swSids.mamorukun = sid; }
  else if (info.perms.includes('sidePanel')) { ids.osamukun = id; swSids.osamukun = sid; }
}
console.log('拡張ID:', JSON.stringify(ids));
if (Object.keys(ids).length !== 4) { console.log('NG: 4拡張そろわない'); process.exit(1); }

// ---- seed（各拡張のSWから chrome.storage.local に入れる。必ずIIFEで包む）----
await evalIn(swSids.hub, `(async () => {
  await chrome.storage.local.set({ idOverrides: {
    mamorukun: '${ids.mamorukun}', osamukun: '${ids.osamukun}', unagasukun: '${ids.unagasukun}',
  }});
  return true;
})()`);

await evalIn(swSids.osamukun, `(async () => {
  await chrome.storage.local.set({ templates: [
    { id: 't1', category: '案内', title: 'オフィス移転のご案内', body: 'お世話になっております。\\nこのたび、下記のとおりオフィスを移転することとなりましたのでご案内申し上げます。' },
    { id: 't2', category: 'お礼', title: 'お問い合わせへのお礼', body: 'このたびはお問い合わせいただき、誠にありがとうございます。' },
    { id: 't3', category: 'サポート', title: '再起動のお願い', body: 'お手数ですが、いったんパソコンを再起動してから、もう一度お試しいただけますでしょうか。' },
    { id: 't4', category: 'サポート', title: '画面共有のご案内', body: 'よろしければ画面を拝見しながらご案内いたします。共有の許可をお願いいたします。' },
  ]});
  return true;
})()`);

await evalIn(swSids.unagasukun, `(async () => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const hm = (d) => pad(d.getHours()) + ':' + pad(d.getMinutes());
  const dk = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  // 進行中ブロック。日付またぎの表示崩れを避けるため、終了は同日23:59でクランプする
  const t1 = new Date(now.getTime() - 20 * 60000);
  let t1e = new Date(now.getTime() + 10 * 60000);
  if (t1e.getDate() !== now.getDate()) { t1e = new Date(now); t1e.setHours(23, 59, 0, 0); }
  const t3 = new Date(now.getTime() - 3 * 3600000);
  const stretchLabel = t3.getHours() < 11 ? '朝のストレッチ' : t3.getHours() < 17 ? '昼のストレッチ' : '夜のストレッチ';
  await chrome.storage.local.set({
    schedule: [
      { id: 's1', time: hm(t1), endTime: hm(t1e), label: '資料づくり', days: [], date: dk(now), enabled: true },
      { id: 's3', time: hm(t3), label: stretchLabel, days: [], date: dk(now), enabled: true },
    ],
    records: { [dk(now)]: { s3: 'done' } },
  });
  return true;
})()`);

// ---- ハブをタブで開いて撮影 ----
const opened = await send('Target.createTarget', { url: `chrome-extension://${ids.hub}/hub.html` });
const pageSid = await attach(opened.targetId);
await send('Page.enable', {}, pageSid);
await send('Emulation.setDeviceMetricsOverride', {
  width: 640, height: 400, deviceScaleFactor: 2, mobile: false,
}, pageSid);
await sleep(1500);

async function shot(name) {
  await sleep(800);
  const r = await send('Page.captureScreenshot', { format: 'png' }, pageSid);
  writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
  console.log('saved:', name);
}
async function activateTab(key) {
  await evalIn(pageSid, `document.querySelector('.tab[data-key="${key}"]').click()`);
  await sleep(1500);
}

// 注: macOSのChrome for Testingは --lang=en でUI言語が切り替わらない
// （chrome.i18nはシステム言語に従う）ため、英語UIのスクショは撮れない。
// 4枚目はハブ固有の設定画面（表示する拡張の選択）にする。
await activateTab('unagasukun');
await shot('screenshot_01.png');
await activateTab('osamukun');
await shot('screenshot_02.png');
await activateTab('mamorukun');
await shot('screenshot_03.png');
// 設定画面。ID欄は空にして撮る（プレースホルダ＝ストア版ID表示。
// 撮影環境のunpacked版ID上書きを見せない）。DOMだけ書き換え、保存はしない
await evalIn(pageSid, `document.getElementById('btnSettings').click()`);
await evalIn(pageSid, `(() => {
  for (const el of document.querySelectorAll('#settingsFields input[type=text]')) el.value = '';
  return true;
})()`);
await shot('screenshot_04.png');

chrome.kill();
console.log('完了');
process.exit(0);
