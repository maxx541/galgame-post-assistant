<template>
  <div class="page discover">
    <div class="row wrap" style="margin-bottom: 12px">
      <h1 class="h1">發掘</h1>
      <button class="ghost sm gear" title="來源與計分設定" @click="cfgOpen = true">⚙</button>
      <span class="spacer grow" />
      <span v-if="counts.pending" class="badge">{{ counts.pending }} 則待處理</span>
    </div>

<div class="row wrap" style="gap: 8px; margin-bottom: 12px">
      <label v-for="f in filters" :key="f.key" class="chk" :class="{ on: filter === f.key }">
        <input v-model="filter" type="radio" :value="f.key" />{{ f.label }}
        <span class="tiny faint">{{ f.count }}</span>
      </label>
      <span class="spacer grow" />
      <label class="chk sm" :class="{ on: clearForget }" title="清掉之後當作沒看過，下次抓取會重新收進來">
        <input v-model="clearForget" type="checkbox" />一起忘記
      </label>
      <button class="ghost sm danger" :disabled="clearing || !counts.pending" @click="clearCandidates('pending')">
        清掉待處理（{{ counts.pending }}）
      </button>
      <button class="ghost sm danger" :disabled="clearing || !counts.ignored" @click="clearCandidates('ignored')">
        清掉已忽略（{{ counts.ignored }}）
      </button>
      <button class="ghost sm danger" :disabled="clearing || !candidates.length" @click="clearCandidates('all')">
        全部清空
      </button>
    </div>
    <p class="tiny faint" style="margin: -6px 0 12px">
      清掉之後同樣的東西不會再抓回來；勾「一起忘記」才會。
    </p>

    <p v-if="runMsg" class="small" :class="runErr ? 'm-err' : 'm-ok'">{{ runMsg }}</p>

    <!-- 三個來源並排，各自抓取、各自捲動 —— 規則不同，混在一起看不出誰是誰 -->
    <div class="cols3">
      <section class="col">
        <div class="colhead">
          <div class="row wrap" style="gap: 6px">
            <strong class="small">Notion 日報</strong>
            <span v-if="nt?.autoRun && nt?.enabled" class="badge solid" style="background: var(--ok)">自動</span>
            <span v-else-if="nt?.enabled" class="badge">手動</span>
            <span v-else class="badge">未啟用</span>
            <span class="spacer grow" />
            <span class="tiny faint">{{ notionShown.length }}</span>
          </div>
          <div class="row wrap" style="gap: 6px">
            <button class="sm" :disabled="runningN || !nt?.enabled"
              title="忽略已讀紀錄，把日報上的全部重新收一次" @click="runNow('notion', true)">
              重讀全部
            </button>
            <button class="primary sm grow" :disabled="runningN || !nt?.enabled" @click="runNow('notion')">
              {{ runningN ? '讀取中…' : '讀日報' }}
            </button>
          </div>
          <JobProgress ref="notionJob" kind="notion" @done="onNotionDone" @progress="refreshCandidates" />
        </div>
        <div class="colbody">
          <div v-if="!notionShown.length" class="colempty tiny faint">沒有待處理的日報條目</div>
          <div class="clist">
          <article v-for="(c, i) in notionShown" :key="c.id" class="card citem notion" :class="c.status">
            <div class="rank"># {{ c.rank || i + 1 }}</div>

            <div class="cbody">
              <div class="row wrap tiny" style="gap: 8px">
                <span class="src notion">Notion</span>
                <span class="mono">{{ c.sourceLabel || c.handle }}</span>
                <span class="faint">{{ c.postedAt ? c.postedAt.slice(0, 10) : '' }}</span>
                <span v-if="c.status === 'accepted'" class="tag ok">已收錄</span>
                <span v-if="c.status === 'ignored'" class="tag">已忽略</span>
              </div>

              <pre class="raw">{{ c.text || '（沒有內文）' }}</pre>

              <div class="row wrap tiny" style="gap: 10px">
                <a :href="c.url" target="_blank" class="mono srclink">{{ shortUrl(c.url) }}</a>
                <span class="spacer grow" />
                <NuxtLink v-if="c.materialId" :to="`/inbox/${encodeURIComponent(c.materialId)}`">看素材 →</NuxtLink>
                <template v-else-if="c.status === 'pending'">
                  <button class="sm primary" :disabled="busy === c.id" @click="accept(c)">
                    {{ busy === c.id ? '抓圖收錄中…' : '收進素材夾' }}
                  </button>
                  <button class="sm ghost" :disabled="busy === c.id" @click="ignore(c)">忽略</button>
                </template>
              </div>
            </div>
          </article>
      </div>
        </div>
      </section>

      <section class="col">
        <div class="colhead">
          <div class="row wrap" style="gap: 6px">
            <strong class="small">新聞網站</strong>
            <span class="tiny faint">{{ siteCount }} 個站</span>
            <span class="spacer grow" />
            <span class="tiny faint">{{ webShown.length }}</span>
          </div>
          <div class="row wrap" style="gap: 6px">
            <button class="primary sm grow" :disabled="runningW || !siteCount" @click="runNow('web')">
              {{ runningW ? '抓取中…' : '抓網站' }}
            </button>
          </div>
          <JobProgress ref="webJob" kind="web" @done="onWebDone" @progress="refreshCandidates" />
        </div>
        <div class="colbody">
          <div v-if="!webShown.length" class="colempty tiny faint">沒有待處理的文章</div>
          <div class="clist">
          <article v-for="c in webShown" :key="c.id" class="card citem web" :class="c.status">
            <div class="rank">{{ c.sourceLabel || '網站' }}</div>

            <div class="cbody">
              <div class="row wrap tiny" style="gap: 8px">
                <span class="src web">網站</span>
                <span class="faint">{{ when(c.postedAt) }}</span>
                <span v-if="c.metrics.views" class="faint">看 {{ c.metrics.views.toLocaleString() }}</span>
                <span v-if="c.status === 'accepted'" class="tag ok">已收錄</span>
              </div>

              <pre class="raw">{{ c.text || '（沒有內文）' }}</pre>

              <div v-if="c.images.length" class="thumbs">
                <img v-for="(img, i) in c.images.slice(0, 3)" :key="i" :src="img" alt="" loading="lazy" />
              </div>

              <div class="row wrap tiny" style="gap: 10px">
                <a :href="c.url" target="_blank" class="mono srclink">{{ shortUrl(c.url) }}</a>
                <span class="spacer grow" />
                <NuxtLink v-if="c.materialId" :to="`/inbox/${encodeURIComponent(c.materialId)}`">看素材 →</NuxtLink>
                <template v-else-if="c.status === 'pending'">
                  <button class="sm primary" :disabled="busy === c.id" @click="accept(c)">
                    {{ busy === c.id ? '抓圖收錄中…' : '收進素材夾' }}
                  </button>
                  <button class="sm ghost" :disabled="busy === c.id" @click="ignore(c)">忽略</button>
                </template>
              </div>
            </div>
          </article>
      </div>
        </div>
      </section>

      <section class="col">
        <div class="colhead">
          <div class="row wrap" style="gap: 6px">
            <strong class="small">推特</strong>
            <span v-if="s?.settings.autoRun" class="badge solid" style="background: var(--ok)">自動</span>
            <span v-else class="badge">手動</span>
            <span class="tiny faint">{{ enabledCount }} 帳號</span>
            <span class="spacer grow" />
            <span class="tiny faint">{{ xShown.length }}</span>
          </div>
          <div class="row wrap" style="gap: 6px">
            <button class="primary sm grow" :disabled="running || !enabledCount" @click="runNow('x')">
              {{ running ? '抓取中…' : '抓推特' }}
            </button>
          </div>
          <JobProgress ref="runJob" kind="discover" @done="onRunDone" @progress="refreshCandidates" />
        </div>
        <div class="colbody">
          <div v-if="!xShown.length" class="colempty tiny faint">沒有待處理的推文</div>
          <div class="clist">
          <article v-for="c in xShown" :key="c.id" class="card citem" :class="c.status">
            <div class="score" :class="tier(c.score)">
              <b>{{ c.score }}</b>
              <span class="tiny">分</span>
            </div>

            <div class="cbody">
              <div class="row wrap tiny" style="gap: 8px">
                <span class="src x">X</span>
                <a :href="c.url" target="_blank" class="mono">@{{ c.handle }}</a>
                <span class="faint">{{ when(c.postedAt) }}</span>
                <span v-if="c.isRepost" class="tag">轉推</span>
                <span v-if="c.isReply" class="tag">回覆</span>
                <span v-if="c.status === 'accepted'" class="tag ok">已收錄</span>
                <span v-if="c.status === 'ignored'" class="tag">已忽略</span>
              </div>

              <pre class="raw">{{ c.text || '（沒有內文）' }}</pre>

              <div v-if="c.images.length" class="thumbs">
                <img v-for="(img, i) in c.images.slice(0, 4)" :key="i" :src="img" alt="" loading="lazy" />
              </div>

              <div class="bars">
                <div v-for="(v, k) in c.breakdown" :key="k" class="bar" :title="`${k} ${v}`">
                  <span class="blabel tiny">{{ k }}</span>
                  <span class="btrack"><span class="bfill" :style="{ width: Math.min(100, v) + '%' }" /></span>
                  <span class="bnum tiny">{{ v }}</span>
                </div>
              </div>

              <div class="row wrap tiny" style="gap: 10px">
                <span class="faint">
                  看 {{ c.metrics.views.toLocaleString() }}・讚 {{ c.metrics.likes }}・轉 {{ c.metrics.reposts }}・回 {{ c.metrics.replies }}
                </span>
                <span v-if="c.links.length" class="faint">{{ c.links.length }} 個連結</span>
                <span class="spacer grow" />
                <NuxtLink v-if="c.materialId" :to="`/inbox/${encodeURIComponent(c.materialId)}`">看素材 →</NuxtLink>
                <template v-else-if="c.status === 'pending'">
                  <button class="sm primary" :disabled="busy === c.id" @click="accept(c)">
                    {{ busy === c.id ? '抓圖收錄中…' : '收進素材夾' }}
                  </button>
                  <button class="sm ghost" :disabled="busy === c.id" @click="ignore(c)">忽略</button>
                </template>
              </div>
            </div>
          </article>
      </div>
        </div>
      </section>
    </div>

    <!-- 設定彈窗 -->
    <div v-if="cfgOpen" class="modalwrap" @click.self="cfgOpen = false">
      <div class="modal" role="dialog" aria-label="發掘設定">
        <div class="modalhead">
          <strong class="h2">發掘設定</strong>
          <span class="spacer grow" />
          <button class="ghost sm" @click="cfgOpen = false">關閉</button>
        </div>

        <div class="modaltabs">
          <button v-for="t in CFG_TABS" :key="t.key" class="mtab" :class="{ on: cfgTab === t.key }"
            @click="cfgTab = t.key">
            {{ t.label }}
          </button>
        </div>

        <div class="modalbody">
          <div v-show="cfgTab === 'notion'" class="stack">
