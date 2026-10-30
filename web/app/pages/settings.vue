<template>
  <div class="page settings">
    <h1 class="h1" style="margin-bottom: 14px">設定</h1>

    <section class="card pad stack" style="margin-bottom: 18px">
      <div class="row">
        <strong class="h2">撰寫用的 API</strong>
        <span class="spacer grow" />
        <span v-if="s?.hasKey" class="badge solid" style="background: var(--ok)">
          金鑰已設定（{{ s.source === 'env' ? '環境變數' : '本機檔案' }}）
        </span>
        <span v-else class="badge solid" style="background: var(--warn)">尚未設定金鑰</span>
      </div>
      <p class="small muted" style="margin: 0">
        走 OpenAI 相容的 Chat Completions 介面，Base URL 與金鑰都可自訂。預設指向 Google Gemini 的相容端點；
        換成 OpenRouter、本機 gateway 或別家，只要改這裡。
      </p>

      <div class="field">
        <label>Base URL</label>
        <input v-model="form.baseUrl" type="url" class="mono" spellcheck="false" placeholder="https://…/v1" />
        <span class="tiny faint">
          實際會打：<code class="mono">{{ previewEndpoint }}</code>
          <template v-if="form.baseUrl.trim() !== defaults.baseUrl">
            ・<a href="#" @click.prevent="form.baseUrl = defaults.baseUrl">還原預設</a>
          </template>
        </span>
      </div>

      <div class="field">
        <label>API 金鑰</label>
        <input
          v-model="form.apiKey"
          type="password"
          class="mono"
          autocomplete="off"
          :placeholder="s?.hasKey ? '已儲存，留空表示不更動' : 'AIza… 或 sk-…'"
        />
        <span class="tiny faint">
          存在 <code class="mono">data/settings.json</code>（已 gitignore），前端不會把金鑰讀回來。
        </span>
      </div>

      <div class="row wrap" style="gap: 10px; align-items: flex-end">
        <div class="field grow" style="min-width: 220px">
          <label>模型</label>
          <input v-model="form.model" type="text" class="mono" list="model-list" spellcheck="false" />
          <datalist id="model-list">
            <option v-for="m in models" :key="m" :value="m" />
          </datalist>
        </div>
        <label class="chk" :class="{ on: form.sendImages }">
          <input v-model="form.sendImages" type="checkbox" />送圖給模型看
        </label>
      </div>

      <div class="row wrap" style="gap: 8px">
        <button class="primary" :disabled="busy" @click="save">儲存</button>
        <button :disabled="busy || (!s?.hasKey && !form.apiKey.trim())" @click="test">
          {{ testing ? '測試中…' : '測試連線並列出模型' }}
        </button>
        <button v-if="s?.hasKey && s.source === 'file'" class="danger" :disabled="busy" @click="clearKey">
          清除金鑰
        </button>
      </div>

      <p v-if="msg" class="small" :class="msgErr ? 'm-err' : 'm-ok'">{{ msg }}</p>

      <div v-if="models.length" class="modelbox">
        <div class="tiny muted" style="margin-bottom: 5px">端點提供 {{ models.length }} 個模型，點一下填入：</div>
        <div class="row wrap" style="gap: 5px">
          <button
            v-for="m in shownModels"
            :key="m"
            class="sm mono"
            :class="{ primary: m === form.model }"
            @click="form.model = m"
          >
            {{ m }}
          </button>
          <button v-if="models.length > shownModels.length" class="ghost sm" @click="showAll = true">
            還有 {{ models.length - shownModels.length }} 個…
          </button>
        </div>
      </div>

      <p v-if="s?.source === 'env'" class="tiny muted" style="margin: 0">
        目前金鑰是從環境變數／<code class="mono">web/.env</code> 讀到的，優先於這裡存的值。
      </p>
      <details class="small">
        <summary class="muted">改用環境變數</summary>
        <p class="tiny muted" style="margin: 6px 0 0">
          把 <code class="mono">web/.env.example</code> 複製成 <code class="mono">web/.env</code>，
          填 <code class="mono">LLM_BASE_URL</code>、<code class="mono">LLM_API_KEY</code>、
          <code class="mono">LLM_MODEL</code>，重啟 dev server。
        </p>
      </details>
    </section>

    <section class="card pad stack" style="margin-bottom: 18px">
      <div class="row">
        <strong class="h2">推特（X）讀取</strong>
        <span class="spacer grow" />
        <span v-if="x?.loggedIn" class="badge solid" style="background: var(--ok)">已登入</span>
        <span v-else-if="x?.python && x?.scriptFound" class="badge solid" style="background: var(--warn)">未登入</span>
        <span v-else class="badge solid" style="background: var(--err)">環境未就緒</span>
      </div>
      <p class="small muted" style="margin: 0">
        X 對未登入的請求幾乎全擋，所以推特網址走 <strong>Playwright（Python）+ 瀏覽器憑證重用</strong>：
        登入一次，登入狀態存在 <code class="mono">data/.browser/x</code>，之後每次抓推文都重用同一份 profile。
        抓到的內文會帶進素材說明，撰寫時一起注入提示詞。
      </p>

      <ul class="small" style="margin: 0; padding-left: 20px">
        <li :class="x?.python ? 'ok-li' : 'bad-li'">Python：{{ x?.python || '找不到' }}</li>
        <li :class="x?.scriptFound ? 'ok-li' : 'bad-li'">tools/x_scraper.py：{{ x?.scriptFound ? '找到了' : '找不到' }}</li>
        <li :class="x?.loggedIn ? 'ok-li' : 'warn-li'">
          登入狀態：{{ x?.loggedIn ? '已登入，可以直接抓' : '尚未登入' }}
          <span v-if="x?.checkedAt" class="faint">（最後確認 {{ new Date(x.checkedAt).toLocaleString('zh-TW') }}）</span>
        </li>
      </ul>

      <div class="row wrap" style="gap: 8px">
        <button class="primary" :disabled="xBusy || !x?.python || !x?.scriptFound" @click="xLoginNow">
          {{ xBusy ? '等待登入中…（瀏覽器視窗）' : x?.loggedIn ? '重新登入' : '開啟瀏覽器登入 X' }}
        </button>
        <button :disabled="xBusy" @click="deepCheck">{{ xChecking ? '檢查中…' : '重新檢查登入狀態' }}</button>
      </div>
      <p v-if="xBusy" class="tiny gen-wait">
        會跳出一個 Chromium 視窗，在裡面登入 X 即可，偵測到登入就會自動關閉（最多等 10 分鐘）。
      </p>
      <p v-if="xMsg" class="small" :class="xErr ? 'm-err' : 'm-ok'">{{ xMsg }}</p>
      <details v-if="!x?.python || !x?.scriptFound" class="small">
        <summary class="muted">環境沒就緒？</summary>
        <p class="tiny muted" style="margin: 6px 0 0">
          需要 Python 3.10 以上，然後在專案資料夾執行：<br />
          <code class="mono">py -m pip install playwright</code><br />
          <code class="mono">py -m playwright install chromium</code>
        </p>
      </details>
    </section>

    <section class="card pad stack" style="margin-bottom: 18px">
      <div class="row">
        <strong class="h2">Facebook／Instagram 讀取</strong>
        <span class="spacer grow" />
        <span v-if="sc?.loggedIn?.fb" class="badge solid" style="background: var(--ok)">FB 已登入</span>
        <span v-else class="badge solid" style="background: var(--warn)">FB 未登入</span>
        <span v-if="sc?.loggedIn?.ig" class="badge solid" style="background: var(--ok)">IG 已登入</span>
        <span v-else class="badge solid" style="background: var(--warn)">IG 未登入</span>
      </div>
      <p class="small muted" style="margin: 0">
        跟推特同一個路數：貼上 Facebook 或 Instagram 貼文網址時走
        <strong>Playwright（Python）+ 瀏覽器憑證重用</strong>。兩邊是同一個 Meta 帳號體系，
        共用 <code class="mono">data/.browser/meta</code> 一份 profile，各自登入一次即可。
        沒登入也抓得到公開貼文的摘要，但內文會被截斷、輪播圖只拿得到第一張。
      </p>

      <ul class="small" style="margin: 0; padding-left: 20px">
        <li :class="sc?.python ? 'ok-li' : 'bad-li'">Python：{{ sc?.python || '找不到' }}</li>
        <li :class="sc?.scriptFound ? 'ok-li' : 'bad-li'">
          tools/social_scraper.py：{{ sc?.scriptFound ? '找到了' : '找不到' }}
        </li>
        <li :class="sc?.loggedIn?.fb ? 'ok-li' : 'warn-li'">
          Facebook：{{ sc?.loggedIn?.fb ? '已登入' : '尚未登入' }}
        </li>
        <li :class="sc?.loggedIn?.ig ? 'ok-li' : 'warn-li'">
          Instagram：{{ sc?.loggedIn?.ig ? '已登入' : '尚未登入' }}
          <span v-if="sc?.checkedAt" class="faint">（最後確認 {{ new Date(sc.checkedAt).toLocaleString('zh-TW') }}）</span>
        </li>
      </ul>

      <div class="row wrap" style="gap: 8px">
        <button class="primary" :disabled="scBusy || !sc?.python || !sc?.scriptFound" @click="socialLoginNow('fb')">
          {{ scBusy === 'fb' ? '等待登入中…（瀏覽器視窗）' : sc?.loggedIn?.fb ? '重新登入 Facebook' : '開啟瀏覽器登入 Facebook' }}
        </button>
        <button :disabled="scBusy || !sc?.python || !sc?.scriptFound" @click="socialLoginNow('ig')">
          {{ scBusy === 'ig' ? '等待登入中…（瀏覽器視窗）' : sc?.loggedIn?.ig ? '重新登入 Instagram' : '開啟瀏覽器登入 Instagram' }}
        </button>
        <button :disabled="!!scBusy" @click="socialDeepCheck">
          {{ scChecking ? '檢查中…' : '重新檢查登入狀態' }}
        </button>
      </div>
      <p v-if="scBusy" class="tiny gen-wait">
        會跳出一個 Chromium 視窗，在裡面登入即可，偵測到登入就會自動關閉（最多等 10 分鐘）。
      </p>
      <p v-if="scMsg" class="small" :class="scErr ? 'm-err' : 'm-ok'">{{ scMsg }}</p>
    </section>

    <section class="card pad stack" style="margin-bottom: 18px">
      <div class="row">
        <strong class="h2">Facebook 專頁發佈</strong>
        <span class="spacer grow" />
        <span v-if="fb?.connected" class="badge solid" style="background: var(--ok)">已連接：{{ fb.pageName }}</span>
        <span v-else class="badge">尚未連接</span>
      </div>

      <template v-if="fb?.connected">
        <p class="small muted" style="margin: 0">
          貼文頁可以直接發到「{{ fb.pageName }}」（{{ fb.pageId }}），支援立即／草稿／排程，
          導流連結會自動貼成第一則留言。
        </p>
        <div v-if="fbToken" class="tokenbox small">
          <div :class="fbToken.valid ? 'm-ok' : 'm-err'">
            Token {{ fbToken.valid ? '有效' : '無效' }}｜{{ fbToken.neverExpires ? '不會過期' : ('到期 ' + fbToken.expiresAt) }}
          </div>
          <div v-if="fbToken.missing?.length" class="m-err tiny">缺少權限：{{ fbToken.missing.join('、') }}</div>
          <div v-else class="tiny muted">權限齊全</div>
        </div>
        <div class="row wrap" style="gap: 8px">
          <button :disabled="fbBusy" @click="checkToken">{{ fbChecking ? '檢查中…' : '檢查連線與權限' }}</button>
          <button class="danger" :disabled="fbBusy" @click="disconnect">中斷連接</button>
        </div>
      </template>

      <template v-else>
        <div class="ways">
          <button class="way" :class="{ on: fbWay === 'system' }" @click="fbWay = 'system'">
            系統用戶 Token<span class="tiny">永久有效・推薦</span>
          </button>
          <button class="way" :class="{ on: fbWay === 'user' }" @click="fbWay = 'user'">
            一般 User Token<span class="tiny">約 60 天</span>
          </button>
        </div>

        <ol v-if="fbWay === 'system'" class="small muted steps">
          <li>
            <a href="https://developers.facebook.com/apps" target="_blank">Meta for Developers</a>
            建立「<strong>商業</strong>」類型的應用程式，在「設定 → 基本資料」拿 <strong>App ID</strong> 與 <strong>App Secret</strong>。
          </li>
          <li>
            <a href="https://business.facebook.com/settings" target="_blank">企業管理平台 → 企業設定</a>
            確認粉專已加進這個企業，並在「帳號 → 應用程式」把上面那個 App 也加進來。
          </li>
          <li>
            「使用者 → <strong>系統用戶</strong>」新增一個系統用戶（角色選管理員），
            用「<strong>指派資產</strong>」把粉專指派給他，權限勾<strong>管理粉絲專頁</strong>。
          </li>
          <li>
            按「<strong>產生新的權杖</strong>」，選剛才那個 App，
            <strong>到期時間選「永不」</strong>，勾下面這些權限後產生，把權杖貼過來。
          </li>
        </ol>

        <ol v-else class="small muted steps">
          <li>
            <a href="https://developers.facebook.com/apps" target="_blank">Meta for Developers</a>
            建立「<strong>商業</strong>」類型的應用程式，在「設定 → 基本資料」拿 App ID 與 App Secret。
          </li>
          <li>
            <a href="https://developers.facebook.com/tools/explorer" target="_blank">Graph API Explorer</a>
            選這個 App，勾下面的權限後按 Generate Access Token，把 token 貼過來（短期的就好，程式會自動換長期）。
          </li>
        </ol>

        <div class="scopes">
          <code v-for="sc in fb?.requiredScopes || []" :key="sc" class="mono tiny">{{ sc }}</code>
        </div>
        <p class="tiny muted" style="margin: 0">
          <code class="mono">pages_manage_engagement</code> 是自動貼留言用的，少了它「網址放留言」就只能手動。
        </p>

        <div class="field">
          <label>App ID</label>
          <input v-model="fbForm.appId" type="text" class="mono sm-in" spellcheck="false" />
        </div>
        <div class="field">
          <label>App Secret</label>
          <input v-model="fbForm.appSecret" type="password" class="mono sm-in" autocomplete="off" />
        </div>
        <div class="field">
          <label>{{ fbWay === 'system' ? '系統用戶權杖' : 'User Token' }}</label>
          <input v-model="fbForm.userToken" type="password" class="mono sm-in" autocomplete="off" />
        </div>
        <div class="row wrap" style="gap: 10px">
          <div class="field" style="width: 130px">
            <label>Graph 版本</label>
            <input v-model="fbForm.graphVersion" type="text" class="mono sm-in" />
          </div>
          <div class="field grow" style="min-width: 180px">
            <label>粉專 ID（選填，列不出來時直接指定）</label>
            <input v-model="fbForm.pageId" type="text" class="mono sm-in" placeholder="專頁 → 關於 → 頁面透明度" />
          </div>
        </div>
        <button class="primary" :disabled="fbBusy || !fbForm.appId || !fbForm.appSecret || !fbForm.userToken" @click="connect">
          {{ fbBusy ? '連接中…' : '連接' }}
        </button>

        <div v-if="fbPages.length" class="stack" style="gap: 6px">
          <strong class="small">選一個要發佈的專頁</strong>
          <button v-for="p in fbPages" :key="p.id" class="pagepick" :disabled="fbBusy" @click="pickPage(p.id)">
            <strong>{{ p.name }}</strong>
            <span class="tiny faint mono">{{ p.id }}{{ p.category ? '｜' + p.category : '' }}</span>
          </button>
        </div>
      </template>

      <div v-if="fb?.appMode?.likelyHidden" class="devwarn">
        <strong>⚠ 發到 Facebook 的貼文可能只有你看得到</strong>
        <p style="margin: 4px 0 0">
          {{ fb.appMode.hint }}
          到 <a href="https://developers.facebook.com/apps" target="_blank">App 後台</a>
          左側的「發佈」把 App 切成上線，切完舊貼文也會變公開。
        </p>
      </div>
      <p v-if="fbMsg" class="small" :class="fbErr ? 'm-err' : 'm-ok'">{{ fbMsg }}</p>
    </section>

    <section class="card pad stack" style="margin-bottom: 18px">
      <div class="row">
        <strong class="h2">Instagram 與 Threads</strong>
        <span class="spacer grow" />
        <span class="badge" :class="pf?.instagram.connected ? 'solid' : ''"
          :style="pf?.instagram.connected ? 'background: var(--ok)' : ''">
          IG {{ pf?.instagram.connected ? '已設定' : '未設定' }}
        </span>
        <span class="badge" :class="pf?.threads.connected ? 'solid' : ''"
          :style="pf?.threads.connected ? 'background: var(--ok)' : ''">
          Threads {{ pf?.threads.connected ? '已設定' : '未設定' }}
        </span>
      </div>

      <p class="small muted" style="margin: 0">
        三個平台各發各的，API 沒有「同步發佈」。IG 與 Threads 的圖片會先經由 Facebook 轉成公開網址再送出。
      </p>

      <!-- Instagram -->
      <div class="platbox stack">
        <div class="row">
          <strong class="small">Instagram</strong>
          <span v-if="pf?.instagram.username" class="tiny muted">@{{ pf.instagram.username }}</span>
        </div>
        <p class="tiny muted" style="margin: 0">
          需要 IG <b>商業／創作者帳號</b>連到上面那個專頁，Page Token 要有
          <code class="mono">{{ (pf?.igScopes || []).join('、') }}</code> 權限。
        </p>
        <div class="row wrap" style="gap: 8px">
          <div class="field grow">
            <label>Instagram 商業帳號 ID</label>
            <input v-model="pfForm.igUserId" type="text" class="sm-in mono" placeholder="留空可按自動偵測" />
          </div>
          <button class="sm" style="align-self: flex-end" :disabled="pfBusy || !pf?.fbConnected" @click="igDetect">
            {{ pfBusy === 'detect' ? '偵測中…' : '自動偵測' }}
          </button>
          <button class="sm" style="align-self: flex-end" :disabled="pfBusy || !pfForm.igUserId" @click="igTest">
            {{ pfBusy === 'ig' ? '測試中…' : '測試連線' }}
          </button>
        </div>
      </div>

      <!-- Threads -->
      <div class="platbox stack">
        <div class="row">
          <strong class="small">Threads</strong>
          <span v-if="pf?.threads.username" class="tiny muted">@{{ pf.threads.username }}</span>
        </div>
        <p class="tiny muted" style="margin: 0">
          Threads 走<b>自己的 OAuth 與網域</b>（<code class="mono">graph.threads.net</code>），
          <b>不吃 Facebook 的 Page Token</b>，要另外拿一組。到
          <a href="https://developers.facebook.com/apps" target="_blank">App 後台</a>
          加 Threads 產品、授權 <code class="mono">threads_basic</code> 與
          <code class="mono">threads_content_publish</code> 之後產生。
          使用者 ID 留空的話，測試連線時會用 <code class="mono">me</code> 問回來自動填。
        </p>
        <div class="row wrap" style="gap: 8px">
          <div class="field" style="width: 220px">
            <label>Threads 使用者 ID</label>
            <input v-model="pfForm.threadsUserId" type="text" class="sm-in mono" placeholder="留空自動取得" />
          </div>
          <div class="field grow">
            <label>Threads Access Token{{ pf?.threads.hasToken ? '（已儲存，留空表示不更動）' : '' }}</label>
            <input v-model="pfForm.threadsToken" type="password" class="sm-in mono" autocomplete="off" placeholder="THQ…" />
          </div>
          <button class="sm" style="align-self: flex-end"
            :disabled="pfBusy || !(pf?.threads.hasToken || pfForm.threadsToken)" @click="threadsTest">
            {{ pfBusy === 'threads' ? '測試中…' : '測試連線' }}
          </button>
        </div>
      </div>

      <div class="row wrap" style="gap: 8px">
        <button class="primary" :disabled="!!pfBusy" @click="savePlatforms">儲存</button>
        <button v-if="pf?.threads.hasToken" class="danger" :disabled="!!pfBusy" @click="clearThreads">
          清除 Threads token
        </button>
      </div>
      <p v-if="pfMsg" class="small" :class="pfErr ? 'm-err' : 'm-ok'">{{ pfMsg }}</p>
    </section>

    <section class="card pad stack" style="margin-bottom: 18px">
      <div class="row">
        <strong class="h2">定期清理</strong>
        <span class="spacer grow" />
        <span v-if="cl?.enabled" class="badge solid" style="background: var(--ok)">
          每 {{ cl.intervalDays }} 天自動清理
        </span>
        <span v-else class="badge">未開啟</span>
      </div>
      <p class="small muted" style="margin: 0">
        貼文與素材越積越多，列表頁就越慢（每次都會把整個資料夾讀一遍，圖片也是原尺寸存的）。
        開啟後工具每 {{ clForm.intervalDays }} 天會把超過保留天數的資料夾整個刪掉，<strong>刪了無法復原</strong>。
        還有排程在等的貼文一律不刪。
      </p>
      <p v-if="cl" class="tiny faint" style="margin: 0">
        目前佔用：貼文 {{ mb(cl.usage.posts) }}・素材 {{ mb(cl.usage.inbox) }}
      </p>

      <div class="row wrap" style="gap: 10px; align-items: flex-end">
        <label class="chk" :class="{ on: clForm.enabled }">
          <input v-model="clForm.enabled" type="checkbox" />開啟定期清理
        </label>
        <div class="field" style="width: 120px">
          <label>每幾天一次</label>
          <input v-model.number="clForm.intervalDays" type="number" min="1" max="90" />
        </div>
      </div>

      <div class="platbox stack">
        <div class="row wrap" style="gap: 10px; align-items: flex-end">
          <label class="chk" :class="{ on: clForm.posts.enabled }">
            <input v-model="clForm.posts.enabled" type="checkbox" />清理貼文
          </label>
          <div class="field" style="width: 150px">
            <label>保留最近幾天</label>
            <input v-model.number="clForm.posts.keepDays" type="number" min="1" :disabled="!clForm.posts.enabled" />
          </div>
          <label class="chk" :class="{ on: clForm.posts.onlyPublished }">
            <input v-model="clForm.posts.onlyPublished" type="checkbox" :disabled="!clForm.posts.enabled" />只刪已發佈的
          </label>
        </div>
        <span class="tiny faint">以貼文「最後修改時間」判斷新舊。取消「只刪已發佈的」會連沒發出去的草稿一起刪。</span>
      </div>

      <div class="platbox stack">
        <div class="row wrap" style="gap: 10px; align-items: flex-end">
          <label class="chk" :class="{ on: clForm.inbox.enabled }">
            <input v-model="clForm.inbox.enabled" type="checkbox" />清理素材
          </label>
          <div class="field" style="width: 150px">
            <label>保留最近幾天</label>
            <input v-model.number="clForm.inbox.keepDays" type="number" min="1" :disabled="!clForm.inbox.enabled" />
          </div>
          <label class="chk" :class="{ on: clForm.inbox.onlyWritten }">
            <input v-model="clForm.inbox.onlyWritten" type="checkbox" :disabled="!clForm.inbox.enabled" />只刪已撰寫的
          </label>
        </div>
        <span class="tiny faint">以素材「收進來的時間」判斷新舊。已撰寫的素材內容與圖都已複製到貼文裡了。</span>
      </div>

      <div v-if="cl" class="tokenbox small">
        <div>
          照目前<strong>已儲存</strong>的設定，現在清會刪：貼文 <strong>{{ cl.preview.posts.length }}</strong> 則、素材
          <strong>{{ cl.preview.inbox.length }}</strong> 則
          <a v-if="cl.preview.posts.length + cl.preview.inbox.length" href="#" @click.prevent="clShowList = !clShowList">
            {{ clShowList ? '收起' : '看清單' }}
          </a>
        </div>
        <ul v-if="clShowList" class="tiny muted" style="margin: 6px 0 0; padding-left: 18px; max-height: 200px; overflow-y: auto">
          <li v-for="t in [...cl.preview.posts, ...cl.preview.inbox]" :key="t.kind + t.id">
            [{{ t.kind === 'posts' ? '貼文' : '素材' }}] {{ t.title }}<span class="faint">・{{ t.at.slice(0, 10) }}</span>
          </li>
        </ul>
        <div class="tiny faint" style="margin-top: 4px">
          <template v-if="cl.lastResult">
            上次清理 {{ when(cl.lastResult.at) }}：貼文 {{ cl.lastResult.posts }}、素材 {{ cl.lastResult.inbox }}，釋出 {{ mb(cl.lastResult.bytes) }}
          </template>
          <template v-else>還沒清理過</template>
          <template v-if="cl.nextAt">・下次預定 {{ when(cl.nextAt) }}（工具要開著）</template>
        </div>
      </div>

      <div class="row wrap" style="gap: 8px">
        <button class="primary" :disabled="clBusy" @click="saveCleanup">儲存</button>
        <button class="danger" :disabled="clBusy || !cl || !(cl.preview.posts.length + cl.preview.inbox.length)" @click="runCleanupNow">
          立即清理
        </button>
      </div>
    </section>

    <section class="card pad stack" style="margin-bottom: 18px">
      <div class="row">
        <strong class="h2">記憶庫（反饋優化）</strong>
        <span class="spacer grow" />
        <span v-if="mem?.rules.length" class="badge solid" style="background: var(--ok)">
          {{ mem.rules.length }} 條規則
        </span>
        <span v-else class="badge">還沒有規則</span>
      </div>
      <p class="small muted" style="margin: 0">
        在貼文頁按「反饋優化」時，AI 會比對它的原稿與你改完的終稿，把你的個人偏好記在這裡。
        之後每次撰寫，這些規則會跟著《文案撰寫規範》一起送出去。規則的優先度低於規範。
      </p>

      <div v-if="mem?.rules.length" class="rules">
        <div v-for="r in mem.rules" :key="r.id" class="rule row">
          <span class="badge cat">{{ r.category }}</span>
          <span class="grow">{{ r.rule }}</span>
          <span class="tiny faint" :title="`觀察到 ${r.weight} 次`">×{{ r.weight }}</span>
          <button class="ghost sm danger" title="刪掉這條" @click="delRule(r.id)">刪</button>
        </div>
      </div>
      <p v-else class="tiny faint" style="margin: 0">
        還沒學到東西。去改一則 AI 寫的貼文，然後按那頁下方的「反饋優化」。
      </p>

      <div class="row wrap" style="gap: 8px">
        <span class="tiny faint grow">已累積 {{ mem?.historyCount || 0 }} 組修訂範例</span>
        <button v-if="mem?.injected" class="ghost sm" @click="showInjected = !showInjected">
          {{ showInjected ? '收起' : '看實際注入的內容' }}
        </button>
        <button v-if="mem?.rules.length" class="danger sm" @click="clearMem">清空記憶庫</button>
      </div>
      <pre v-if="showInjected && mem?.injected" class="injected tiny">{{ mem.injected }}</pre>
    </section>

    <section class="card pad stack">
      <strong class="h2">撰寫行為</strong>
      <p class="small muted" style="margin: 0">
        送出去的 system prompt 就是 <code class="mono">文案撰寫規範.md</code> 全文，
        改規範就等於改撰寫行為，不用動程式。
      </p>
      <ul class="small muted" style="margin: 0; padding-left: 20px">
        <li>只有沒鎖定的版本會被覆寫；打勾「鎖定」的版本永遠保留。</li>
        <li>模型不會編造素材沒給的日期、價格、名額，缺的會列進「待補」。</li>
        <li>產出後仍然要看編輯器的規範檢查——那是程式化的第二道關。</li>
        <li>端點若不支援 json_schema 或看圖，系統會自動退回相容模式並在結果列告訴你。</li>
        <li>記憶庫的規則會接在規範後面一起注入，衝突時以規範為準。</li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
