<template>
  <div v-if="post" class="page editor">
    <div class="row wrap bar">
      <NuxtLink to="/" class="ghostlink">← 貼文列表</NuxtLink>
      <span class="badge">【{{ post.category }}】</span>
      <strong class="h1 grow">{{ post.title }}</strong>
      <span v-if="post.missing.length" class="badge solid" style="background: var(--warn)">
        待補 {{ post.missing.length }}
      </span>
      <span class="tiny" :class="saving ? 'muted' : 'faint'">{{ saving ? '儲存中…' : '已自動儲存' }}</span>
      <button class="danger sm" @click="removePost">刪除</button>
    </div>

    <p v-if="post.missing.length" class="warnbox small">
      AI 判斷這則還缺：{{ post.missing.join('、') }}。文案裡是用［待補］佔位的，發佈前記得補上。
    </p>

    <div class="cols">
      <main class="col-main stack">
        <!-- 圖片放在文字編輯上面 -->
        <section class="card pad stack">
          <div class="row wrap">
            <strong class="h2">圖片</strong>
            <span class="tiny faint">{{ post.images.length }} 張</span>
            <span class="spacer grow" />
            <button class="primary sm" @click="openFolder">開啟圖片資料夾</button>
          </div>
          <div v-if="post.images.length" class="imgs">
            <div
              v-for="(img, i) in post.images"
              :key="img.file"
              class="imgcell"
              :class="{ off: !img.selected, dragging: dragFrom === i, over: dragOver === i && dragFrom !== i }"
              draggable="true"
              @dragstart="onDragStart(i, $event)"
              @dragover.prevent="dragOver = i"
              @dragleave="dragOver === i && (dragOver = -1)"
              @drop.prevent="onDrop(i)"
              @dragend="dragFrom = -1; dragOver = -1"
            >
              <img :src="`/api/media/posts/${eid}/${img.file}?w=240`" :alt="img.file" draggable="false" loading="lazy" decoding="async" />
              <span v-if="img.selected" class="ord">{{ publishIndex(i) }}</span>
              <span v-else class="ord skip">略</span>
              <label class="pick" :title="img.selected ? '發佈時會帶上' : '發佈時會跳過'">
                <input v-model="img.selected" type="checkbox" @change="saveMeta" />
              </label>
              <span class="fname tiny mono">{{ img.file }}</span>
            </div>
          </div>
          <div v-else class="tiny faint" style="text-align: center; padding: 8px">沒有圖片</div>
          <p class="tiny muted" style="margin: 0">
            <b>拖曳換順序</b>，左上角是發佈順序，第一張是封面；沒勾的會跳過。
          </p>
          <details v-if="post.images.length" class="small">
            <summary class="muted">標繪師（會組成（繪師：…））</summary>
            <div v-for="img in post.images" :key="img.file" class="row" style="gap: 6px; margin-top: 6px">
              <span class="tiny faint mono" style="width: 54px">{{ img.file }}</span>
              <input v-model="img.artist" type="text" class="sm-in grow" placeholder="@handle" @change="saveMeta" />
            </div>
            <div v-if="artists.length" class="row" style="gap: 6px; margin-top: 8px">
              <code class="mono tiny">（繪師：{{ artists.join(' ') }}）</code>
              <button class="sm" @click="insertArtists">插入文案</button>
            </div>
          </details>
        </section>

        <section class="card">
          <div class="tabs">
            <button
              v-for="v in post.variants"
              :key="v.id"
              class="tab"
              :class="{ on: v.id === activeId }"
              @click="activeId = v.id"
            >
              <span>{{ v.label }}</span>
              <span class="tiny plat">{{ getPlatform(v.platform).short }}</span>
              <span v-if="errCount(v)" class="tiny err">{{ errCount(v) }}</span>
              <span v-if="v.locked" class="tiny" title="已鎖定">🔒</span>
            </button>
            <span class="spacer grow" />
            <button class="tab add" :disabled="regenerating" @click="regenOpen = !regenOpen">
              {{ regenerating ? '重新撰寫中…' : '重新撰寫' }}
            </button>
          </div>

          <div v-if="regenOpen" class="regen pad stack">
            <div class="field">
              <label>要 AI 怎麼改？（選填，留空就照原本的規範重寫）</label>
              <input
                v-model="regenExtra"
                type="text"
                class="sm-in"
                placeholder="例：語氣再輕鬆一點、改成條列式、開頭直接講日期、多強調限定商品"
                @keyup.enter="regenerate"
              />
            </div>
            <div class="row wrap" style="gap: 8px">
              <select v-model.number="regenPer" class="sm-in" style="width: 118px">
                <option :value="1">每平台 1 版</option>
                <option :value="2">每平台 2 版</option>
                <option :value="3">每平台 3 版</option>
              </select>
              <span class="tiny muted grow">
                會取代所有<strong>沒鎖定</strong>的版本；鎖定的不動。
              </span>
              <button class="ghost" @click="regenOpen = false">取消</button>
              <button class="primary" :disabled="regenerating" @click="regenerate">
                {{ regenerating ? '撰寫中…' : '開始重寫' }}
              </button>
            </div>
          </div>

          <div v-if="active" class="pad stack">
            <div class="row wrap" style="gap: 8px">
              <select v-model="active.platform" class="sm-in" style="width: 128px" @change="saveVariant()">
                <option v-for="p in PLATFORMS" :key="p.key" :value="p.key">{{ p.name }}</option>
              </select>
              <label class="chk" :class="{ on: active.locked }">
                <input v-model="active.locked" type="checkbox" @change="saveVariant()" />鎖定（重新撰寫不覆蓋）
              </label>
              <span class="spacer grow" />
              <span v-if="active.note" class="tiny muted vnote">{{ active.note }}</span>
            </div>

            <textarea
              ref="taEl"
              v-model="active.body"
              class="editor-ta"
              rows="16"
              spellcheck="false"
              @input="queueSave"
            />

            <div class="row wrap" style="gap: 8px">
              <button class="primary" @click="copyAll">複製全文</button>
              <button v-if="commentText" @click="copyComment">複製留言網址</button>
              <button class="ghost sm danger" @click="removeVariant">刪除這個版本</button>
              <span class="spacer grow" />
              <span class="tiny faint">複製全文＝正文＋來源＋tag，一次貼上</span>
            </div>

            <div class="links">
              <div class="row wrap" style="gap: 6px">
                <strong class="small">留言連結</strong>
                <span class="tiny muted grow">正文不放網址，這些貼到第一則留言</span>
                <button class="sm" @click="post.links.push({ url: '', label: '' }); saveMeta()">＋</button>
              </div>
              <div v-for="(l, i) in post.links" :key="i" class="row" style="gap: 5px; margin-top: 5px">
                <input v-model="l.label" type="text" class="sm-in" style="width: 92px" placeholder="標籤" @change="saveMeta" />
                <input v-model="l.url" type="url" class="sm-in grow mono" placeholder="https://…" @change="saveMeta" />
                <button class="ghost sm danger" @click="post.links.splice(i, 1); saveMeta()">刪</button>
              </div>
              <div v-if="commentText" class="commentbox tiny mono">{{ commentText }}</div>
    
            </div>

            <!-- 發佈 -->
            <div class="pub">
              <div class="row wrap" style="gap: 8px">
                <strong class="small">發佈</strong>
                <span class="spacer grow" />
                <span v-if="!fb?.connected" class="tiny muted">
                  還沒連接，到<NuxtLink to="/settings">設定</NuxtLink>頁連接
                </span>
              </div>

              <div v-if="fb?.appMode?.likelyHidden" class="devwarn tiny">
                ⚠ 發到 Facebook 可能只有你看得到，先看<NuxtLink to="/settings">設定</NuxtLink>頁。
              </div>

              <div class="plats">
                <label v-for="p in pubTargets" :key="p.key" class="plat" :class="{ on: pubPlats.includes(p.key), off: !p.ready }">
                  <input v-model="pubPlats" type="checkbox" :value="p.key" :disabled="!p.ready" />
                  <span class="pname">{{ p.name }}</span>
                  <span class="tiny faint">{{ p.hint }}</span>
                </label>
              </div>

              <div class="row wrap" style="gap: 8px">
                <select v-model="pubWhen" class="sm-in" style="width: 104px" @change="onWhenChange">
                  <option value="now">立即發佈</option>
                  <option value="later">排程發佈</option>
                </select>
                <input v-if="pubWhen === 'later'" v-model="pubAt" type="datetime-local" class="sm-in" style="width: 190px" />
                <label v-if="pubWhen === 'later' && pubPlats.includes('facebook')" class="chk sm" :class="{ on: useMetaSchedule }">
                  <input v-model="useMetaSchedule" type="checkbox" />FB 交給 Meta
                </label>
                <span class="spacer grow" />
                <button class="primary" :disabled="pubBusy || !pubPlats.length" @click="publish">
                  {{ pubBusy ? '處理中…' : pubWhen === 'now' ? `發佈（${pubPlats.length}）` : `排程（${pubPlats.length}）` }}
                </button>
              </div>

              <!-- 發佈可能要一兩分鐘（傳圖、等容器處理），只寫「處理中」看不出跑到哪 -->
              <div v-if="pubSteps.length" class="steps">
                <div v-for="st in pubSteps" :key="st.key" class="stepline tiny" :class="st.state">
                  <span class="dot" />
                  <span class="sname">{{ platName(st.key) }}</span>
                  <span class="stext">{{ st.text }}</span>
                </div>
              </div>

              <p class="tiny faint" style="margin: 0">
                {{ selectedImages.length }} 張圖。
                <template v-if="pubWhen === 'later'">
                  <template v-if="useMetaSchedule && pubPlats.includes('facebook')">
                    FB 交給 Meta，關機照發；
                  </template>
                  <b>其餘平台要工具開著才會發。</b>
                </template>
                <template v-else-if="commentText">導流連結貼成第一則留言。</template>
              </p>

              <div v-if="pubMsg" class="pubbox tiny" :class="pubErr ? 'err' : ''">
                <div style="white-space: pre-wrap">{{ pubMsg }}</div>
                <a v-if="pubLink" :href="pubLink" target="_blank" class="tiny">開啟 ↗</a>
              </div>

              <div v-if="pending.length" class="stack" style="gap: 5px">
                <strong class="tiny">待發排程</strong>
                <div v-for="it in pending" :key="it.id" class="row tiny sched">
                  <span class="badge">{{ platName(it.platform) }}</span>
                  <span class="mono">{{ it.at.slice(0, 16).replace('T', ' ') }}</span>
                  <span class="spacer grow" />
                  <button class="ghost sm danger" @click="cancelSchedule(it.id)">取消</button>
                </div>
              </div>
            </div>

            <!-- 反饋優化 -->
            <div class="fb">
              <div class="row wrap" style="gap: 8px">
                <strong class="small">反饋優化</strong>
                <span class="tiny muted grow">
                  這個版本你改完、確定要用了，按一下讓 AI 比對它跟原稿的差異，把你的偏好記起來。
                </span>
                <button :disabled="fbBusy || !changedFromOrigin" @click="feedback">
                  {{ fbBusy ? '學習中…' : '反饋優化' }}
                </button>
              </div>
              <p v-if="!hasOrigin" class="tiny faint" style="margin: 6px 0 0">
                這個版本沒有 AI 原稿，按「重新撰寫」之後就會有。
              </p>
              <p v-else-if="!changedFromOrigin" class="tiny faint" style="margin: 6px 0 0">
                這個版本跟 AI 原稿一樣，改過之後才有東西可以學。
              </p>
              <div v-if="fbMsg" class="fbbox tiny" :class="fbErr ? 'err' : ''">
                <div>{{ fbMsg }}</div>
                <ul v-if="fbRules.length" style="margin: 6px 0 0; padding-left: 18px">
                  <li v-for="(r, i) in fbRules" :key="i">[{{ r.category }}] {{ r.rule }}</li>
                </ul>
                <div v-if="fbDropped.length" class="dropped">
                  這些跟規範衝突，已經擋下來沒記進去：{{ fbDropped.join('；') }}
                </div>
                <NuxtLink v-if="fbRules.length" to="/settings" class="tiny">到設定頁看完整記憶庫 →</NuxtLink>
              </div>
            </div>
          </div>
          <div v-else class="empty small">這則貼文還沒有版本。按右上角「重新撰寫」。</div>
        </section>

        <section v-if="active" class="card pad">
          <LintPanel
            :text="active.body"
            :platform="active.platform"
            :has-links="post.links.length > 0"
            :artists="artists"
          />
        </section>
      </main>

      <aside class="col-side stack">
        <section v-if="active" class="card pad stack">
          <strong class="h2">手機預覽</strong>
          <PreviewCard
            :text="active.body"
            :platform="active.platform"
            :images="selectedImages"
            :comment="commentText"
          />
        </section>

        <details class="card pad">
          <summary class="h2" style="cursor: pointer">詳細資料</summary>
          <div class="stack" style="margin-top: 10px">
            <div class="kv"><span>類型</span>
              <select v-model="post.category" class="sm-in" style="width: 110px" @change="saveMeta">
                <option v-for="c in categoryOptions" :key="c" :value="c">{{ c }}</option>
              </select>
            </div>
            <div class="kv"><span>子型</span><b>{{ post.postType }}</b></div>
            <div class="kv"><span>來源</span><b>{{ post.sourceName || '—' }}</b></div>
            <div v-if="merged" class="kv top">
              <span>原文</span>
              <ol class="srclist tiny">
                <li v-for="(s, i) in post.sources" :key="s.materialId || i">
                  <span class="faint">{{ i === 0 ? '主要' : '補充' }}</span>
                  <a v-if="s.url" :href="s.url" target="_blank">{{ s.title || s.sourceName || s.url }} ↗</a>
                  <span v-else>{{ s.title || s.sourceName || '本地素材' }}</span>
                </li>
              </ol>
            </div>
            <div v-else-if="post.sourceUrl" class="kv">
              <span>原文</span><a :href="post.sourceUrl" target="_blank" class="tiny">開啟 ↗</a>
            </div>
            <div class="kv"><span>狀態</span>
              <select v-model="post.status" class="sm-in" style="width: 110px" @change="saveMeta">
                <option v-for="s in STATUSES" :key="s.key" :value="s.key">{{ s.label }}</option>
              </select>
            </div>
            <div class="field">
              <label>標題</label>
              <input v-model="post.title" type="text" class="sm-in" @change="saveMeta" />
            </div>
            <div class="field">
              <label>素材原文（撰寫時的依據，唯讀參考）</label>
              <template v-if="merged">
                <details v-for="(s, i) in post.sources" :key="s.materialId || i" class="srcnote" :open="i === 0">
                  <summary class="tiny">
                    素材 {{ i + 1 }}{{ i === 0 ? '・主要' : '' }}：{{ s.title || s.sourceName || '（沒有標題）' }}
                  </summary>
                  <pre class="rawnote tiny">{{ s.text || '（無）' }}</pre>
                </details>
              </template>
              <pre v-else class="rawnote tiny">{{ post.note || '（無）' }}</pre>
            </div>
            <div class="row wrap" style="gap: 6px">
              <select v-model="pubPlatform" class="sm-in" style="width: 118px">
                <option v-for="p in PLATFORMS" :key="p.key" :value="p.key">{{ p.name }}</option>
              </select>
              <button class="sm" @click="markPublished">標記已發佈</button>
            </div>
            <div v-for="(r, i) in post.publishRecords" :key="i" class="rec tiny">
              <div class="row" style="gap: 6px">
                <span class="badge">{{ getPlatform(r.platform).short }}</span>
                <span class="badge">{{ modeLabel(r.mode) }}</span>
                <span class="muted">{{ new Date(r.at).toLocaleString('zh-TW') }}</span>
                <span class="spacer grow" />
                <a v-if="r.url" :href="r.url" target="_blank">開啟 ↗</a>
                <button class="ghost sm danger" @click="post.publishRecords.splice(i, 1); saveMeta()">刪</button>
              </div>
              <div v-if="r.scheduledAt" class="faint">排定 {{ new Date(r.scheduledAt).toLocaleString('zh-TW') }}</div>
              <div v-if="r.mode === 'draft'" class="draftwarn">
                這則是「未發佈貼文」——只有你開連結看得到，
                <b>不會出現在粉專動態，Business Suite 裡也找不到</b>。
                <div class="row" style="gap: 6px; margin-top: 4px">
                  <button class="sm primary" :disabled="pubBusy" @click="publishRecordNow(i)">發佈這則</button>
                  <button class="sm ghost" :disabled="pubBusy" @click="checkRecord(i)">查現在的狀態</button>
                </div>
              </div>
              <div v-if="r.comment && !r.commentDone" class="row" style="gap: 6px; margin-top: 4px">
                <span class="warnpill">留言還沒貼</span>
                <button class="sm" :disabled="pubBusy" @click="addComment(i)">補貼留言</button>
              </div>
            </div>
            <div class="tiny faint mono">data/posts/{{ post.id }}</div>
          </div>
        </details>
      </aside>
    </div>
  </div>
  <div v-else class="page empty">載入中…</div>