<p class="small muted" style="margin: 0">
              每則情報固定是<b>內容／日期｜廠商（作品）／連結</b>三行。不計分，照日報原本的順序排。
            </p>
            <div class="field">
              <label>Integration Token{{ nt?.hasToken ? '（已儲存，留空表示不更動）' : '' }}</label>
              <input v-model="ntForm.token" type="password" class="sm-in mono" autocomplete="off" placeholder="ntn_…" />
            </div>
            <div class="row wrap" style="gap: 10px">
              <div class="field" style="width: 150px">
                <label>只讀標題含</label>
                <input v-model="ntForm.titleFilter" type="text" class="sm-in" placeholder="文案版" />
              </div>
              <div class="field" style="width: 120px">
                <label>最多讀幾頁</label>
                <input v-model.number="ntForm.maxPages" type="number" min="1" max="14" class="sm-in" />
              </div>
              <label class="chk" :class="{ on: ntForm.enabled }" style="align-self: flex-end">
                <input v-model="ntForm.enabled" type="checkbox" />啟用這個來源
              </label>
              <label class="chk" :class="{ on: ntForm.autoRun }" style="align-self: flex-end">
                <input v-model="ntForm.autoRun" type="checkbox" />自動讀取
              </label>
              <div class="field" style="width: 120px">
                <label>每幾小時一次</label>
                <input v-model.number="ntForm.intervalHours" type="number" min="1" max="48" class="sm-in" />
              </div>
            </div>
            <div class="row wrap" style="gap: 8px">
              <button class="primary" :disabled="ntBusy" @click="saveNotion">儲存</button>
              <button :disabled="ntBusy || !(nt?.hasToken || ntForm.token)" @click="testNotion">
                {{ ntTesting ? '測試中…' : '測試連線' }}
              </button>
            </div>
            <p v-if="ntMsg" class="small" :class="ntErr ? 'm-err' : 'm-ok'">{{ ntMsg }}</p>
            <div v-if="ntPages.length" class="tiny muted">
              看得到的日報頁：{{ ntPages.map(p => p.date || p.title).join('、') }}
            </div>
          </div>
          <div v-show="cfgTab === 'x'" class="stack">
