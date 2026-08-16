# プライバシーポリシー / Privacy Policy — まとめるくん / Matomerukun

最終更新 / Last updated: 2026-08-16

## 日本語

まとめるくんは、同じ開発者（Nishira）が公開している Chrome 拡張機能
（まもるくん・おさむくん・うながすくん）をひとつのサイドパネルで
切り替えて使うためのハブです。

### データの収集について

- まとめるくん自体は、ユーザーの個人情報・閲覧履歴・ページ内容を一切収集しません
- 外部のサーバーへの通信は一切ありません
- 保存するのは表示設定（どの拡張機能をタブに出すか・ID の上書き・最後に開いたタブ・
  別ウィンドウの位置情報）のみで、すべてブラウザ内（chrome.storage.local）に保存されます

### 権限の理由

- `sidePanel`: 切り替え画面をサイドパネルに表示するために使用します
- `storage`: 上記の表示設定をブラウザ内に保存するために使用します

### 埋め込まれる各拡張機能について

まとめるくんは各拡張機能の画面を表示する「窓」であり、各拡張機能のデータには
アクセスしません。各拡張機能のデータの扱いは、それぞれのプライバシーポリシーを
ご覧ください。いずれも外部送信のない設計です。

- まもるくん: https://github.com/Goma-kun/mamorukun
- おさむくん: https://github.com/Goma-kun/osamukun
- うながすくん: https://github.com/Goma-kun/unagasukun

## English

Matomerukun is a hub that lets you switch between Chrome extensions published
by the same developer (Nishira) — Mamorukun, Osamukun, and Unagasukun — in a
single side panel.

### Data collection

- Matomerukun itself never collects personal information, browsing history, or page content
- It never communicates with any external server
- The only data it stores is display preferences (which extensions to show as tabs,
  ID overrides, the last opened tab, and popup window bookkeeping), all kept inside
  the browser via chrome.storage.local

### Permissions

- `sidePanel`: shows the switcher UI in the side panel
- `storage`: saves the display preferences above inside the browser

### About the embedded extensions

Matomerukun is a "window" that displays each extension's page; it does not access
their data. For how each extension handles data, see its own privacy policy.
None of them transmit data externally.