</template>

<script setup lang="ts">
interface Img { file: string; artist: string; alt: string; sourceUrl: string; selected: boolean }
interface Variant { id: string; label: string; platform: string; locked: boolean; note: string; body: string }
interface PostSource { materialId: string; title: string; url: string; sourceName: string; text: string }
interface Post {
  id: string; title: string; category: string; postType: string; sourceName: string; sourceUrl: string
  sources?: PostSource[]
  platforms: string[]; status: string; missing: string[]; links: { label: string; url: string }[]
  note: string; images: Img[]; publishRecords: { platform: string; at: string; url: string }[]
  variants: Variant[]; createdAt: string; updatedAt: string
}

const route = useRoute()
const id = route.params.id as string
const eid = encodeURIComponent(id)
const { toast, toastErr } = useToast()

const { data, refresh } = await useFetch<Post>(`/api/posts/${eid}`)
const post = ref<Post | null>(data.value ? JSON.parse(JSON.stringify(data.value)) : null)
/** 多則素材合併寫成的貼文，來源與原文要逐則列 */
const merged = computed(() => (post.value?.sources?.length || 0) > 1)
const { data: originData } = await useFetch<Record<string, string>>(`/api/posts/${eid}/origin`, {
  default: () => ({})
})

const activeId = ref<string>(post.value?.variants[0]?.id || '')
const saving = ref(false)
const regenerating = ref(false)
const regenOpen = ref(false)
const regenExtra = ref('')
const regenPer = ref(2)
const taEl = ref<HTMLTextAreaElement | null>(null)
const pubPlatform = ref(post.value?.platforms[0] || 'facebook')