<div class="field">
              <label>追蹤的 X 帳號</label>
              <div v-for="(src, i) in st.sources" :key="i" class="row" style="gap: 6px">
                <label class="chk" :class="{ on: src.enabled }">
                  <input v-model="src.enabled" type="checkbox" />啟用
                </label>
                <span class="at">@</span>
                <input v-model="src.handle" type="text" class="sm-in mono" style="width: 160px" placeholder="帳號" />
                <input v-model="src.note" type="text" class="sm-in grow" placeholder="備註（給人看的）" />
                <button class="ghost sm danger" @click="st.sources.splice(i, 1)">刪</button>
              </div>
              <div class="row wrap" style="gap: 6px">
                <button class="sm" @click="st.sources.push({ handle: '', enabled: true, note: '' })">＋ 加帳號</button>
                <button class="sm" @click="importOpen = !importOpen">
                  {{ importOpen ? '收起匯入' : '匯入清單' }}
                </button>
                <span class="tiny faint">共 {{ st.sources.length }} 個，{{ st.sources.filter(x => x.enabled).length }} 個啟用</span>
              </div>
            </div>

            <div v-if="importOpen" class="importbox stack">
              <p class="tiny muted" style="margin: 0">
                一行一個。第一欄是帳號（<code class="mono">handle</code>、<code class="mono">@handle</code>
                或網址都可以），第二欄當備註。
              </p>
              <textarea
                v-model="importText"
                rows="6"
                class="sm-in mono"
                spellcheck="false"
                placeholder="kagakuadv,科學ADV 系列&#10;@Moepedia_net,美少女遊戲行事曆&#10;https://x.com/gsc_kahotan"
              />
              <div class="row wrap" style="gap: 8px">
                <input ref="csvEl" type="file" accept=".csv,.txt,.tsv,text/*" hidden @change="onCsvPick" />
                <button class="sm" @click="csvEl?.click()">選檔案</button>
                <label class="chk" :class="{ on: importMode === 'merge' }">
                  <input v-model="importMode" type="radio" value="merge" />合併（保留原設定）
                </label>
                <label class="chk" :class="{ on: importMode === 'replace' }">
                  <input v-model="importMode" type="radio" value="replace" />整份取代
                </label>
                <span class="spacer grow" />
                <span v-if="importPreview.length" class="tiny muted">預覽解析出 {{ importPreview.length }} 個</span>
                <button class="primary sm" :disabled="importing || !importPreview.length" @click="doImport">
                  {{ importing ? '匯入中…' : '匯入' }}
                </button>
              </div>
              <div v-if="importPreview.length" class="tiny faint prev">
                {{ importPreview.slice(0, 12).map(h => '@' + h).join('、') }}{{ importPreview.length > 12 ? ` …共 ${importPreview.length} 個` : '' }}
              </div>
              <p v-if="importMsg" class="tiny" :class="importErr ? 'm-err' : 'm-ok'">{{ importMsg }}</p>
            </div>

            <div class="field">
              <label>主題關鍵字（命中才加分，一行一個或用空格分隔）</label>
              <textarea v-model="keywordText" rows="4" class="sm-in mono" spellcheck="false" />
              <span class="tiny faint">目前 {{ parsedKeywords.length }} 個</span>
            </div>

            <div class="row wrap" style="gap: 12px">
              <div class="field" style="width: 130px">
                <label>自動收錄門檻</label>
                <input v-model.number="st.threshold" type="number" min="1" max="100" class="sm-in" />
              </div>
              <div class="field" style="width: 120px">
                <label>每帳號讀幾則</label>
                <input v-model.number="st.maxPerAccount" type="number" min="1" max="40" class="sm-in" />
              </div>
              <div class="field" style="width: 120px">
                <label>只看幾天內</label>
                <input v-model.number="st.lookbackDays" type="number" min="1" max="30" class="sm-in" />
              </div>
              <div class="field" style="width: 130px">
                <label>帳號間隔（秒）</label>
                <input v-model.number="st.gapSeconds" type="number" min="0" max="600" class="sm-in" />
              </div>
            </div>

            <div class="field">
              <label>計分權重（相加不必等於 100，會自動正規化）</label>
              <div class="row wrap" style="gap: 10px">
                <label v-for="k in weightKeys" :key="k" class="wlab">
                  {{ weightLabel[k] }}
                  <input v-model.number="st.weights[k]" type="number" min="0" max="100" class="sm-in w" />
                </label>
              </div>
            </div>

            <div class="autobox" style="flex-wrap: wrap">
              <label class="chk" :class="{ on: st.fetchImagesOnAccept }">
                <input v-model="st.fetchImagesOnAccept" type="checkbox" />收錄時去原文網頁抓圖
              </label>
              <div class="field" style="width: 110px">
                <label>最多幾張</label>
                <input v-model.number="st.maxImages" type="number" min="1" max="10" class="sm-in" />
              </div>
              <label class="chk" :class="{ on: st.imageSearchX }">
                <input v-model="st.imageSearchX" type="checkbox" />網頁沒圖時用關鍵字去 X 搜
              </label>
              <span class="spacer grow" />
              <span class="tiny faint">
                優先用站方的 og:image；其餘依尺寸與路徑排序，下載後太小或太窄長的會丟掉。
                X 搜圖會佔用瀏覽器佇列，比較慢。
              </span>
            </div>

            <div class="autobox">
              <label class="chk" :class="{ on: st.autoRun }">
                <input v-model="st.autoRun" type="checkbox" />開著時自動執行
              </label>
              <input v-model.number="st.intervalHours" type="number" min="1" max="48" class="sm-in" style="width: 66px" />
              <span class="small muted">小時跑一次</span>
              <span class="spacer grow" />
              <span class="tiny faint">只管推特這條線，日報的排程在上面那個區塊各自設定</span>
            </div>

            <div class="row">
              <button class="primary" :disabled="saving" @click="save">{{ saving ? '儲存中…' : '儲存設定' }}</button>
              <button class="ghost" @click="reset">還原預設</button>
            </div>
          </div>
          <div v-show="cfgTab === 'web'" class="stack">