interface Settings {
  baseUrl: string
  model: string
  sendImages: boolean
  hasKey: boolean
  source: 'env' | 'file' | 'none'
  defaults: { baseUrl: string; model: string }
  endpoint: string
}

const { toast, toastErr } = useToast()
const { data: s, refresh } = await useFetch<Settings>('/api/settings')

const defaults = computed(() => s.value?.defaults || { baseUrl: '', model: '' })
const form = reactive({
  baseUrl: s.value?.baseUrl || '',
  apiKey: '',
  model: s.value?.model || '',
  sendImages: s.value?.sendImages ?? true
})
const busy = ref(false)
const testing = ref(false)
const msg = ref('')
const msgErr = ref(false)
const models = ref<string[]>([])

interface XStatus {
  python: string | null; scriptFound: boolean; ready: boolean; loggedIn: boolean
  profile: string; checkedAt: string; deep: boolean; message: string
}
const { data: x, refresh: refreshX } = await useFetch<XStatus>('/api/x/status')
const xChecking = ref(false)

/** 真的開一次 Chromium 驗證登入是否還有效 */
async function deepCheck() {
  xChecking.value = true
  xMsg.value = ''
  try {
    const d = await $fetch<XStatus>('/api/x/status', { query: { deep: '1' } })
    x.value = d
    xErr.value = !d.loggedIn
    xMsg.value = d.loggedIn ? '登入仍然有效' : d.message || '目前未登入'
  } catch (e) {
    xErr.value = true
    xMsg.value = err(e)
  } finally {
    xChecking.value = false
  }
}