const fbBusy = ref(false)
const fbMsg = ref('')
const fbErr = ref(false)
const fbRules = ref<{ rule: string; category: string }[]>([])

const { data: fb } = await useFetch<{
  connected: boolean; pageName: string
  appMode?: { likelyHidden: boolean } | null
}>('/api/meta/status', { query: { deep: 1 } })
type Plat = 'facebook' | 'instagram' | 'threads'
interface Sched {
  id: string; platform: Plat; at: string; status: string
  externalId: string; url: string; error: string
}

const pubWhen = ref<'now' | 'later'>('now')
const pubPlats = ref<Plat[]>(['facebook'])
const useMetaSchedule = ref(true)
const sched = ref<Sched[]>([])
/** 發佈時各平台跑到哪。只寫「處理中」的話，三個平台加起來兩分鐘完全看不出進度 */
const pubSteps = ref<{ key: Plat; state: 'wait' | 'run' | 'ok' | 'fail'; text: string }[]>([])
function setStep(key: Plat, state: 'wait' | 'run' | 'ok' | 'fail', text: string) {
  const it = pubSteps.value.find(x => x.key === key)
  if (it) {
    it.state = state
    it.text = text
  }
}
const pending = computed(() => sched.value.filter(x => x.status === 'pending'))

const PLAT_NAME: Record<string, string> = {
  facebook: 'Facebook', instagram: 'Instagram', threads: 'Threads'
}
const platName = (k: string) => PLAT_NAME[k] || k