<p class="tiny muted" style="margin: 0">
              填首頁網址就好，RSS 位址會自動找（<code class="mono">&lt;link rel=alternate&gt;</code>，
              找不到就試 <code class="mono">/feed/</code>）。
            </p>
            <div v-for="(w, i) in st.sites" :key="i" class="row" style="gap: 6px">
              <label class="chk" :class="{ on: w.enabled }">
                <input v-model="w.enabled" type="checkbox" />啟用
              </label>
              <input v-model="w.name" type="text" class="sm-in" style="width: 130px" placeholder="名字" />
              <input v-model="w.url" type="url" class="sm-in grow mono" placeholder="https://…" />
              <button class="ghost sm" :disabled="testingSite === i" @click="testSite(i)">
                {{ testingSite === i ? '測試中…' : '測試' }}
              </button>
              <button class="ghost sm danger" @click="st.sites.splice(i, 1)">刪</button>
            </div>

            <div class="row wrap" style="gap: 6px">
              <button class="sm" @click="st.sites.push({ url: '', name: '', enabled: true })">＋ 加網站</button>
              <button class="sm" @click="siteImportOpen = !siteImportOpen">
                {{ siteImportOpen ? '收起匯入' : '匯入清單' }}
              </button>
              <div class="field" style="width: 120px">
                <label>一站看幾篇</label>
                <input v-model.number="st.maxPerSite" type="number" min="1" max="40" class="sm-in" />
              </div>
            </div>

            <div v-if="siteImportOpen" class="importbox stack">
              <textarea
                v-model="siteImportText"
                rows="5"
                class="sm-in mono"
                spellcheck="false"
                placeholder="https://bugbug.news/,BugBug&#10;news.denfaminicogamer.jp,電ファミ"
              />
              <div class="row wrap" style="gap: 8px">
                <span class="spacer grow" />
                <button class="primary sm" :disabled="siteImporting || !siteImportText.trim()" @click="importSites">
                  {{ siteImporting ? '匯入中…' : '匯入' }}
                </button>
              </div>
            </div>

            <p v-if="siteMsg" class="tiny" :class="siteErr ? 'm-err' : 'm-ok'" style="white-space: pre-wrap">
              {{ siteMsg }}
            </p>

            <div class="row">
              <button class="primary" :disabled="saving" @click="save">{{ saving ? '儲存中…' : '儲存設定' }}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
interface Candidate {
  id: string; handle: string; url: string; text: string
  sourceType?: string; sourceLabel?: string
  images: string[]; links: { url: string; label: string }[]
  postedAt: string
  metrics: { replies: number; reposts: number; likes: number; views: number }
  isRepost: boolean; isReply: boolean
  score: number; breakdown: Record<string, number>
  /** Notion 日報的名次，X 來源沒有 */
  rank?: number
  status: string; materialId: string; foundAt: string
}
interface Settings {
  sources: { handle: string; enabled: boolean; note: string }[]
  sites: { url: string; name: string; enabled: boolean; feedUrl?: string }[]
  maxPerSite: number
  keywords: string[]; autoRun: boolean; intervalHours: number; threshold: number
  weights: Record<string, number>
  maxPerAccount: number; lookbackDays: number; minTextLength: number
  gapSeconds: number
  fetchImagesOnAccept: boolean; imageSearchX: boolean; maxImages: number
  lastRunAt: string
}
interface RunReport {
  finishedAt: string; accounts: number; fetched: number; fresh: number; skipped: number
  notionPages: number; notionEntries: number
  added: number; autoAccepted: number
  errors: { handle: string; message: string }[]; warnings: string[]
}
interface StatusResp {
  settings: Settings
  counts: { pending: number; accepted: number; ignored: number; total: number }
  lastRun: RunReport | null
  defaults: Settings
}