interface AppMode {
  likelyHidden: boolean; hasPrivacyPolicy: boolean; hasCategory: boolean
  appPosts: number; appPostsWithZero: number; otherMedian: number
  hint: string; appName: string
}
interface FbStatus {
  connected: boolean; hasApp: boolean; pageId: string; pageName: string
  graphVersion: string; defaults: { graphVersion: string }; requiredScopes: string[]
  tokenCheckedAt: string
  token: null | { valid: boolean; neverExpires: boolean; expiresAt: string; missing: string[] }
  appMode?: AppMode | null
}
// 帶 deep 才會真的去問 Meta —— 開發模式的檢查在那裡面
const { data: fb, refresh: refreshFb } = await useFetch<FbStatus>('/api/meta/status', {
  query: { deep: 1 }
})
const fbWay = ref<'system' | 'user'>('system')
const fbForm = reactive({
  appId: '',
  appSecret: '',
  userToken: '',
  pageId: '',
  graphVersion: fb.value?.graphVersion || 'v21.0'
})
const fbPages = ref<{ id: string; name: string; category: string }[]>([])
const fbBusy = ref(false)
const fbChecking = ref(false)
const fbMsg = ref('')
const fbErr = ref(false)
const fbToken = ref<FbStatus['token']>(null)

async function connect() {
  fbBusy.value = true
  fbMsg.value = ''
  try {
    const r = await $fetch<{
      pages: { id: string; name: string; category: string }[]
      missing: string[]; tokenKind: string; tokenDesc: string; listError: string
    }>('/api/meta/connect', { method: 'POST', body: { ...fbForm } })
    fbPages.value = r.pages
    fbErr.value = r.missing.length > 0 || r.pages.length === 0
    const kind = r.tokenKind === 'system' ? '系統用戶 token' : '長期 User Token'
    if (r.missing.length) {
      fbMsg.value = `連上了（${kind}，${r.tokenDesc}），但缺少權限：${r.missing.join('、')}。補勾後重新產生 token。`
    } else if (!r.pages.length) {
      fbMsg.value =
        `連上了（${kind}），但列不出任何專頁。` +
        (r.listError ? `（${r.listError}）` : '') +
        '系統用戶請確認已用「指派資產」把粉專指派給他；或在上面填粉專 ID 直接指定。'
    } else {
      fbMsg.value = `連上了（${kind}，${r.tokenDesc}），找到 ${r.pages.length} 個專頁，選一個。`
    }
    fbForm.userToken = ''
  } catch (e) {
    fbErr.value = true
    fbMsg.value = err(e)
  } finally {
    fbBusy.value = false
  }
}