const { data: plats } = await useFetch<{
  instagram: { connected: boolean }; threads: { connected: boolean }
}>('/api/meta/platforms')

/** 沒接的平台不給勾，並且直接說為什麼 */
const pubTargets = computed(() => {
  const chars = [...(active.value?.body || '')].length
  const imgs = selectedImages.value.length
  return [
    {
      key: 'facebook' as Plat,
      name: 'Facebook',
      ready: !!fb.value?.connected,
      hint: fb.value?.connected ? fb.value.pageName : '未連接專頁'
    },
    {
      key: 'instagram' as Plat,
      name: 'Instagram',
      ready: !!plats.value?.instagram.connected && imgs > 0,
      hint: !plats.value?.instagram.connected
        ? '未連接'
        : !imgs
          ? '一定要有圖'
          : `${imgs} 張圖`
    },
    {
      key: 'threads' as Plat,
      name: 'Threads',
      ready: !!plats.value?.threads.connected && chars <= 500,
      hint: !plats.value?.threads.connected
        ? '未連接'
        : chars > 500
          ? `${chars} 字，超過 500 上限`
          : `${chars} / 500 字`
    }
  ]
})

/** datetime-local 要的是本地時間字串，不能直接用 toISOString（那是 UTC） */
function localDatetime(ms: number) {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000)
  return d.toISOString().slice(0, 16)
}
/**
 * 切到排程時先填一小時後。Facebook 規定至少 10 分鐘之後，
 * 但留一小時才有時間回頭看一眼再決定要不要提前發。
 */
function onWhenChange() {
  if (pubWhen.value === 'later' && !pubAt.value) pubAt.value = localDatetime(Date.now() + 3600_000)
}
const pubAt = ref('')
const pubBusy = ref(false)
const pubMsg = ref('')
const pubErr = ref(false)
const pubLink = ref('')

