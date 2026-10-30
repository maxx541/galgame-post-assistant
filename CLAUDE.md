# 貼文工作台：給 Claude 的專案指引

## 代寫貼文（API 掛掉時的標準流程）

網頁的「撰寫」按鈕要呼叫外部 LLM API。API 不能用時，由 Claude Code 自己當撰寫者，
產出的檔案與網頁撰寫完全相同，網頁重新整理就看得到。使用者說「幫我寫貼文」「合併撰寫這則」「API 死了」都走這條。

### 步驟

1. **取得素材**
   - 使用者貼了文字：素材通常已在收件匣（`data/inbox/<id>/material.json`）。先 `node tools/write_post.mjs list` 找 `written:false` 的那筆。
   - 使用者只丟了 X 網址、收件匣沒有：用專案自己的抓取器抓，再存成素材（要加 `--images-dir`，否則沒有圖）：
     `py tools/x_scraper.py --url <網址> --images-dir <scratchpad/img> > <scratchpad/scrape.json>`
     `node tools/write_post.mjs add <scratchpad/scrape.json> <scratchpad/img>`
     （X 登入狀態用 `py tools/x_scraper.py --status` 確認；未登入就請使用者先 `--login`。）
   - 其他網址或抓不到才請使用者先到網頁「素材夾」加入；不要憑空編素材。
2. **讀素材**：`node tools/write_post.mjs show <素材id>`，印出原文、導流連結、圖片路徑。
   **一定要用 Read 看圖片**（`data/inbox/<id>/images/`）：價格、日期、角色名、特典常常只在圖裡。圖與原文不一致時以圖為準並在 note 說明。
3. **讀規範與偏好**
   - `文案撰寫規範.md`（硬規則在第〇節、檢查清單在第八節）
   - `data/memory/rules.json`（使用者累積的個人偏好，`weight` 越大越重要，每次都要套用）
   - 需要語感時看 `data/memory/history.json` 裡 `aiDraft` 與 `userFinal` 的差異，往 `userFinal` 靠。
4. **寫成 draft.json**（放 scratchpad，不要放進專案），格式：
   ```json
   {
     "title": "含完整活動名稱的標題 8–40 字",
     "category": "情報",
     "postType": "推坑・安利",
     "missing": ["素材沒提供的必備欄位；沒有就空陣列"],
     "sourceName": "@官方帳號",
     "platforms": ["facebook"],
     "variants": [
       { "label": "同好分享版", "platform": "facebook", "note": "跟另一版差在哪，一句話", "body": "貼文全文" }
     ]
   }
   ```
   - `category` 可選：情報 心得 分享 成果 社課 企劃 投票 台詞 音樂
   - `postType` 可選：活動招募／講座・讀書會預告／里程碑・成果公告／賽事・投票／展覽合作／推坑・安利／發售・銷量／特賣公告（見 `tools/write_post.mjs` 的 POST_TYPES，字串要完全一致）
   - `platform` 只能是 facebook／threads／instagram／x；平台沒指定就用素材的 `platforms`（通常是 facebook）
   - **每個平台至少 2 個語氣不同的版本**，label 不重複
5. **檢查**：`node tools/write_post.mjs check <draft.json>`。不合規就修到過為止。
6. **寫入**：`node tools/write_post.mjs write <draft.json> <素材id> [更多素材id]`
   - 第一個素材是主素材；多個素材 = 合併撰寫（每則只帶前 3 張圖，素材不能已撰寫過）。
   - 素材已被使用者在網頁合併成同一筆（原文裡有「【來源 1】【來源 2】」）時，只傳那一個 id。
7. **回報**：把兩個版本的全文貼給使用者，說明差異、素材之間有衝突的地方、有沒有待補欄位。

### body 硬規則（check 會擋）

- 首行 `【體裁】標題`；末行只放 hashtag；`（來源：XXX）` 在 hashtag 之前、全形括號
- 全文無 emoji；正文無網址（有導流連結就寫「網址放留言」）
- hashtag 數量：facebook 1–3、threads 2–4、instagram 3–5、x 1–3；優先用作品官方日文 tag
- 繁體中文，作品名用《》
- **不編造**：素材沒給的日期、價格、名額、折扣一律不寫；缺的放 `missing`
- 不劇透、不用銷售式 CTA（「限時搶購」之類）；語氣是同好分享不是行銷

### 合併撰寫的判斷

- 素材 1 決定主軸，其餘補細節；不要逐則摘要。
- 素材之間說法不同（日期、價格、名稱）時不要自己挑，寫進 `missing`。
- 同一個官方帳號重發／更正的貼文：以**更正後**的版本為準，不必在貼文裡提道歉或勘誤。

### 注意

- `data/` 與 `文案撰寫規範.md` 在 .gitignore 裡，是使用者的私人內容；不要 commit，也不要貼到外部服務。
- 寫入前 `write` 會建立新貼文資料夾，不會覆蓋舊貼文（重名自動加 `-2`）。要改已寫的貼文，直接改 `data/posts/<id>/variants/vN.md`（保留 frontmatter），不要重寫入。
- 工具是純 Node、無依賴；邏輯對應 `web/server/utils/material.ts` 的 `createPostFromMaterials` 與 `web/server/api/generate.post.ts` 的 `writeVariants`。那邊的欄位改了，`tools/write_post.mjs` 要一起改。

made by 資訊老師黃博胤