async function pickPage(pageId: string) {
  fbBusy.value = true
  try {
    const r = await $fetch<{ pageName: string }>('/api/meta/page', { method: 'POST', body: { pageId } })
    fbPages.value = []
    await refreshFb()
    fbErr.value = false
    fbMsg.value = `已連接「${r.pageName}」，貼文頁就可以直接發佈了。`
    toast('Facebook 已連接')
  } catch (e) {
    fbErr.value = true
    fbMsg.value = err(e)
  } finally {
    fbBusy.value = false
  }
}

async function checkToken() {
  fbChecking.value = true
  fbBusy.value = true
  try {
    const d = await $fetch<FbStatus>('/api/meta/status', { query: { deep: '1' } })
    fbToken.value = d.token
    fbErr.value = !d.token?.valid || (d.token?.missing?.length || 0) > 0
    fbMsg.value = d.token?.valid ? '連線正常' : 'Token 已失效，需要重新連接'
  } catch (e) {
    fbErr.value = true
    fbMsg.value = err(e)
  } finally {
    fbChecking.value = false
    fbBusy.value = false
  }
}

async function disconnect() {
  if (!confirm('中斷連接？App ID、Secret 與 token 都會從本機刪掉。')) return
  await $fetch('/api/meta', { method: 'DELETE' })
  fbToken.value = null
  fbPages.value = []
  await refreshFb()
  fbMsg.value = '已中斷連接'
  fbErr.value = false
}