const { toast, toastErr } = useToast()
const { data: s, refresh: refreshStatus } = await useFetch<StatusResp>('/api/discover')
const { data: cdata, refresh: refreshCandidates } = await useFetch<{ items: Candidate[] }>(
  '/api/discover/candidates',
  { default: () => ({ items: [] }) }
)

const candidates = computed(() => cdata.value?.items || [])
const counts = computed(() => s.value?.counts || { pending: 0, accepted: 0, ignored: 0, total: 0 })

const st = reactive<Settings>(
  JSON.parse(JSON.stringify(s.value?.settings || { weights: {}, sources: [], keywords: [] }))
)
const keywordText = ref((s.value?.settings.keywords || []).join('\n'))
const parsedKeywords = computed(() =>
  [...new Set(keywordText.value.split(/[\n\s,、]+/).map(k => k.trim()).filter(Boolean))]
)

// 配圖不再計分：情報類推文幾乎都有圖，人人滿分反而分不出好壞，
// 還會把「有圖沒內容」的現場通知往上抬
const weightKeys = ['views', 'engagement', 'recency', 'keyword'] as const
const weightLabel: Record<string, string> = {
  views: '瀏覽', engagement: '互動', recency: '時效', keyword: '主題'
}

const filter = ref('pending')
const filters = computed(() => [
  { key: 'pending', label: '待處理', count: counts.value.pending },
  { key: 'accepted', label: '已收錄', count: counts.value.accepted },
  { key: 'ignored', label: '已忽略', count: counts.value.ignored },
  { key: '', label: '全部', count: counts.value.total }
])
const shown = computed(() =>
  candidates.value.filter(c => !filter.value || c.status === filter.value)
)

const notionShown = computed(() =>
  shown.value
    .filter(c => c.sourceType === 'notion')
    .sort((a, b) => (a.rank || 999) - (b.rank || 999) || a.foundAt.localeCompare(b.foundAt))
)
/** 網站來源不計分，照發佈時間排 */
const webShown = computed(() =>
  shown.value
    .filter(c => c.sourceType === 'web')
    .sort((a, b) => (b.postedAt || b.foundAt).localeCompare(a.postedAt || a.foundAt))
)

const xShown = computed(() =>
  shown.value
    .filter(c => c.sourceType !== 'notion' && c.sourceType !== 'web')
    .sort((a, b) => b.score - a.score)
)

/** 網址在卡片上只留看得懂的那截 */
function shortUrl(u: string) {
  try {
    const x = new URL(u)
    return x.hostname.replace(/^www\./, '') + (x.pathname === '/' ? '' : x.pathname)
  } catch {
    return u
  }
}

interface NotionSt {
  enabled: boolean; titleFilter: string; maxPages: number; hasToken: boolean
  autoRun: boolean; intervalHours: number; lastRunAt: string
}
const { data: nt, refresh: refreshNotion } = await useFetch<NotionSt>('/api/discover/notion')
const ntForm = reactive({
  token: '',
  enabled: nt.value?.enabled ?? false,
  titleFilter: nt.value?.titleFilter ?? '文案版',
  maxPages: nt.value?.maxPages ?? 3,
  autoRun: nt.value?.autoRun ?? false,
  intervalHours: nt.value?.intervalHours ?? 6
})
const ntBusy = ref(false)
const ntTesting = ref(false)
const ntMsg = ref('')
const ntErr = ref(false)
const ntPages = ref<{ title: string; date: string }[]>([])

async function saveNotion() {
  ntBusy.value = true
  ntMsg.value = ''
  try {
    await $fetch('/api/discover/notion', { method: 'PUT', body: { ...ntForm } })
    ntForm.token = ''
    await refreshNotion()
    ntErr.value = false
    ntMsg.value = '已儲存'
    toast('Notion 設定已儲存')
  } catch (e) {
    ntErr.value = true
    ntMsg.value = errMsg(e)
  } finally {
    ntBusy.value = false
  }
}

async function testNotion() {
  ntTesting.value = true
  ntBusy.value = true
  ntMsg.value = ''
  try {
    if (ntForm.token.trim()) await saveNotion()
    const r = await $fetch<{
      pageCount: number; pages: { title: string; date: string }[]
      sampleTitle: string; sampleCount: number
    }>('/api/discover/notion-test', { method: 'POST' })
    ntPages.value = r.pages
    ntErr.value = r.pageCount === 0
    ntMsg.value = r.pageCount
      ? `看得到 ${r.pageCount} 頁日報，最新一頁「${r.sampleTitle}」解析出 ${r.sampleCount} 則。`
      : '連得上，但看不到任何符合的頁 —— 確認日報頁有分享給這個 integration，標題也含得到上面填的字。'
  } catch (e) {
    ntErr.value = true
    ntMsg.value = errMsg(e)
  } finally {
    ntTesting.value = false
    ntBusy.value = false
  }
}

const importOpen = ref(false)
const importText = ref('')
const importMode = ref<'merge' | 'replace'>('merge')
const importing = ref(false)
const importMsg = ref('')
const importErr = ref(false)
const csvEl = ref<HTMLInputElement | null>(null)

/** 前端先粗略解析一次做預覽，真正的解析以後端為準 */
const importPreview = computed(() => {
  const out: string[] = []
  const seen = new Set<string>()
  for (const line of importText.value.split(/\r?\n/)) {
    const first = line.trim().split(/[,\t;]/)[0]?.trim().replace(/^["']|["']$/g, '') || ''
    if (!first || first.startsWith('#')) continue
    const m = first.match(/(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})/i)
    const h = (m ? m[1] : first).replace(/^@/, '')
    if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) continue
    if (/^(handle|account|username|user)$/i.test(h)) continue
    if (seen.has(h.toLowerCase())) continue
    seen.add(h.toLowerCase())
    out.push(h)
  }
  return out
})

