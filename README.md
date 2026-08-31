# 貼文工作台

社群粉專的貼文製作工具。**收素材 → AI 依規範撰寫 → 檢查 → 發佈到 Facebook／Instagram／Threads**，全部在本機跑，資料存在自己的資料夾裡。

原本是為「GalGame文化同好會」寫的，但撰寫規範是一個可替換的 Markdown 檔（`文案撰寫規範.md`），改那份就等於改寫作行為，不用動程式。

---

## 這是什麼

一條完整的產線：

```
發掘 ── 自動找素材（Notion 日報 / 新聞網站 RSS / 推特追蹤帳號）
  ↓
素材夾 ── 貼連結自動抓內文與圖，或自己貼文字
  ↓
AI 撰寫 ── 依規範判斷體裁、寫出多個語氣版本
  ↓
貼文 ── 潤稿、排圖、規範檢查
  ↓
發佈 ── FB / IG / Threads，可立即或排程
```

**本機工具**：後端直接讀寫這個資料夾、會開本機瀏覽器與檔案總管，不能部署到雲端。

---

## 需求

| | 版本 | 用途 |
|---|---|---|
| Node.js | 20 以上 | 主程式 |
| Python | 3.10 以上 | 只有讀推特要用（Playwright） |

AI 撰寫需要一組 **OpenAI 相容的 Chat Completions** 端點與金鑰。預設指向 Google Gemini 的相容端點，換成 OpenRouter、本機 gateway 或別家都可以，只要改設定。

---

## 開始

**Windows**：雙擊 `啟動.bat`，第一次會自動裝套件，跑起來自動開瀏覽器。

**其他系統**或想自己跑：

```bash
npm run install:web     # 第一次
npm run dev             # http://localhost:4321
```

根目錄的 `package.json` 只是轉發指令，真正的 Nuxt 專案在 `web/`，兩邊執行都可以。

打開之後到**設定**頁填 API 金鑰，就能用了。其餘（推特、Facebook、Notion、新聞網站）都是可選的，用到哪個接哪個。

---

## 各頁在做什麼

### 發掘

三個來源並排，各自抓取、各自排程、各自捲動：

| 來源 | 怎麼抓 | 排序 |
|---|---|---|
| **Notion 日報** | 讀你 Notion 裡的每日彙整頁 | 照日報原本的順序，不計分 |
| **新聞網站** | RSS 優先，沒有就爬列表頁 | 照發佈時間，不計分 |
| **推特** | Playwright 讀追蹤帳號的時間軸 | **依分數排序**，過門檻自動收進素材夾 |

推特的計分只看硬指標，不呼叫 AI：瀏覽數、互動數、時效、主題關鍵字，再對轉推／回覆／短文／沒中關鍵字打折。權重和門檻可以在設定裡調。

新聞網站填首頁網址就好，會自己找 RSS 位址（`<link rel=alternate>`，找不到就試 `/feed/`）。沒有 RSS 的站會退到爬列表頁，用「同網域、路徑帶數字 id、連結文字夠長」挑出文章再逐篇讀。日系成人向網站（Getchu、DLsite、DMM）的年齡確認與 EUC-JP 編碼都有處理。

### 素材夾

兩種收法：**貼連結**（自動抓標題、內文、圖片、來源）或**本地素材**（自己貼文字與圖）。

一次可以貼多個連結。抓取跑在伺服器的背景工作上，切到別頁、關掉分頁都不影響，回來進度還在。

底部有統一的批量列：全選、AI 撰寫、批量刪除、清掉已撰寫的。刪除會連圖片資料夾一起移除。

### 貼文

- 多個語氣版本分頁切換，可以鎖定某版不被重新撰寫覆蓋
- 圖片**拖曳換順序**，左上角數字就是發佈順序；沒勾的發佈時跳過
- 即時的規範檢查（硬規定／建議分級）
- **反饋優化**：改完稿按一下，AI 會比對它的原稿和你的終稿，把你的偏好記進記憶庫，之後撰寫會帶上

### 發佈

勾選要發的平台，沒接好的會直接說明原因（未連接／沒有圖／字數超過）。發佈時逐平台顯示進度。

| 平台 | 立即 | 排程 |
|---|---|---|
| Facebook | ✓ | **交給 Meta**（電腦關機照發）或本機排程 |
| Instagram | ✓ | 只能本機排程 |
| Threads | ✓ | 只能本機排程 |

IG 與 Threads 的 API 只吃公開網址的圖片，不能直接上傳檔案。工具的做法是先把圖以未發佈方式傳到 Facebook 取得 CDN 網址，餵給對方之後再把暫存照片刪掉——不需要另外辦圖床。