interface PlatformsSt {
  fbConnected: boolean
  instagram: { userId: string; username: string; connected: boolean }
  threads: { userId: string; username: string; hasToken: boolean; connected: boolean }
  igScopes: string[]
}
const { data: pf, refresh: refreshPlatforms } = await useFetch<PlatformsSt>('/api/meta/platforms')
const pfForm = reactive({
  igUserId: pf.value?.instagram.userId || '',
  threadsUserId: pf.value?.threads.userId || '',
  threadsToken: ''
})
/** '' 沒在忙；其餘是正在跑哪一項，按鈕文字才分得開 */
const pfBusy = ref('')
const pfMsg = ref('')
const pfErr = ref(false)

async function savePlatforms(silent = false) {
  pfBusy.value = 'save'
  if (!silent) pfMsg.value = ''
  try {
    await $fetch('/api/meta/platforms', { method: 'PUT', body: { ...pfForm } })
    pfForm.threadsToken = ''
    await refreshPlatforms()
    if (!silent) {
      pfErr.value = false
      pfMsg.value = '已儲存'
      toast('IG／Threads 設定已儲存')
    }
  } catch (e) {
    pfErr.value = true
    pfMsg.value = err(e)
    throw e
  } finally {
    pfBusy.value = ''
  }
}

async function igDetect() {
  pfBusy.value = 'detect'
  pfMsg.value = ''
  try {
    const r = await $fetch<{ igUserId: string; igUsername: string }>('/api/meta/ig-detect', { method: 'POST' })
    pfForm.igUserId = r.igUserId
    await refreshPlatforms()
    pfErr.value = false
    pfMsg.value = `找到 @${r.igUsername}（${r.igUserId}），已填好也存起來了。`
  } catch (e) {
    pfErr.value = true
    pfMsg.value = err(e)
  } finally {
    pfBusy.value = ''
  }
}

