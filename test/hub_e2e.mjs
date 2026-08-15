// まとめるくん結合検証：Chrome for Testing + CDP
// 4拡張をunpackedで読み込み、ハブからの iframe 埋め込み・タブ切替・
// 埋め込み時のボタン制御・切り離しウィンドウを実測する。
// 使い方:
//   CHROME_FOR_TESTING=<Chrome for Testingの実行ファイル> node test/hub_e2e.mjs
// Chrome for Testing は `npx @puppeteer/browsers install chrome@stable` で入れる
// （通常のChromeは --load-extension が無効化されていて使えない）
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CHROME = process.env.CHROME_FOR_TESTING;
if (!CHROME) {
  console.log('NG: 環境変数 CHROME_FOR_TESTING に Chrome for Testing のパスを入れてください');
  process.exit(1);
}
const SCRATCH = mkdtempSync(path.join(tmpdir(), 'hub-e2e-'));
// このファイルは matomerukun/test/ にある前提で、拡張4つの親フォルダを辿る
const BASE = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const EXTS = [
  `${BASE}/matomerukun/extension`,
  `${BASE}/Github-mamorukun/mamorukun/extension`,
  `${BASE}/osamukun/extension`,
  `${BASE}/unagasukun/extension`,
];
const HUB_ID = 'mdheihoolmkhoebieolpoacbfcmccnha';
const PORT = 9333;

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ok: ${name}`); }
  else { fail++; console.log(`  NG: ${name} ${detail}`); }
}

const chrome = spawn(CHROME, [
  `--user-data-dir=${SCRATCH}/profile`,
  `--load-extension=${EXTS.join(',')}`,
  `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--no-default-browser-check', '--disable-sync',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  'about:blank',
], { stdio: 'ignore' });

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
async function evalIn(sessionId, expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
async function allTargets() {
  return (await send('Target.getTargets', { filter: [{}] })).targetInfos;
}

await sleep(2000);

// ---- 1. 拡張のIDを特定する（SWのmanifestを見る）----
const sws = (await allTargets()).filter((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
const ids = {};
for (const t of sws) {
  const sid = await attach(t.targetId);
  const info = await evalIn(sid, `(() => { const m = chrome.runtime.getManifest(); return { name: m.name, v: m.version, perms: (m.permissions||[]).join(',') }; })()`);
  const id = new URL(t.url).host;
  if (info.name === 'まとめるくん') ids.hub = id;
  else if (info.perms.includes('alarms')) ids.unagasukun = id;
  else if (info.perms.includes('tabs')) ids.mamorukun = id;
  else if (info.perms.includes('sidePanel')) ids.osamukun = id;
}
console.log('拡張ID:', JSON.stringify(ids));
check('4拡張が読み込まれた', Object.keys(ids).length === 4);
check('ハブIDがkeyで固定されている', ids.hub === HUB_ID, `actual=${ids.hub}`);

// ---- 2. ハブにID上書きを保存（unpacked版のIDはストア版と違うため）----
const hubSw = sws.find((t) => new URL(t.url).host === ids.hub);
const hubSwSid = await attach(hubSw.targetId);
await evalIn(hubSwSid, `chrome.storage.local.set({ idOverrides: { mamorukun: '${ids.mamorukun}', osamukun: '${ids.osamukun}', unagasukun: '${ids.unagasukun}' } })`);

// ---- 3. ハブ画面を開く ----
const { targetId: hubTab } = await send('Target.createTarget', { url: `chrome-extension://${ids.hub}/hub.html` });
await sleep(1500);
const hub = await attach(hubTab);

const tabs = await evalIn(hub, `[...document.querySelectorAll('.tab')].map(b => b.dataset.key)`);
check('タブが3つ描画される', JSON.stringify(tabs) === JSON.stringify(['mamorukun', 'osamukun', 'unagasukun']), JSON.stringify(tabs));

// 3タブを順に開いてiframeを作らせる
for (const key of ['mamorukun', 'osamukun', 'unagasukun']) {
  await evalIn(hub, `document.querySelector('.tab[data-key="${key}"]').click()`);
  await sleep(1200);
}
const children = await evalIn(hub, `[...document.getElementById('frames').children].map(e => ({ tag: e.tagName, key: e.dataset.key, hidden: e.hidden }))`);
console.log('framesの中身:', JSON.stringify(children));
check('3つともiframeになった（案内表示なし）', children.length === 3 && children.every((c) => c.tag === 'IFRAME'));
check('表示中はうながすくんだけ', children.every((c) => c.hidden === (c.key !== 'unagasukun')));

// ---- 4. 埋め込まれた各拡張の中身を確認 ----
await sleep(1000);
const frames = (await allTargets()).filter((t) => t.type === 'iframe');
const frameOf = async (extId, page = 'sidepanel.html') => {
  const t = frames.find((f) => f.url === `chrome-extension://${extId}/${page}`);
  return t ? await attach(t.targetId) : null;
};

const osa = await frameOf(ids.osamukun);
check('おさむくんのiframeが生きている', !!osa);
if (osa) {
  check('おさむくん: 一覧が描画される', await evalIn(osa, `!!document.getElementById('templateList')`));
  check('おさむくん: 埋め込み時は⧉を出さない', await evalIn(osa, `document.getElementById('btnPopout').hidden === true`));
  check('おさむくん: chrome.storageが使える', await evalIn(osa, `chrome.storage.local.set({__probe:1}).then(() => chrome.storage.local.remove('__probe')).then(() => true)`));
  await evalIn(osa, `window.__hubMark = 1`);
}

const una = await frameOf(ids.unagasukun);
check('うながすくんのiframeが生きている', !!una);
if (una) {
  check('うながすくん: 今日の予定が描画される', await evalIn(una, `!!document.getElementById('today-list')`).catch(() => false)
    || await evalIn(una, `document.body.textContent.includes('予定')`));
  check('うながすくん: 埋め込み時は⧉を出さない', await evalIn(una, `document.getElementById('btn-popout').hidden === true`));
}

const mamo = await frameOf(ids.mamorukun);
check('まもるくんのiframeが生きている', !!mamo);
if (mamo) {
  check('まもるくん: 開始ボタンが描画される', await evalIn(mamo, `!!document.getElementById('toggle-btn')`));
  check('まもるくん: SpeechRecognitionが見える', await evalIn(mamo, `!!(window.SpeechRecognition || window.webkitSpeechRecognition)`));
  check('まもるくん: マイク権限がpromptかgranted', await evalIn(mamo, `navigator.permissions.query({name:'microphone'}).then(p => p.state !== 'denied')`));
}

// ---- 4.5 コピー機能（clipboard-write の委譲）----
// Permissions Policy の既定は self。allow で委譲しないと、埋め込まれた側の
// navigator.clipboard.writeText がすべて NotAllowedError になる（v0.2.1で修正）
// writeText はフォーカスされた文書からしか呼べないため、ハブの窓を前面に出し、
// 対象のタブを表示にしてから試す（そうしないと環境の都合で "Document is not focused" になる）
await send('Target.activateTarget', { targetId: hubTab });
await send('Page.bringToFront', {}, hub).catch(() => {});
for (const [name, key, sid] of [['まもるくん', 'mamorukun', mamo], ['おさむくん', 'osamukun', osa], ['うながすくん', 'unagasukun', una]]) {
  if (!sid) continue;
  check(`${name}: iframeにclipboard-writeが委譲されている`,
    await evalIn(sid, `document.featurePolicy.allowsFeature('clipboard-write')`));
  await evalIn(hub, `document.querySelector('.tab[data-key="${key}"]').click()`);
  await sleep(400);
  await evalIn(sid, `window.focus()`).catch(() => {});
  const w = await evalIn(sid, `navigator.clipboard.writeText('hub-copy-probe').then(() => 'ok').catch(e => e.name + ': ' + e.message)`);
  check(`${name}: iframe内でwriteTextが通る`, w === 'ok', w);
}

// ---- 5. タブを切り替えてもiframeが破棄されない（録音を止めないための要件）----
await evalIn(hub, `document.querySelector('.tab[data-key="osamukun"]').click()`);
await sleep(500);
await evalIn(hub, `document.querySelector('.tab[data-key="mamorukun"]').click()`);
await sleep(500);
await evalIn(hub, `document.querySelector('.tab[data-key="osamukun"]').click()`);
await sleep(500);
if (osa) {
  check('切替してもiframeが再読み込みされない', await evalIn(osa, `window.__hubMark === 1`));
}

// ---- 6. ハブの切り離しウィンドウ ----
await evalIn(hub, `document.getElementById('btnPopout').click()`);
await sleep(1500);
const popup = (await allTargets()).find((t) => t.type === 'page' && t.url.includes('hub.html?view=window'));
check('⧉で別ウィンドウが開く', !!popup);
if (popup) {
  const pop = await attach(popup.targetId);
  check('別ウィンドウ側は⇥を出す', await evalIn(pop, `document.getElementById('btnDock').hidden === false`));
  check('別ウィンドウ側は⧉を出さない', await evalIn(pop, `document.getElementById('btnPopout').hidden === true`));
  const popChildren = await evalIn(pop, `[...document.getElementById('frames').children].length`);
  check('別ウィンドウでも中身が表示される', popChildren >= 1);
}
const oldTab = (await allTargets()).find((t) => t.targetId === hubTab);
check('切り離し後、元のパネル側は閉じる', !oldTab || oldTab.url === '');

// ---- 7. タブの表示選択（enabledApps）----
if (popup) {
  const pop2 = await attach(popup.targetId);
  await evalIn(hubSwSid, `chrome.storage.local.set({ enabledApps: ['mamorukun', 'unagasukun'] })`);
  await evalIn(pop2, `location.reload()`).catch(() => {});
  await sleep(1500);
  const pop3 = await attach(popup.targetId);
  const tabs2 = await evalIn(pop3, `[...document.querySelectorAll('.tab')].map(b => b.dataset.key)`);
  check('表示選択がタブに反映される（おさむくんを外すと2つ）',
    JSON.stringify(tabs2) === JSON.stringify(['mamorukun', 'unagasukun']), JSON.stringify(tabs2));
  const active2 = await evalIn(pop3, `document.querySelector('.tab.active')?.dataset.key`);
  check('外した拡張が選択中でも、残りのタブに切り替わる', active2 === 'mamorukun' || active2 === 'unagasukun', active2);
}

console.log(`\n結果: ${pass} 件成功 / ${fail} 件失敗`);
chrome.kill();
process.exit(fail ? 1 : 0);