const MODE_LABEL: Record<string, string> = { now: '立即', draft: '未發佈', schedule: '排程' }
const modeLabel = (m?: string) => MODE_LABEL[m || 'now'] || m || '立即'

/** 三個平台都在這裡分派：立即就直接發，排程就進佇列（FB 可選送 Meta） */
async function publish() {
  const v = active.value
  if (!v || !pubPlats.value.length) return
  await flush()
  pubBusy.value = true
  pubMsg.value = ''
  pubErr.value = false
  pubLink.value = ''
  try {
    if (pubWhen.value === 'later') {
      if (!pubAt.value) throw new Error('排程要先選時間')
      pubSteps.value = pubPlats.value.map(k => ({ key: k, state: 'run' as const, text: '排程中…' }))
      const r = await $fetch<{ added: unknown[]; metaScheduled: unknown[]; lintIssues: string[]; post: Post }>('/api/schedule', {
        method: 'POST',
        body: {
          postId: id,
          variantId: v.id,
          platforms: pubPlats.value,
          at: new Date(pubAt.value).toISOString(),
          useMeta: useMetaSchedule.value
        }
      })
      post.value = JSON.parse(JSON.stringify(r.post))
      for (const k of pubPlats.value) setStep(k, 'ok', '已排程')
      await loadSchedule()
      const lines: string[] = []
      if (r.metaScheduled.length) lines.push('Facebook 已送到 Meta 排程，電腦關機也會發。')
      if (r.added.length) lines.push(`${r.added.length} 個平台進了本機佇列 —— 那個時間點工具要開著才會發。`)
      if (r.lintIssues?.length) lines.push('⚠ 規範提醒（沒有擋下排程）：' + r.lintIssues.join('；'))
      pubMsg.value = lines.join(String.fromCharCode(10))
      toast('已排程')
      return
    }

    // 立即發佈：一個平台一支請求，失敗的不影響其他平台
    const done: string[] = []
    const failed: string[] = []
    const lintNotes: string[] = []
    pubSteps.value = pubPlats.value.map(k => ({ key: k, state: 'wait' as const, text: '等待中' }))

    for (const platform of pubPlats.value) {
      setStep(
        platform,
        'run',
        platform === 'facebook' ? '上傳圖片並發佈…' : '上傳圖片、等平台處理…（可能要一分鐘）'
      )
      try {
        const r = await $fetch<{
          permalink: string; photos: number; commentId: string
          commentSkipped: string; notes: string[]; lintIssues: string[]; post: Post
        }>('/api/meta/publish', {
          method: 'POST',
          body: { postId: id, variantId: v.id, platform, fbMode: 'now' }
        })
        post.value = JSON.parse(JSON.stringify(r.post))
        if (!pubLink.value) pubLink.value = r.permalink
        done.push(
          `${platName(platform)} 已發佈｜${r.photos} 張圖` +
            (r.commentId ? '｜留言已貼' : r.commentSkipped ? `｜${r.commentSkipped}` : '') +
            (r.notes?.length ? `｜${r.notes.join('；')}` : '')
        )
        // 規範問題只提醒，不擋發佈 —— 總會有特例
        if (r.lintIssues?.length) lintNotes.push(...r.lintIssues)
        setStep(platform, 'ok', `已發佈｜${r.photos} 張圖${r.commentId ? '、留言已貼' : ''}`)
      } catch (e) {
        failed.push(`${platName(platform)} 失敗：${errMsg(e)}`)
        setStep(platform, 'fail', errMsg(e))
      }
    }
    pubErr.value = failed.length > 0
    const warn = [...new Set(lintNotes)]
    pubMsg.value = [
      ...done,
      ...failed,
      ...(warn.length ? ['⚠ 規範提醒（沒有擋下發佈）：' + warn.join('；')] : [])
    ].join(String.fromCharCode(10))
    if (done.length) toast(`已發佈到 ${done.length} 個平台`)
  } catch (e) {
    pubErr.value = true
    pubMsg.value = errMsg(e)
  } finally {
    pubBusy.value = false
  }
}

async function loadSchedule() {
  try {
    const r = await $fetch<{ items: Sched[] }>('/api/schedule', { params: { postId: id } })
    sched.value = r.items
  } catch {
    sched.value = []
  }
}

async function cancelSchedule(sid: string) {
  if (!confirm('取消這筆排程？')) return
  try {
    await $fetch(`/api/schedule/${sid}`, { method: 'DELETE' })
    await loadSchedule()
    toast('已取消')
  } catch (e) {
    toastErr(errMsg(e))
  }
}

async function addComment(recordIndex: number) {
  pubBusy.value = true
  try {
    const r = await $fetch<{ post: Post }>('/api/meta/comment', {
      method: 'POST',
      body: { postId: id, recordIndex }
    })
    post.value = JSON.parse(JSON.stringify(r.post))
    toast('留言已貼')
  } catch (e) {
    toastErr(errMsg(e))
  } finally {
    pubBusy.value = false
  }
}
/**
 * 把舊的「未發佈貼文」轉成公開。
 * published=false 建出來的貼文在 Business Suite 裡找不到，這是它唯一的出口。
 */