async function igTest() {
  pfBusy.value = 'ig'
  pfMsg.value = ''
  try {
    await savePlatforms(true)
    const r = await $fetch<{ username: string; followers: number; mediaCount: number }>(
      '/api/meta/ig-test', { method: 'POST' }
    )
    await refreshPlatforms()
    pfErr.value = false
    pfMsg.value = `Instagram 通了：@${r.username}，${r.followers.toLocaleString()} 位追蹤者、${r.mediaCount} 則貼文。`
  } catch (e) {
    pfErr.value = true
    pfMsg.value = err(e)
  } finally {
    pfBusy.value = ''
  }
}

async function threadsTest() {
  pfBusy.value = 'threads'
  pfMsg.value = ''
  try {
    await savePlatforms(true)
    const r = await $fetch<{ id: string; username: string }>('/api/meta/threads-test', { method: 'POST' })
    pfForm.threadsUserId = r.id || pfForm.threadsUserId
    await refreshPlatforms()
    pfErr.value = false
    pfMsg.value = `Threads 通了：@${r.username}（${r.id}）。`
  } catch (e) {
    pfErr.value = true
    pfMsg.value = err(e)
  } finally {
    pfBusy.value = ''
  }
}

async function clearThreads() {
  if (!confirm('清除已儲存的 Threads token？')) return
  await $fetch('/api/meta/platforms', { method: 'PUT', body: { threadsToken: '__clear__' } })
  pfForm.threadsToken = ''
  await refreshPlatforms()
  pfErr.value = false
  pfMsg.value = 'Threads token 已清除'
}