function onCsvPick(e: Event) {
  const el = e.target as HTMLInputElement
  const f = el.files?.[0]
  if (!f) return
  const reader = new FileReader()
  reader.onload = () => {
    importText.value = String(reader.result || '')
  }
  reader.readAsText(f, 'utf-8')
  el.value = ''
}

async function doImport() {
  importing.value = true
  importMsg.value = ''
  try {
    const r = await $fetch<{ parsed: number; added: number; updated: number; total: number; sources: Settings['sources'] }>(
      '/api/discover/sources/import',
      { method: 'POST', body: { text: importText.value, mode: importMode.value } }
    )
    st.sources = r.sources
    importErr.value = false
    importMsg.value =
      importMode.value === 'replace'
        ? `已取代成 ${r.total} 個帳號。`
        : `解析 ${r.parsed} 個，新增 ${r.added} 個${r.updated ? `、補了 ${r.updated} 個備註` : ''}，目前共 ${r.total} 個。`
    importText.value = ''
    await refreshStatus()
    toast('帳號清單已匯入')
  } catch (e) {
    importErr.value = true
    importMsg.value = errMsg(e)
  } finally {
    importing.value = false
  }
}

const running = ref(false)
const runningN = ref(false)
const runningW = ref(false)
const runJob = ref<{ attach(id: string): Promise<void> } | null>(null)
const notionJob = ref<{ attach(id: string): Promise<void> } | null>(null)
const webJob = ref<{ attach(id: string): Promise<void> } | null>(null)
const siteCount = computed(() => st.sites.filter(x => x.enabled && x.url).length)
const siteImportOpen = ref(false)
const siteImportText = ref('')
const siteImporting = ref(false)
const testingSite = ref(-1)
const siteMsg = ref('')
const siteErr = ref(false)

async function testSite(i: number) {
  const w = st.sites[i]
  if (!w?.url) return
  testingSite.value = i
  siteMsg.value = ''
  try {
    const r = await $fetch<{ feedUrl: string; count: number; items: { title: string }[] }>(
      '/api/discover/sites/test',
      { method: 'POST', body: { url: w.url } }
    )
    siteErr.value = false
    siteMsg.value =
      `${w.name || w.url}：讀到 ${r.count} 篇（${r.feedUrl}）\n` +
      r.items.map(x => '・' + x.title.slice(0, 44)).join('\n')
  } catch (e) {
    siteErr.value = true
    siteMsg.value = errMsg(e)
  } finally {
    testingSite.value = -1
  }
}

async function importSites() {
  siteImporting.value = true
  siteMsg.value = ''
  try {
    const r = await $fetch<{ parsed: number; added: number; total: number; sites: Settings['sites'] }>(
      '/api/discover/sites/import',
      { method: 'POST', body: { text: siteImportText.value } }
    )
    st.sites = r.sites
    siteErr.value = false
    siteMsg.value = `解析 ${r.parsed} 個，新增 ${r.added} 個，共 ${r.total} 個。`
    siteImportText.value = ''
    toast('網站清單已匯入')
  } catch (e) {
    siteErr.value = true
    siteMsg.value = errMsg(e)
  } finally {
    siteImporting.value = false
  }
}

async function onWebDone(j: { status: string; result: unknown }) {
  await Promise.all([refreshStatus(), refreshCandidates()])
  const r = (j.result || {}) as RunReport | null
  if (j.status !== 'done' || !r) return
  runErr.value = r.errors.length > 0
  runMsg.value =
    `網站：${r.accounts} 個站、讀到 ${r.fetched} 篇、新的 ${r.fresh} 篇、自動收錄 ${r.autoAccepted} 篇` +
    (r.errors.length ? `。失敗：${r.errors.map(e => e.handle + ' ' + e.message).join('；')}` : '')
}
const enabledCount = computed(() => st.sources.filter(x => x.enabled && x.handle).length)
const saving = ref(false)
const busy = ref('')
const runMsg = ref('')
const runErr = ref(false)

function errMsg(e: unknown) {
  return (e as { data?: { message?: string } }).data?.message || (e as Error).message
}
function when(iso: string) {
  if (!iso) return ''
  const d = new Date(iso)
  const diff = (Date.now() - d.getTime()) / 3600_000
  if (diff < 1) return `${Math.max(1, Math.round(diff * 60))} 分鐘前`
  if (diff < 24) return `${Math.round(diff)} 小時前`
  return d.toLocaleString('zh-TW')
}
function tier(n: number) {
  return n >= (st.threshold || 60) ? 'hi' : n >= 35 ? 'mid' : 'low'
}

/**
 * 開一個抓取工作。兩條線分開：'x' 只抓推特、'notion' 只讀日報。
 * 這裡只負責開工作＋接上進度條，實際抓取在伺服器上跑，換頁不會斷。
 */
async function runNow(source: 'x' | 'notion' | 'web', force = false) {
  if (source === 'x' && !enabledCount.value) {
    runErr.value = true
    runMsg.value = '沒有啟用中的追蹤帳號。'
    return
  }
  if (source === 'notion' && !nt.value?.enabled) {
    runErr.value = true
    runMsg.value = 'Notion 日報還沒啟用，先到下面的設定打開。'
    return
  }
  if (source === 'web' && !siteCount.value) {
    runErr.value = true
    runMsg.value = '還沒加任何新聞網站，到下面的「新聞網站設定」加一個。'
    return
  }
  const flag = source === 'notion' ? runningN : source === 'web' ? runningW : running
  flag.value = true
  runMsg.value = ''
  try {
    const r = await $fetch<{ jobId: string; alreadyRunning?: boolean }>('/api/discover/run', {
      method: 'POST',
      body: { source, force }
    })
    const box = source === 'notion' ? notionJob : source === 'web' ? webJob : runJob
    await box.value?.attach(r.jobId)
    runErr.value = false
    runMsg.value = r.alreadyRunning ? '這條線已經有一輪在跑了，下面是它的進度。' : ''
  } catch (e) {
    runErr.value = true
    runMsg.value = errMsg(e)
  } finally {
    flag.value = false
  }
}