async function publishRecordNow(i: number) {
  const rec = post.value?.publishRecords[i]
  if (!rec?.externalId) return
  if (!confirm('這會把這則貼文公開到粉專，馬上就會出現在動態上。確定嗎？')) return
  pubBusy.value = true
  try {
    const r = await $fetch<{ post: Post; alreadyPublished?: boolean; commentId?: string; permalink: string }>(
      '/api/meta/publish-now',
      { method: 'POST', body: { postId: id, externalId: rec.externalId } }
    )
    post.value = JSON.parse(JSON.stringify(r.post))
    pubLink.value = r.permalink
    pubErr.value = false
    pubMsg.value = r.alreadyPublished
      ? '這則本來就已經是公開的了。'
      : '已公開' + (r.commentId ? '，留言也貼上了。' : '。')
    toast(r.alreadyPublished ? '本來就是公開的' : '已公開到粉專')
  } catch (e) {
    pubErr.value = true
    pubMsg.value = errMsg(e)
    toastErr(errMsg(e))
  } finally {
    pubBusy.value = false
  }
}

/** 直接問 Facebook 這則現在到底發出去了沒 */
async function checkRecord(i: number) {
  const rec = post.value?.publishRecords[i]
  if (!rec?.externalId) return
  pubBusy.value = true
  try {
    const r = await $fetch<{ isPublished: boolean; permalink: string; scheduledPublishTime: number }>(
      '/api/meta/post-state',
      { params: { externalId: rec.externalId } }
    )
    pubLink.value = r.permalink
    pubErr.value = false
    pubMsg.value = r.isPublished
      ? '已經是公開貼文了。'
      : r.scheduledPublishTime
        ? `還沒公開，排定 ${new Date(r.scheduledPublishTime * 1000).toLocaleString('zh-TW')} 發佈。`
        : '還沒公開，而且沒有排程時間——只有你開連結看得到。'
  } catch (e) {
    pubErr.value = true
    pubMsg.value = errMsg(e)
  } finally {
    pubBusy.value = false
  }
}

const fbDropped = ref<string[]>([])

const active = computed(() => post.value?.variants.find(v => v.id === activeId.value) || null)
const categoryOptions = computed(() => {
  const cur = post.value?.category
  return [...new Set([...CATEGORIES, ...(cur ? [cur] : [])])]
})
const selectedImages = computed(() =>
  (post.value?.images || []).filter(i => i.selected).map(i => `/api/media/posts/${eid}/${i.file}?w=800`)
)
const artists = computed(() =>
  [...new Set((post.value?.images || []).map(i => i.artist.trim()).filter(Boolean))]
)
const commentText = computed(() =>
  (post.value?.links || [])
    .filter(l => l.url.trim())
    .map(l => (l.label.trim() ? `${l.label.trim()}：${l.url.trim()}` : l.url.trim()))
    .join('\n')
)
const hasOrigin = computed(() => {
  const v = active.value
  return !!v && typeof originData.value?.[v.id] === 'string'
})
/** 有 AI 原稿、而且被改過，才有東西可以學 */
const changedFromOrigin = computed(() => {
  const v = active.value
  if (!v) return false
  const o = originData.value?.[v.id]
  return typeof o === 'string' && o.trim() !== v.body.trim()
})

useHead(() => ({ title: (post.value?.title || '貼文') + ' — 貼文工作台' }))

function errMsg(e: unknown) {
  return (e as { data?: { message?: string } }).data?.message || (e as Error).message
}

async function reload() {
  await refresh()
  if (data.value) {
    const keep = activeId.value
    post.value = JSON.parse(JSON.stringify(data.value))
    activeId.value = post.value!.variants.some(v => v.id === keep) ? keep : post.value!.variants[0]?.id || ''
  }
}

async function saveMeta() {
  if (!post.value) return
  saving.value = true
  try {
    const { variants, ...meta } = post.value
    await $fetch(`/api/posts/${eid}`, { method: 'PUT', body: meta })
  } catch (e) {
    toastErr('儲存失敗：' + errMsg(e))
  } finally {
    saving.value = false
  }
}

let timer: ReturnType<typeof setTimeout> | null = null
let pendingVid = ''
function queueSave() {
  if (timer) clearTimeout(timer)
  pendingVid = activeId.value
  saving.value = true
  const vid = pendingVid
  timer = setTimeout(() => saveVariant(vid), 700)
}
function flush() {
  if (timer && pendingVid) {
    clearTimeout(timer)
    timer = null
    const vid = pendingVid
    pendingVid = ''
    return saveVariant(vid)
  }
}
watch(activeId, (_n, o) => {
  if (o && pendingVid === o) flush()
  fbMsg.value = ''
  fbRules.value = []
  fbDropped.value = []
})
onBeforeUnmount(() => { flush() })
onMounted(loadSchedule)

async function saveVariant(vid?: string) {
  const v = post.value?.variants.find(x => x.id === (vid || activeId.value))
  if (!v) return
  if (timer && pendingVid === v.id) { clearTimeout(timer); timer = null; pendingVid = '' }
  saving.value = true
  try {
    await $fetch(`/api/posts/${eid}/variants/${v.id}`, {
      method: 'PUT',
      body: { label: v.label, platform: v.platform, locked: v.locked, note: v.note, body: v.body }
    })
  } catch (e) {
    toastErr('儲存失敗：' + errMsg(e))
  } finally {
    saving.value = false
  }
}