interface StyleRule { id: string; rule: string; category: string; weight: number }
interface Memory { rules: StyleRule[]; historyCount: number; lastAt: string; injected: string }
const { data: mem, refresh: refreshMem } = await useFetch<Memory>('/api/memory')
const showInjected = ref(false)

async function delRule(id: string) {
  if (!confirm('刪掉這條規則？之後撰寫就不會再帶上它。')) return
  try {
    await $fetch(`/api/memory/${encodeURIComponent(id)}`, { method: 'DELETE' })
    await refreshMem()
  } catch (e) {
    toastErr(err(e))
  }
}

async function clearMem() {
  if (!confirm('清空整個記憶庫（規則與修訂範例都會刪掉）？無法復原。')) return
  try {
    await $fetch('/api/memory/clear', { method: 'POST', body: {} })
    await refreshMem()
    toast('記憶庫已清空')
  } catch (e) {
    toastErr(err(e))
  }
}

interface CleanupTarget { kind: 'posts' | 'inbox'; id: string; title: string; at: string }
interface CleanupSt {
  enabled: boolean
  intervalDays: number
  posts: { enabled: boolean; keepDays: number; onlyPublished: boolean }
  inbox: { enabled: boolean; keepDays: number; onlyWritten: boolean }
  lastRunAt: string
  lastResult: { at: string; posts: number; inbox: number; bytes: number; failed: number } | null
  nextAt: string
  preview: { posts: CleanupTarget[]; inbox: CleanupTarget[] }
  usage: { posts: number; inbox: number }
}
const { data: cl, refresh: refreshCleanup } = await useFetch<CleanupSt>('/api/cleanup')
const clForm = reactive({
  enabled: cl.value?.enabled ?? false,
  intervalDays: cl.value?.intervalDays ?? 7,
  posts: { ...(cl.value?.posts || { enabled: true, keepDays: 30, onlyPublished: true }) },
  inbox: { ...(cl.value?.inbox || { enabled: true, keepDays: 14, onlyWritten: true }) }
})
const clBusy = ref(false)
const clShowList = ref(false)