async function onNotionDone(j: { status: string; result: unknown }) {
  await Promise.all([refreshStatus(), refreshCandidates(), refreshNotion()])
  const r = (j.result || {}) as RunReport | null
  if (j.status !== 'done' || !r) return
  runErr.value = r.errors.length > 0
  if (r.errors.length) {
    runMsg.value = `Notion：${r.errors.map(e => e.message).join('；')}`
  } else if (!r.added && r.skipped) {
    // 只顯示「新的 0 則」會讓人以為壞掉了，要講清楚是全部處理過
    runMsg.value =
      `Notion：${r.notionPages} 頁日報、解析 ${r.notionEntries} 則，` +
      `全部 ${r.skipped} 則之前都處理過了，所以沒有新的。` +
      `想重新收一次就按「重讀全部」。`
  } else {
    runMsg.value =
      `Notion：${r.notionPages} 頁日報，新的 ${r.added} 則` +
      (r.skipped ? `（跳過 ${r.skipped} 則處理過的）` : '') + '。'
  }
}

async function onRunDone(j: { status: string; result: unknown }) {
  await Promise.all([refreshStatus(), refreshCandidates()])
  const r = (j.result || {}) as RunReport | null
  if (j.status !== 'done' || !r) return
  runErr.value = r.errors.length > 0
  runMsg.value =
    `推特：走訪 ${r.accounts} 個帳號` +
    `、讀到 ${r.fetched} 則、新的 ${r.fresh} 則、自動收錄 ${r.autoAccepted} 則` +
    (r.errors.length ? `。失敗：${r.errors.map(e => '@' + e.handle + ' ' + e.message).join('；')}` : '') +
    (r.warnings.length ? `（${r.warnings.join('；')}）` : '')
}

async function save() {
  saving.value = true
  try {
    st.keywords = parsedKeywords.value
    st.sources = st.sources.filter(x => x.handle.trim())
    await $fetch('/api/discover', { method: 'PUT', body: { ...st } })
    await refreshStatus()
    toast('設定已儲存')
  } catch (e) {
    toastErr(errMsg(e))
  } finally {
    saving.value = false
  }
}

function reset() {
  if (!confirm('把追蹤設定還原成預設？')) return
  const d = s.value?.defaults
  if (!d) return
  Object.assign(st, JSON.parse(JSON.stringify(d)))
  keywordText.value = d.keywords.join('\n')
}

async function accept(c: Candidate) {
  busy.value = c.id
  try {
    await $fetch(`/api/discover/candidates/${encodeURIComponent(c.id)}/accept`, { method: 'POST' })
    await Promise.all([refreshStatus(), refreshCandidates()])
    toast('已收進素材夾')
  } catch (e) {
    toastErr(errMsg(e))
  } finally {
    busy.value = ''
  }
}

const cfgOpen = ref(false)
const cfgTab = ref<'notion' | 'x' | 'web'>('x')
const CFG_TABS = [
  { key: 'x' as const, label: '推特帳號與計分' },
  { key: 'notion' as const, label: 'Notion 日報' },
  { key: 'web' as const, label: '新聞網站' }
]
// 彈窗開著時鎖住底層捲動，不然滾滾鼠輪會捲到後面的清單
watch(cfgOpen, v => {
  if (import.meta.client) document.body.style.overflow = v ? 'hidden' : ''
})
onBeforeUnmount(() => {
  if (import.meta.client) document.body.style.overflow = ''
})

const clearing = ref(false)
/** 清掉時要不要連「已讀」一起忘掉。預設不忘，避免下次抓取又整批回來 */
const clearForget = ref(false)

async function clearCandidates(status: string) {
  const label =
    status === 'all' ? '全部候選' : status === 'ignored' ? '已忽略的候選' : '待處理的候選'
  const tail = clearForget.value
    ? '，並且當作沒看過（下次抓取會重新收進來）。'
    : '。已讀紀錄會保留，所以下次抓取不會再把同樣的東西放回來。'
  if (!confirm(`清掉${label}${tail}`)) return
  clearing.value = true
  try {
    const r = await $fetch<{ removed: number; remaining: number; forgotten: number }>(
      '/api/discover/candidates/clear',
      { method: 'POST', body: { status, forget: clearForget.value } }
    )
    await Promise.all([refreshStatus(), refreshCandidates()])
    toast(`清掉 ${r.removed} 則${r.forgotten ? `，忘記 ${r.forgotten} 筆已讀` : ''}，剩 ${r.remaining} 則`)
  } catch (e) {
    toastErr(errMsg(e))
  } finally {
    clearing.value = false
  }
}

async function ignore(c: Candidate) {
  busy.value = c.id
  try {
    await $fetch(`/api/discover/candidates/${encodeURIComponent(c.id)}/ignore`, { method: 'POST' })
    await Promise.all([refreshStatus(), refreshCandidates()])
    toast('已忽略')
  } catch (e) {
    toastErr(errMsg(e))
  } finally {
    busy.value = ''
  }
}
</script>

<style scoped>
/* 三欄並排要橫向空間 —— 全站的 .page 上限是 1500px，這頁另外放寬。
   還是留一個上限，不然超寬螢幕上一欄會寬到不好讀 */