async function feedback() {
  const v = active.value
  if (!v) return
  await flush()
  fbBusy.value = true
  fbMsg.value = ''
  fbRules.value = []
  fbDropped.value = []
  fbErr.value = false
  try {
    const r = await $fetch<{
      changed: boolean; summary: string
      rules: { rule: string; category: string }[]
      added: string[]; bumped: { rule: string; weight: number }[]; dropped: string[]; total: number
    }>('/api/feedback', { method: 'POST', body: { postId: id, variantId: v.id } })
    fbRules.value = r.rules || []
    fbDropped.value = r.dropped || []
    if (!r.changed) {
      fbMsg.value = r.summary
    } else if (!r.rules.length) {
      fbMsg.value = '這次的差異看不出穩定偏好，沒有新增規則。' + (r.summary ? `（${r.summary}）` : '')
    } else {
      fbMsg.value =
        `學到 ${r.added.length} 條新規則` +
        (r.bumped.length ? `，${r.bumped.length} 條既有規則加權` : '') +
        `，記憶庫目前 ${r.total} 條。之後撰寫會自動帶上。`
      toast('已記住你的偏好')
    }
  } catch (e) {
    fbErr.value = true
    fbMsg.value = errMsg(e)
  } finally {
    fbBusy.value = false
  }
}

async function regenerate() {
  if (regenerating.value) return
  regenerating.value = true
  await flush()
  try {
    const r = await $fetch<{ created: number; model: string }>('/api/generate', {
      method: 'POST',
      body: { postId: id, perPlatform: regenPer.value, extra: regenExtra.value.trim() }
    })
    await reload()
    regenOpen.value = false
    toast(`${r.model} 重寫了 ${r.created} 個版本`)
  } catch (e) {
    toastErr(errMsg(e))
  } finally {
    regenerating.value = false
  }
}

async function removeVariant() {
  const v = active.value
  if (!v || !confirm(`刪除版本「${v.label}」？`)) return
  await $fetch(`/api/posts/${eid}/variants/${v.id}`, { method: 'DELETE' })
  post.value!.variants = post.value!.variants.filter(x => x.id !== v.id)
  activeId.value = post.value!.variants[0]?.id || ''
}

function insertArtists() {
  const v = active.value
  if (!v) return
  const text = `（繪師：${artists.value.join(' ')}）`
  const el = taEl.value
  if (!el) v.body += '\n' + text
  else {
    const s = el.selectionStart ?? v.body.length
    v.body = v.body.slice(0, s) + text + v.body.slice(s)
  }
  queueSave()
}

function errCount(v: Variant) {
  return lintSummary(lintPost(v.body, { platform: v.platform, hasLinks: (post.value?.links.length || 0) > 0 })).error
}

async function copy(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast(label + '已複製')
  } catch {
    toastErr('複製失敗，請手動選取')
  }
}
const copyAll = () => copy(active.value?.body || '', '全文')
const copyComment = () => copy(commentText.value, '留言網址')

// ── 圖片拖曳排序 ──────────────────────────────────────────────
// 只用原生 HTML5 drag and drop，不為了這個拉一個套件進來
const dragFrom = ref(-1)
const dragOver = ref(-1)