const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`
function when(iso: string) {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function saveCleanup() {
  clBusy.value = true
  try {
    await $fetch('/api/cleanup', { method: 'PUT', body: clForm })
    await refreshCleanup()
    if (cl.value) {
      clForm.intervalDays = cl.value.intervalDays
      Object.assign(clForm.posts, cl.value.posts)
      Object.assign(clForm.inbox, cl.value.inbox)
    }
    toast('清理設定已儲存')
  } catch (e) {
    toastErr(err(e))
  } finally {
    clBusy.value = false
  }
}

async function runCleanupNow() {
  const n = cl.value ? cl.value.preview.posts.length + cl.value.preview.inbox.length : 0
  if (!confirm(`照已儲存的設定立刻刪除 ${n} 個資料夾（連同圖片）？無法復原。`)) return
  clBusy.value = true
  try {
    const r = await $fetch<{ posts: number; inbox: number; bytes: number; failed: number }>('/api/cleanup/run', {
      method: 'POST'
    })
    await refreshCleanup()
    toast(`已刪除貼文 ${r.posts}、素材 ${r.inbox}，釋出 ${mb(r.bytes)}` + (r.failed ? `（${r.failed} 則失敗）` : ''))
  } catch (e) {
    toastErr(err(e))
  } finally {
    clBusy.value = false
  }
}

const xBusy = ref(false)
const xMsg = ref('')
const xErr = ref(false)

interface SocialStatus {
  python: string | null; scriptFound: boolean; ready: boolean
  loggedIn: { fb: boolean; ig: boolean }
  profile: string; checkedAt: string; deep: boolean; message: string
}
const { data: sc, refresh: refreshSocial } = await useFetch<SocialStatus>('/api/social/status')
const scChecking = ref(false)
/** 沒在忙是空字串，忙的時候放正在登入的站別 */
const scBusy = ref<'' | 'fb' | 'ig'>('')
const scMsg = ref('')
const scErr = ref(false)

async function socialLoginNow(site: 'fb' | 'ig') {
  scBusy.value = site
  scMsg.value = ''
  try {
    await $fetch('/api/social/login', { method: 'POST', body: { site } })
    await refreshSocial()
    scErr.value = false
    const name = site === 'fb' ? 'Facebook' : 'Instagram'
    scMsg.value = `登入成功，之後抓 ${name} 連結會自動帶上這份登入狀態`
    toast(`${name} 已登入`)
  } catch (e) {
    scErr.value = true
    scMsg.value = err(e)
  } finally {
    scBusy.value = ''
  }
}

/** 真的開一次 Chromium 驗證兩邊的登入是否還有效 */
async function socialDeepCheck() {
  scChecking.value = true
  scMsg.value = ''
  try {
    const d = await $fetch<SocialStatus>('/api/social/status', { query: { deep: '1' } })
    sc.value = d
    const on = [d.loggedIn.fb ? 'Facebook' : '', d.loggedIn.ig ? 'Instagram' : ''].filter(Boolean)
    scErr.value = !on.length
    scMsg.value = on.length ? on.join('、') + ' 的登入仍然有效' : d.message || '兩邊都未登入'
  } catch (e) {
    scErr.value = true
    scMsg.value = err(e)
  } finally {
    scChecking.value = false
  }
}

async function xLoginNow() {
  xBusy.value = true
  xMsg.value = ''
  try {
    await $fetch('/api/x/login', { method: 'POST' })
    await refreshX()
    xErr.value = false
    xMsg.value = '登入成功，之後抓推特會自動帶上這份登入狀態'
    toast('X 已登入')
  } catch (e) {
    xErr.value = true
    xMsg.value = err(e)
  } finally {
    xBusy.value = false
  }
}
const showAll = ref(false)
const shownModels = computed(() => (showAll.value ? models.value : models.value.slice(0, 24)))

const previewEndpoint = computed(() => {
  const b = (form.baseUrl || defaults.value.baseUrl).trim().replace(/\/+$/, '')
  return b.replace(/\/chat\/completions$/i, '') + '/chat/completions'
})

function err(e: unknown) {
  return (e as { data?: { message?: string } }).data?.message || (e as Error).message
}

async function save() {
  busy.value = true
  msg.value = ''
  try {
    await $fetch('/api/settings', {
      method: 'PUT',
      body: { baseUrl: form.baseUrl, apiKey: form.apiKey, model: form.model, sendImages: form.sendImages }
    })
    form.apiKey = ''
    await refresh()
    msgErr.value = false
    msg.value = '已儲存'
    toast('設定已儲存')
  } catch (e) {
    msgErr.value = true
    msg.value = err(e)
    toastErr(msg.value)
  } finally {
    busy.value = false
  }
}

async function test() {
  testing.value = true
  busy.value = true
  msg.value = ''
  try {
    if (form.apiKey.trim() || form.baseUrl !== s.value?.baseUrl) await save()
    const r = await $fetch<{ count: number; models: string[]; currentModelFound: boolean; endpoint: string }>(
      '/api/llm-test',
      { method: 'POST' }
    )
    models.value = r.models
    msgErr.value = false
    msg.value =
      `連線成功，讀到 ${r.count} 個模型。` +
      (r.currentModelFound ? `目前設定的「${form.model}」在清單裡。` : `注意：清單裡沒有「${form.model}」，從下面挑一個。`)
  } catch (e) {
    msgErr.value = true
    msg.value = err(e)
  } finally {
    testing.value = false
    busy.value = false
  }
}

async function clearKey() {
  if (!confirm('清除已儲存的金鑰？')) return
  busy.value = true
  try {
    await $fetch('/api/settings', { method: 'PUT', body: { apiKey: '__clear__' } })
    await refresh()
    models.value = []
    msg.value = '金鑰已清除'
    msgErr.value = false
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.settings { max-width: 760px; }
.pad { padding: 14px; }
.chk {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 7px 10px;
  cursor: pointer;
}
.chk.on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.m-ok { color: var(--ok); margin: 0; }
.m-err { color: var(--err); margin: 0; word-break: break-word; }
.gen-wait { color: var(--accent); margin: 0; }
.ok-li { color: var(--ok); }
.warn-li { color: var(--warn); }
.bad-li { color: var(--err); }
.rules { display: flex; flex-direction: column; gap: 5px; max-height: 320px; overflow-y: auto; }
.rule {
  gap: 8px; font-size: 13.5px; line-height: 1.5;
  padding: 7px 9px; background: var(--panel-2); border-radius: 7px;
}
.rule .cat { flex: none; }
.ways { display: flex; gap: 6px; }
.way {
  flex: 1; display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
  padding: 8px 12px; text-align: left;
}
.way.on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.way .tiny { font-weight: 400; opacity: 0.75; }
.steps { margin: 0; padding-left: 20px; line-height: 1.95; }
.scopes { display: flex; flex-wrap: wrap; gap: 5px; }
.scopes code {
  background: var(--panel-2); border: 1px solid var(--line);
  padding: 3px 8px; border-radius: 5px;
}
.platbox {
  background: var(--panel-2); border: 1px solid var(--line);
  border-radius: 8px; padding: 12px;
}
.devwarn {
  border: 1px solid var(--err); border-left-width: 3px;
  background: var(--err-soft); color: var(--err);
  border-radius: 8px; padding: 11px 13px; font-size: 13px; line-height: 1.7;
}
.devwarn a { color: var(--err); text-decoration: underline; }
.tokenbox { background: var(--panel-2); border-radius: 8px; padding: 9px 11px; }
.pagepick {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  text-align: left; padding: 9px 12px; width: 100%;
}
.injected {
  margin: 0; white-space: pre-wrap; word-break: break-word; font-family: inherit;
  background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px;
  padding: 10px 12px; max-height: 300px; overflow-y: auto; color: var(--muted); line-height: 1.6;
}
.modelbox {
  border-top: 1px dashed var(--line);
  padding-top: 10px;
  max-height: 220px;
  overflow-y: auto;
}
code { background: var(--panel-2); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
</style>