.discover { max-width: 2000px; }
.pad { padding: 14px; }
.chk {
  display: inline-flex; align-items: center; gap: 5px; font-size: 13px;
  border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; cursor: pointer;
}
.chk.on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.sm-in { font-size: 13px; padding: 5px 8px; }
.sm-in.w { width: 62px; text-align: center; }
.wlab {
  background: var(--panel-2); border: 1px solid var(--line);
  border-radius: 7px; padding: 5px 8px 5px 11px;
}
.wlab { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); }
.at { color: var(--faint); font-family: monospace; }
.field > label { font-size: 12px; color: var(--muted); font-weight: 600; }
.m-ok { color: var(--ok); }
.m-err { color: var(--err); word-break: break-word; }
.importbox {
  background: var(--panel-2); border: 1px dashed var(--line-strong);
  border-radius: 8px; padding: 12px;
}
.prev { line-height: 1.6; word-break: break-all; }
.autobox {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  background: var(--panel-2); border-radius: 8px; padding: 10px 12px;
}

/* 三欄並排，各自捲動。視窗窄的時候自動疊成一欄 */
.cols3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; align-items: start; }
@media (max-width: 1100px) { .cols3 { grid-template-columns: 1fr; } }
.col {
  display: flex; flex-direction: column; min-width: 0;
  border: 1px solid var(--line); border-radius: 10px; background: var(--panel-2);
}
.colhead {
  display: flex; flex-direction: column; gap: 7px;
  padding: 10px 11px; border-bottom: 1px solid var(--line);
}
.colbody {
  padding: 12px; overflow-y: auto; overflow-x: hidden;
  /* 扣掉頁首與欄首，剩下的高度都給清單 */
  max-height: calc(100vh - 250px); min-height: 240px;
}
.colempty { text-align: center; padding: 26px 8px; }
.gear { font-size: 15px; line-height: 1; padding: 4px 9px; }

.modalwrap {
  position: fixed; inset: 0; z-index: 50; display: flex;
  align-items: center; justify-content: center; padding: 24px;
  background: rgba(0, 0, 0, 0.45);
}
.modal {
  display: flex; flex-direction: column; width: min(880px, 100%); max-height: 88vh;
  background: var(--panel); border: 1px solid var(--line-strong);
  border-radius: 12px; box-shadow: var(--shadow); overflow: hidden;
}
.modalhead { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--line); }
.modaltabs { display: flex; gap: 2px; padding: 8px 10px 0; border-bottom: 1px solid var(--line); }
.mtab {
  border: 1px solid transparent; border-bottom: none; background: transparent;
  border-radius: 8px 8px 0 0; padding: 6px 13px; color: var(--muted); font-size: 13px;
}
.mtab.on { background: var(--panel-2); border-color: var(--line); color: var(--text); font-weight: 600; }
.modalbody { padding: 14px; overflow-y: auto; }

.sources { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.srcbox {
  flex: 1; min-width: 300px; display: flex; flex-direction: column; gap: 8px;
  background: var(--panel); border: 1px solid var(--line);
  border-radius: 9px; padding: 11px 13px;
}
.secthead {
  gap: 10px; margin-bottom: 10px; padding-bottom: 8px;
  border-bottom: 1px solid var(--line);
}
.clist { display: flex; flex-direction: column; gap: 10px; }
/* 欄位變窄，卡片改成上下排 */
.col .citem { flex-direction: column; gap: 9px; padding: 11px; }
.col .score, .col .rank { width: auto; align-self: flex-start; padding: 4px 10px; }
.col .score b { display: inline; font-size: 15px; }
/* 日報不計分，用名次代替分數欄；寬度跟 .score 一樣，兩區才對得齊 */
.rank {
  flex: none; width: 58px; text-align: center; border-radius: 8px;
  padding: 10px 0; background: var(--panel-2); color: var(--muted);
  font-size: 13px; font-variant-numeric: tabular-nums;
}
.citem.notion { border-left: 3px solid var(--accent); }
.citem.web { border-left: 3px solid var(--info); }
.citem.web .rank { font-size: 11px; line-height: 1.35; padding: 8px 4px; word-break: break-all; }
.srclink { color: var(--muted); word-break: break-all; }
.morebtn {
  margin-top: 10px; width: 100%; color: var(--muted);
  border-style: dashed; background: transparent;
}
.citem { display: flex; gap: 14px; padding: 14px; align-items: flex-start; }
.citem.ignored { opacity: 0.5; }
.citem.accepted { border-color: var(--ok); }
.score {
  flex: none; width: 58px; text-align: center; border-radius: 8px;
  padding: 8px 0; background: var(--panel-2); line-height: 1.15;
}
.score b { font-size: 22px; font-variant-numeric: tabular-nums; display: block; }
.score span { color: var(--muted); }
.score.hi { background: var(--ok-soft); color: var(--ok); }
.score.mid { background: var(--warn-soft); color: var(--warn); }
.score.low { color: var(--faint); }
.cbody { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.raw {
  margin: 0; font-family: inherit; white-space: pre-wrap; word-break: break-word;
  font-size: 14px; line-height: 1.65; max-height: 7em; overflow: hidden;
  border-left: 2px solid var(--line); padding-left: 10px;
}
.thumbs { display: flex; gap: 5px; }
.thumbs img { width: 76px; height: 76px; object-fit: cover; border-radius: 6px; background: var(--panel-2); }
.tag {
  background: var(--panel-2); color: var(--muted);
  padding: 1px 7px; border-radius: 20px;
}
.tag.ok { background: var(--ok-soft); color: var(--ok); }
.src {
  flex: none; font-weight: 600; padding: 1px 8px; border-radius: 20px;
  background: var(--panel-2); color: var(--muted);
}
.src.notion { background: var(--accent-soft); color: var(--accent); }
.src.web { background: var(--info-soft); color: var(--info); }
.bars { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 4px 12px; }
.bar { display: flex; align-items: center; gap: 6px; }
.blabel { color: var(--muted); width: 26px; flex: none; }
.btrack { flex: 1; height: 4px; background: var(--panel-2); border-radius: 3px; overflow: hidden; }
.bfill { display: block; height: 100%; background: var(--accent); }
.bnum { color: var(--faint); width: 24px; text-align: right; font-variant-numeric: tabular-nums; }
</style>