function onDragStart(i: number, e: DragEvent) {
  dragFrom.value = i
  // 不設這個的話 Firefox 不會開始拖
  e.dataTransfer?.setData('text/plain', String(i))
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onDrop(to: number) {
  const from = dragFrom.value
  dragFrom.value = -1
  dragOver.value = -1
  if (from < 0 || from === to || !post.value) return
  const arr = post.value.images
  arr.splice(to, 0, ...arr.splice(from, 1))
  saveMeta()
  toast('圖片順序已更新')
}

/** 發佈時只會帶勾選的圖，所以序號要跳過沒勾的 */
function publishIndex(i: number) {
  return (post.value?.images || []).slice(0, i + 1).filter(x => x.selected).length
}

async function openFolder() {
  try {
    await $fetch('/api/open-folder', { method: 'POST', body: { kind: 'post', id } })
  } catch (e) {
    toastErr(errMsg(e))
  }
}

function markPublished() {
  post.value!.publishRecords.push({ platform: pubPlatform.value, at: new Date().toISOString(), url: '' })
  post.value!.status = 'published'
  saveMeta()
  toast('已標記發佈')
}

async function removePost() {
  if (!confirm(`刪除「${post.value!.title}」？資料夾與圖片會一併刪除，無法復原。`)) return
  await $fetch(`/api/posts/${eid}`, { method: 'DELETE' })
  await navigateTo('/')
}
</script>

<style scoped>
.editor { max-width: 1320px; }
.bar { gap: 10px; margin-bottom: 12px; }
.ghostlink { color: var(--muted); font-size: 13px; }
.warnbox {
  background: var(--warn-soft); color: var(--warn); padding: 9px 12px;
  border-radius: 8px; margin: 0 0 12px;
}
.cols { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
.col-main { flex: 1; min-width: 420px; }
.col-side { width: 400px; flex: none; }
@media (max-width: 900px) {
  .col-side, .col-main { width: 100%; min-width: 0; }
}
.pad { padding: 13px; }
.tabs { display: flex; flex-wrap: wrap; gap: 2px; padding: 7px 8px 0; border-bottom: 1px solid var(--line); }
.tab {
  border: 1px solid transparent; border-bottom: none; background: transparent;
  border-radius: 8px 8px 0 0; padding: 6px 12px; color: var(--muted);
  display: inline-flex; align-items: center; gap: 6px; font-size: 13.5px;
}
.tab.on {
  background: var(--panel); border-color: var(--line); color: var(--text);
  font-weight: 600; margin-bottom: -1px; border-bottom: 1px solid var(--panel);
}
.tab .plat { color: var(--faint); }
.tab .err { color: var(--err); font-weight: 700; }
.tab.add { color: var(--accent); }
.chk {
  display: inline-flex; align-items: center; gap: 4px; font-size: 13px;
  border: 1px solid var(--line); border-radius: 6px; padding: 4px 9px; cursor: pointer;
}
.chk.on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.sm-in { font-size: 13px; padding: 5px 8px; }
.vnote { background: var(--accent-soft); color: var(--accent); padding: 3px 9px; border-radius: 20px; }
.editor-ta {
  min-height: 330px; line-height: 1.85; font-size: 15px; resize: vertical;
  background: var(--panel-2);
}
.links { border-top: 1px dashed var(--line); padding-top: 11px; }
.commentbox {
  background: var(--panel-2); border: 1px dashed var(--line-strong);
  border-radius: 8px; padding: 8px 10px; word-break: break-all; margin-top: 6px;
}
.regen { border-bottom: 1px solid var(--line); background: var(--accent-soft); }
.pub { border-top: 1px dashed var(--line); padding-top: 11px; }
.devwarn {
  border: 1px solid var(--err); border-left-width: 3px;
  background: var(--err-soft); color: var(--err);
  border-radius: 7px; padding: 8px 10px; line-height: 1.65;
}
.devwarn a { color: var(--err); text-decoration: underline; }
.steps { display: flex; flex-direction: column; gap: 3px; }
.stepline { display: flex; align-items: center; gap: 7px; color: var(--muted); }
.stepline .sname { width: 74px; flex: none; font-weight: 600; }
.stepline .stext { min-width: 0; word-break: break-word; }
.stepline .dot {
  width: 7px; height: 7px; border-radius: 50%; flex: none;
  background: var(--line-strong);
}
.stepline.run .dot { background: var(--accent); animation: pulse 1s ease-in-out infinite; }
.stepline.ok .dot { background: var(--ok); }
.stepline.fail .dot { background: var(--err); }
.stepline.ok { color: var(--ok); }
.stepline.fail { color: var(--err); }
.stepline.run { color: var(--text); }
@keyframes pulse { 50% { opacity: 0.3; } }
@media (prefers-reduced-motion: reduce) { .stepline.run .dot { animation: none; } }

.plats { display: flex; flex-direction: column; gap: 5px; }
.plat {
  display: flex; align-items: center; gap: 8px; cursor: pointer;
  border: 1px solid var(--line); border-radius: 7px; padding: 6px 9px;
  background: var(--panel);
}
.plat.on { border-color: var(--accent); background: var(--accent-soft); }
.plat.off { opacity: 0.5; cursor: not-allowed; }
.plat .pname { font-size: 13px; font-weight: 600; }
.plat input { width: 14px; height: 14px; margin: 0; }
.sched { gap: 6px; padding: 3px 0; }
.pubbox {
  margin-top: 8px; background: var(--ok-soft); color: var(--ok);
  padding: 9px 11px; border-radius: 8px; line-height: 1.6;
}
.pubbox.err { background: var(--err-soft); color: var(--err); word-break: break-word; }
.draftwarn {
  margin-top: 5px; padding: 7px 9px; border-radius: 6px;
  background: var(--warn-soft); color: var(--warn); line-height: 1.6;
}
.rec { padding: 6px 0; border-bottom: 1px dashed var(--line); }
.rec:last-child { border-bottom: none; }
.warnpill {
  background: var(--warn-soft); color: var(--warn);
  padding: 2px 8px; border-radius: 20px;
}
.fb { border-top: 1px dashed var(--line); padding-top: 11px; }
.fbbox {
  margin-top: 8px; background: var(--ok-soft); color: var(--ok);
  padding: 9px 11px; border-radius: 8px; line-height: 1.6;
}
.fbbox.err { background: var(--err-soft); color: var(--err); }
.dropped { margin-top: 6px; color: var(--warn); }
.imgs { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
.imgcell {
  position: relative; aspect-ratio: 4 / 3; border-radius: 8px;
  overflow: hidden; background: var(--panel-2);
  cursor: grab; border: 2px solid transparent;
  transition: border-color 0.12s, opacity 0.12s;
}
.imgcell:active { cursor: grabbing; }
.imgcell.dragging { opacity: 0.4; }
/* 拖到哪一格就在那一格左邊畫一條線，看得出會插在哪 */
.imgcell.over { border-left-color: var(--accent); }
.imgcell.off img { opacity: 0.32; filter: grayscale(1); }
.imgcell img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ord {
  position: absolute; top: 5px; left: 5px; min-width: 20px; height: 20px;
  display: flex; align-items: center; justify-content: center;
  background: var(--accent); color: #fff; border-radius: 5px;
  font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums;
  padding: 0 5px;
}
.ord.skip { background: rgba(0, 0, 0, 0.5); font-weight: 400; }
.imgcell .pick {
  position: absolute; top: 4px; right: 4px; width: 22px; height: 22px;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.45); border-radius: 5px;
}
.imgcell .pick input { width: 14px; height: 14px; margin: 0; cursor: pointer; }
.fname {
  position: absolute; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.55);
  color: #fff; padding: 2px 6px; text-align: center;
}
.kv { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.kv > span:first-child { color: var(--muted); width: 44px; flex: none; }
.kv.top { align-items: flex-start; }
.srclist { margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.srclist li { word-break: break-all; }
.srclist .faint { margin-right: 4px; }
.srcnote + .srcnote { margin-top: 6px; }
.srcnote > summary { cursor: pointer; color: var(--muted); margin-bottom: 4px; }
.rawnote {
  margin: 0; font-family: inherit; white-space: pre-wrap; word-break: break-word;
  background: var(--panel-2); border-radius: 7px; padding: 9px 11px;
  max-height: 200px; overflow-y: auto; color: var(--muted); line-height: 1.6;
}
.field > label { font-size: 12px; color: var(--muted); font-weight: 600; }
</style>
