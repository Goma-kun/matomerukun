// まとめるくん service worker
// ツールバーアイコンのクリックでサイドパネルを開く（おさむくん方式）
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error(e));

// 拡張機能を更新・再読み込みしたり、ブラウザを起動し直したりすると、
// 開いていた別ウィンドウは中身を失う。古いウィンドウIDが残っていると
// 次にサイドパネルを開いたときにそちらへ寄せようとしてしまうので消しておく
const STALE_WINDOW_KEYS = ['hubPopupWindowId', 'hubPopupOriginWindowId'];

function clearStaleWindowIds() {
  chrome.storage.local.remove(STALE_WINDOW_KEYS).catch(() => {
    // 消せなくても実害は小さい（ウィンドウが無ければ次の操作で作り直される）
  });
}

chrome.runtime.onInstalled.addListener(clearStaleWindowIds);
chrome.runtime.onStartup.addListener(clearStaleWindowIds);