**本機排程要工具開著才會發**，因為 IG 的排程參數鎖在 Meta 白名單、Threads 根本沒有這個功能。Facebook 因此保留「交給 Meta」的選項。

---

## 設定

### AI 撰寫

設定頁填 **Base URL、API 金鑰、模型名稱**。也可以改用環境變數：把 `web/.env.example` 複製成 `web/.env`，填 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`，環境變數優先。

### 推特讀取

X 對未登入的請求幾乎全擋，所以走 Playwright + 瀏覽器憑證重用。先裝：

```bash
py -m pip install playwright
py -m playwright install chromium
```

然後在設定頁按「登入 X」，會開一個 Chromium 讓你登入，登入狀態存在 `data/.browser/x`，之後每次抓取都重用。

### Facebook / Instagram / Threads

需要一個 Meta App 與粉專的 **Page Access Token**。設定頁有連接流程，支援系統用戶 token（永久）與一般 User Token（換成長期，約 60 天）。

> **⚠ App 一定要切成「上線」模式。** 開發模式下，App 發到 Facebook 專頁的貼文**只有 App 的角色成員看得到**，別人開起來是「目前無法查看此內容」——而且從 API 完全看不出異常（`is_published` 是 true、隱私是「所有人」）。工具會比對「工具發的貼文」與「其他貼文」的互動數，偵測到疑似狀況會在設定頁警告。Instagram 不受這個限制。

Instagram 要商業／創作者帳號連到同一個粉專，設定頁可以自動偵測帳號 ID。Threads 走自己的 OAuth，要另外一組 token。

### Notion 日報

到 Notion Integrations 建一個 internal integration，把 token 填進設定，然後**在日報那幾頁按「⋯ → 連接」把 integration 加進去**（沒分享的頁面 API 讀不到）。

預期的格式是每則情報三行：內容／`日期 ｜ 廠商（作品）`／連結。解析是依格式不是依順序，所以行的先後不影響。

---

## 撰寫規範

`文案撰寫規範.md` 就是送給模型的 system prompt 全文。**改那份 = 改寫作行為**，不用動程式。設定頁可以直接編輯，存檔會自動備份成 `.bak`。

規範檢查（貼文頁那個面板）分兩級：硬規定會標紅，建議只提醒。**檢查不會擋住發佈**——總會有特例，工具沒立場替你決定。但平台的硬限制（Threads 500 字、IG 一定要有圖）還是會擋，因為那些送出去一定失敗。

---

## 資料

全部存在 `data/`，都是純文字與圖片，沒有資料庫：

```
data/
  settings.json        金鑰與各平台設定（已 gitignore）
  inbox/<id>/          素材：material.json + images/
  posts/<id>/          貼文：post.json + variants/*.md + images/
  discover/            候選池、追蹤來源、已讀紀錄
  memory/              反饋優化學到的規則
  schedule.json        本機排程佇列
  jobs.json            背景工作狀態
  logs/                後台日誌（每天一個 .jsonl）
  .browser/            Playwright 的登入 profile（已 gitignore）
```

`data/` 整個在 `.gitignore` 裡——那是你自己的內容，而且圖片很快就幾百 MB。程式第一次跑會自己建這些資料夾。

---

## 測試

```bash
npm test        # 需要 dev server 開著
npm run build
```

端對端測試，直接打真的 API 與檔案系統，不用 mock。跑之前先 `npm run dev`。

---

## 已知限制

- **本機排程要工具開著。** IG／Threads 沒有排程 API，只有 Facebook 可以交給 Meta。
- **IG 與 Threads 的圖片走 Facebook CDN 中轉。** 那是 Meta 的簽章網址，哪天改規則就得換成真的圖床。
- **推特抓取會佔用瀏覽器**，一個帳號約一分鐘，追蹤數量多的話一輪要不少時間，而且連太兇會被 X 限流。設定裡有帳號間隔可以調。
- **新聞網站爬列表頁時常常拿不到發佈時間**，那種情況時效不列入判斷。
- 撰寫規範是中文社群導向的，換題材要自己重寫那份文件。

---

## 專案結構

```
啟動.bat              Windows 啟動器（純 ASCII，邏輯在 tools/start.ps1）
文案撰寫規範.md        送給模型的 system prompt
tools/
  x_scraper.py        Playwright 推特抓取
  start.ps1           啟動邏輯
web/
  app/pages/          發掘、素材夾、貼文、設定、日誌
  app/components/     進度條、預覽卡、規範檢查面板
  server/api/         端點
  server/utils/       核心邏輯（計分、抓取、LLM、發佈、排程）
  server/plugins/     排程器
  test/e2e.mjs        測試
```

`server/utils/` 裡的純函式刻意不依賴 Nitro 的 auto-import，這樣測試可以直接 import 它們。
