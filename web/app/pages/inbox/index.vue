<template>
  <div class="page">
    <div class="row wrap" style="margin-bottom: 14px">
      <h1 class="h1">素材夾</h1>
      <span class="muted small">收素材 → 看原始內容 → 勾平台 → AI 撰寫 → 才產生貼文</span>
      <span class="spacer grow" />
      <span v-if="unwritten.length" class="badge">{{ unwritten.length }} 則未撰寫</span>
      <span v-if="written.length" class="badge solid" style="background: var(--ok)">{{ written.length }} 則已撰寫</span>
    </div>

    <section class="card stack" style="margin-bottom: 18px">
      <div class="modes">
        <button class="mode" :class="{ on: mode === 'url' }" @click="mode = 'url'">抓網址</button>
        <button class="mode" :class="{ on: mode === 'manual' }" @click="mode = 'manual'">本地素材</button>
      </div>

      <!-- 抓網址 -->
      <div v-if="mode === 'url'" class="pad stack">
        <textarea
          v-model="urlText"
          rows="3"
          class="mono"
          spellcheck="false"
          placeholder="貼上連結，一次可以貼多個（一行一個，或整段文字貼進來也會自動挑出網址）"
          @keydown.ctrl.enter="collect"
        />
        <div class="row wrap" style="gap: 8px">
          <span class="tiny muted">預設平台</span>
          <label v-for="p in PLATFORMS" :key="p.key" class="chk" :class="{ on: defPlatforms.includes(p.key) }">
            <input v-model="defPlatforms" type="checkbox" :value="p.key" />{{ p.name }}
          </label>
          <span class="spacer grow" />
          <span v-if="foundUrls.length" class="tiny muted">找到 {{ foundUrls.length }} 個網址</span>
          <button class="primary" :disabled="collecting || !foundUrls.length" @click="collect">
            {{ collecting ? '抓取中…' : '抓取' }}
          </button>
        </div>
      </div>

      <!-- 本地素材：直接把提供的文字與連結當成原始內容，不抓任何網址 -->
      <div v-else class="pad stack">
        <p class="tiny muted" style="margin: 0">
          用你貼的文字與圖片，不去抓網址。
        </p>
        <div class="row wrap" style="gap: 8px">
          <div class="field grow" style="min-width: 200px">
            <label>標題（選填，留空會取內容第一行）</label>
            <input v-model="man.title" type="text" class="sm-in" />
          </div>
          <div class="field" style="width: 170px">
            <label>來源名稱／@帳號</label>
            <input v-model="man.sourceGuess" type="text" class="sm-in" placeholder="ANIPLEX.EXE" />
          </div>
        </div>
        <div class="field">
          <label>原始內容</label>
          <textarea
            v-model="man.text"
            rows="6"
            spellcheck="false"
            placeholder="把要給 AI 的原始資訊貼在這裡，保留原本的換行就好。內容裡的網址會自動挑成留言連結。"
          />
        </div>

        <div class="field">
          <label>圖片（拖曳、點選或 Ctrl+V 貼上）</label>
          <div
            class="drop"
            :class="{ over }"
            @dragover.prevent="over = true"
            @dragleave.prevent="over = false"
            @drop.prevent="onDrop"
            @click="fileEl?.click()"
          >
            <span class="small">{{ man.files.length ? `已選 ${man.files.length} 張` : '拖曳圖片到這裡，或點一下選檔' }}</span>
            <input ref="fileEl" type="file" accept="image/*" multiple hidden @change="onPick" />
          </div>
          <div v-if="previews.length" class="thumbs">
            <div v-for="(src, i) in previews" :key="i" class="thumb">
              <img :src="src" alt="" />
              <button class="del" @click.stop="removeFile(i)">×</button>
            </div>
          </div>
        </div>

        <div class="row wrap" style="gap: 8px">
          <span class="tiny muted">平台</span>
          <label v-for="p in PLATFORMS" :key="p.key" class="chk" :class="{ on: defPlatforms.includes(p.key) }">
            <input v-model="defPlatforms" type="checkbox" :value="p.key" />{{ p.name }}
          </label>
          <span class="spacer grow" />
          <button class="primary" :disabled="collecting || !(man.text.trim() || man.title.trim())" @click="createManual">
            {{ collecting ? '建立中…' : '存成素材' }}
          </button>
        </div>
      </div>

      <p v-if="collectMsg" class="small pad" :class="collectErr ? 'm-err' : 'm-ok'" style="padding-top: 0">
        {{ collectMsg }}
      </p>
    </section>

    <JobProgress ref="collectJob" kind="collect" style="margin-bottom: 14px" @done="onCollectDone" />
    <JobProgress ref="writeJob" kind="write" style="margin-bottom: 14px" @done="onWriteDone" />

    <div v-if="!items.length" class="empty">素材夾是空的。貼個連結，或切到「本地素材」自己輸入。</div>

    <div class="mgrid">
      <div
        v-for="m in items"
        :key="m.id"
        class="card mcard"
        :class="{ sel: picked.includes(m.id), done: m.written, busy: isWriting(m.id) }"
      >
        <label class="pick">
          <input v-model="picked" type="checkbox" :value="m.id" />
        </label>

        <NuxtLink :to="`/inbox/${encodeURIComponent(m.id)}`" class="mlink">
          <div class="mthumbs">
            <img
              v-for="f in m.images.slice(0, 3)"
              :key="f"
              :src="`/api/media/inbox/${encodeURIComponent(m.id)}/${f}`"
              alt=""
            />
            <div v-if="!m.images.length" class="nothumb tiny faint">無圖</div>
            <span class="viatag tiny">{{ m.via === 'playwright' ? 'X' : m.via === 'manual' ? '本地' : '網頁' }}</span>
          </div>
          <div class="mbody">
            <strong class="mtitle">{{ m.title || '（沒有標題）' }}</strong>
            <pre v-if="m.text" class="raw tiny">{{ m.text }}</pre>
            <p v-else class="tiny faint" style="margin: 0">沒有內文，點進去可以自己補</p>
            <div class="row wrap tiny" style="gap: 5px">
              <span v-if="m.sourceGuess" class="badge">{{ m.sourceGuess }}</span>
              <span class="faint">{{ m.images.length }} 圖</span>
              <span v-if="m.links?.length" class="faint">{{ m.links.length }} 連結</span>
              <span v-if="m.warning" class="warn-dot" :title="m.warning">有警告</span>
            </div>
          </div>
        </NuxtLink>

        <div class="mfoot row wrap">
          <label v-for="p in PLATFORMS" :key="p.key" class="chk sm" :class="{ on: m.platforms.includes(p.key) }">
            <input type="checkbox" :checked="m.platforms.includes(p.key)" @change="togglePlatform(m, p.key)" />{{ p.short }}
          </label>
          <span class="spacer grow" />
          <NuxtLink v-if="m.written && m.postId" :to="`/posts/${encodeURIComponent(m.postId)}`" class="sm-link">
            看貼文 →
          </NuxtLink>
          <button v-else class="sm primary" :disabled="isWriting(m.id)" @click="writeOne(m)">
            {{ isWriting(m.id) ? '撰寫中…' : 'AI 撰寫' }}
          </button>
          <button class="ghost sm danger" :disabled="isWriting(m.id)" @click="del(m)">刪</button>
        </div>
      </div>
    </div>

    <div v-if="items.length" class="quickbar card">
      <div class="row wrap" style="gap: 8px">
        <label class="chk" :class="{ on: allPicked }">
          <input type="checkbox" :checked="allPicked" @change="toggleAll" />全選未撰寫
        </label>
        <button class="ghost sm" :disabled="!written.length" @click="pickWritten">
          選已撰寫（{{ written.length }}）
        </button>
        <button v-if="picked.length" class="ghost sm" @click="picked = []">取消選取</button>
        <span class="small muted">已選 {{ picked.length }} 則</span>

        <span class="spacer grow" />

        <select v-model.number="perPlatform" class="sm-in" style="width: 114px">
          <option :value="1">每平台 1 版</option>
          <option :value="2">每平台 2 版</option>
          <option :value="3">每平台 3 版</option>
        </select>
        <button class="primary" :disabled="bulkBusy || !pickedUnwritten.length" @click="writePicked">
          AI 撰寫（{{ pickedUnwritten.length }}）
        </button>
        <button class="danger" :disabled="bulkBusy || !picked.length" @click="delPicked">
          刪除（{{ picked.length }}）
        </button>
        <button class="danger" :disabled="bulkBusy || !written.length" @click="clearWritten">
          清掉已撰寫的
        </button>
      </div>
      <p class="tiny faint" style="margin: 6px 0 0">刪除會連圖片資料夾一起移除。</p>
      <div v-if="batchMsg" class="tiny" :class="batchErr ? 'm-err' : 'm-ok'" style="margin-top: 6px">{{ batchMsg }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
interface Material {
  id: string; title: string; url: string; finalUrl: string; text: string
  author: string; handle: string; postedAt: string; sourceGuess: string; via: string
  platforms: string[]; extra: string; images: string[]; warning: string
  links: { url: string; label: string }[]
  written: boolean; postId: string; addedAt: string
}

const { toast, toastErr } = useToast()
const { data, refresh } = await useFetch<Material[]>('/api/inbox', { default: () => [] })
const items = computed(() => data.value || [])
const unwritten = computed(() => items.value.filter(m => !m.written))
const written = computed(() => items.value.filter(m => m.written))

const mode = ref<'url' | 'manual'>('url')
const urlText = ref('')
const defPlatforms = ref<string[]>(['facebook'])
const collecting = ref(false)
const collectMsg = ref('')
const collectErr = ref(false)

const man = reactive({ title: '', text: '', sourceGuess: '', files: [] as File[] })
const previews = ref<string[]>([])
const over = ref(false)
const fileEl = ref<HTMLInputElement | null>(null)

const picked = ref<string[]>([])
const perPlatform = ref(2)
/**
 * 正在撰寫的素材 id。以前是單一字串，任何一則在跑就把整頁的按鈕都關掉，
 * 但一則一則寫是各自獨立的請求，沒有理由互相擋——只鎖正在寫的那一則。
 */
const running = ref<string[]>([])
const isWriting = (id: string) => running.value.includes(id)
const batchMsg = ref('')
const batchErr = ref(false)
const bulkBusy = ref(false)
const collectJob = ref<{ attach(id: string): Promise<void> } | null>(null)
const writeJob = ref<{ attach(id: string): Promise<void> } | null>(null)

const URL_RE = /https?:\/\/[^\s<>"'）)、，,。！？；：「」【】]+/g
const foundUrls = computed(() => {
  const found = urlText.value.match(URL_RE) || []
  return [...new Set(found.map(u => u.replace(/[.,;:!?]+$/, '')))]
})
const allPicked = computed(() => unwritten.value.length > 0 && picked.value.length === unwritten.value.length)
/** 撰寫只對還沒寫過的動作；已撰寫的選起來是要拿去刪的 */
const pickedUnwritten = computed(() => unwritten.value.filter(m => picked.value.includes(m.id)))

function errMsg(e: unknown) {
  return (e as { data?: { message?: string } }).data?.message || (e as Error).message
}

// ── 本地素材的圖片 ────────────────────────────────────────────────
function addFiles(files: File[]) {
  const imgs = files.filter(f => f.type.startsWith('image/'))
  if (!imgs.length) return
  man.files = [...man.files, ...imgs]
  previews.value = [...previews.value, ...imgs.map(f => URL.createObjectURL(f))]
}
function removeFile(i: number) {
  URL.revokeObjectURL(previews.value[i] as string)
  man.files = man.files.filter((_, k) => k !== i)
  previews.value = previews.value.filter((_, k) => k !== i)
}
function onDrop(e: DragEvent) {
  over.value = false
  addFiles([...(e.dataTransfer?.files || [])])
}
function onPick(e: Event) {
  const el = e.target as HTMLInputElement
  addFiles([...(el.files || [])])
  el.value = ''
}
function onPaste(e: ClipboardEvent) {
  if (mode.value !== 'manual') return
  const files: File[] = []
  for (const item of e.clipboardData?.items || []) {
    if (item.kind === 'file') {
      const f = item.getAsFile()
      if (f) files.push(f)
    }
  }
  if (files.length) {
    e.preventDefault()
    addFiles(files)
  }
}
onMounted(() => window.addEventListener('paste', onPaste))
onBeforeUnmount(() => {
  window.removeEventListener('paste', onPaste)
  previews.value.forEach(u => URL.revokeObjectURL(u))
})

async function createManual() {
  collecting.value = true
  collectMsg.value = ''
  try {
    const m = await $fetch<Material>('/api/inbox/manual', {
      method: 'POST',
      body: {
        title: man.title,
        text: man.text,
        sourceGuess: man.sourceGuess,
        platforms: defPlatforms.value
      }
    })
    if (man.files.length) {
      const fd = new FormData()
      man.files.forEach((f, i) => fd.append('f' + i, f, f.name || 'paste.png'))
      await $fetch(`/api/inbox/${encodeURIComponent(m.id)}/images`, { method: 'POST', body: fd })
    }
    collectErr.value = false
    collectMsg.value = `已存成素材：${m.title}${man.files.length ? `，含 ${man.files.length} 張圖` : ''}`
    man.title = ''
    man.text = ''
    man.sourceGuess = ''
    man.files = []
    previews.value.forEach(u => URL.revokeObjectURL(u))
    previews.value = []
    await refresh()
    toast('素材已建立')
  } catch (e) {
    collectErr.value = true
    collectMsg.value = errMsg(e)
  } finally {
    collecting.value = false
  }
}

async function collect() {
  if (!foundUrls.value.length) return
  collecting.value = true
  collectMsg.value = ''
  try {
    const r = await $fetch<{ jobId: string; total: number }>('/api/inbox/collect', {
      method: 'POST',
      body: { urls: foundUrls.value, platforms: defPlatforms.value }
    })
    await collectJob.value?.attach(r.jobId)
    collectErr.value = false
    collectMsg.value = `${r.total} 個連結交給背景抓，可以切去別頁。`
    urlText.value = ''
  } catch (e) {
    collectErr.value = true
    collectMsg.value = errMsg(e)
  } finally {
    collecting.value = false
  }
}

async function togglePlatform(m: Material, key: string) {
  const next = m.platforms.includes(key) ? m.platforms.filter(p => p !== key) : [...m.platforms, key]
  m.platforms = next
  try {
    await $fetch(`/api/inbox/${encodeURIComponent(m.id)}`, { method: 'PUT', body: { platforms: next } })
  } catch (e) {
    toastErr(errMsg(e))
  }
}

function toggleAll() {
  picked.value = allPicked.value ? [] : unwritten.value.map(m => m.id)
}

/** 單則撰寫。批次走伺服器端的工作，這支只給卡片上那顆按鈕用 */
async function writeOne(m: Material) {
  if (isWriting(m.id)) return
  running.value = [...running.value, m.id]
  try {
    const r = await $fetch<{ postId: string; created: number }>('/api/generate', {
      method: 'POST',
      body: { materialId: m.id, perPlatform: perPlatform.value }
    })
    toast(`寫好 ${r.created} 個版本`)
    await refresh()
    return r
  } catch (e) {
    toastErr(errMsg(e))
  } finally {
    running.value = running.value.filter(x => x !== m.id)
  }
}

/**
 * 批次撰寫。整批交給伺服器跑 —— 以前這個迴圈跑在頁面元件裡，
 * 一切到別頁元件就被卸載，進度接不回來，看起來就像中斷了。
 */
async function writePicked() {
  const targets = pickedUnwritten.value
  if (!targets.length) return
  bulkBusy.value = true
  batchMsg.value = ''
  try {
    const r = await $fetch<{ jobId: string; total: number }>('/api/generate/batch', {
      method: 'POST',
      body: { materialIds: targets.map(m => m.id), perPlatform: perPlatform.value }
    })
    await writeJob.value?.attach(r.jobId)
    picked.value = []
    batchErr.value = false
    batchMsg.value = `已經交給背景跑 ${r.total} 則，可以切去別頁，回來進度還在。`
  } catch (e) {
    batchErr.value = true
    batchMsg.value = errMsg(e)
    toastErr(errMsg(e))
  } finally {
    bulkBusy.value = false
  }
}

function pickWritten() {
  picked.value = written.value.map(m => m.id)
}

async function onWriteDone(j: { status: string; done: number; total: number }) {
  await refresh()
  if (j.status === 'done') toast(`批次撰寫完成，${j.done} / ${j.total} 則`)
}

async function onCollectDone(j: { status: string; result: unknown }) {
  await refresh()
  const r = (j.result || {}) as { added?: number; failed?: number }
  if (j.status === 'done') toast(`抓到 ${r.added || 0} 則${r.failed ? `，${r.failed} 則失敗` : ''}`)
}

/** 批量刪除。連資料夾帶圖片一起清掉，不留空殼 */
async function delPicked() {
  const n = picked.value.length
  if (!n) return
  if (!confirm(`刪除選取的 ${n} 則素材？資料夾與圖片會一併刪除，無法復原。`)) return
  await runBulkDelete({ mode: 'ids', ids: picked.value })
}

async function clearWritten() {
  const n = written.value.length
  if (!n) return
  if (!confirm(`清掉 ${n} 則「已撰寫」的素材？貼文不受影響，但素材資料夾與圖片會刪除。`)) return
  await runBulkDelete({ mode: 'written' })
}

async function runBulkDelete(body: Record<string, unknown>) {
  bulkBusy.value = true
  batchMsg.value = ''
  try {
    const r = await $fetch<{ deleted: number; bytes: number; failed: { message: string }[] }>(
      '/api/inbox/bulk-delete',
      { method: 'POST', body }
    )
    picked.value = []
    await refresh()
    batchErr.value = r.failed.length > 0
    batchMsg.value =
      `刪掉 ${r.deleted} 則，釋出 ${(r.bytes / 1048576).toFixed(1)}MB` +
      (r.failed.length ? `，${r.failed.length} 則失敗：${r.failed[0]?.message}` : '')
    toast(`已刪除 ${r.deleted} 則`)
  } catch (e) {
    batchErr.value = true
    batchMsg.value = errMsg(e)
    toastErr(errMsg(e))
  } finally {
    bulkBusy.value = false
  }
}

async function del(m: Material) {
  if (!confirm(`刪除素材「${m.title || m.id}」？資料夾與圖片會一併刪除。`)) return
  try {
    await $fetch(`/api/inbox/${encodeURIComponent(m.id)}`, { method: 'DELETE' })
    picked.value = picked.value.filter(x => x !== m.id)
    await refresh()
    toast('已刪除')
  } catch (e) {
    // 以前這裡沒有 try/catch，失敗就靜靜什麼都不發生，看起來就是按鈕壞掉
    toastErr(errMsg(e))
  }
}
</script>

<style scoped>
.pad { padding: 13px; }
.modes { display: flex; gap: 2px; padding: 7px 8px 0; border-bottom: 1px solid var(--line); }
.mode {
  border: 1px solid transparent; border-bottom: none; background: transparent;
  border-radius: 8px 8px 0 0; padding: 7px 16px; color: var(--muted); font-size: 14px;
}
.mode.on {
  background: var(--panel); border-color: var(--line); color: var(--text);
  font-weight: 600; margin-bottom: -1px; border-bottom: 1px solid var(--panel);
}
.chk {
  display: inline-flex; align-items: center; gap: 4px; font-size: 13px;
  border: 1px solid var(--line); border-radius: 6px; padding: 4px 9px; cursor: pointer;
}
.chk.sm { font-size: 12px; padding: 2px 7px; }
.chk.on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.sm-in { font-size: 13px; padding: 5px 8px; }
.m-ok { color: var(--ok); margin: 0; }
.m-err { color: var(--err); margin: 0; }
.field > label { font-size: 12px; color: var(--muted); font-weight: 600; }
.drop {
  border: 1.5px dashed var(--line-strong); border-radius: 9px; padding: 14px;
  text-align: center; cursor: pointer; color: var(--muted); transition: 0.12s;
}
.drop:hover, .drop.over { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.thumbs { display: grid; grid-template-columns: repeat(auto-fill, minmax(90px, 1fr)); gap: 7px; margin-top: 8px; }
.thumb { position: relative; aspect-ratio: 1; border-radius: 7px; overflow: hidden; background: var(--panel-2); }
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.thumb .del {
  position: absolute; top: 3px; right: 3px; width: 20px; height: 20px; padding: 0;
  border-radius: 50%; background: rgba(0, 0, 0, 0.6); color: #fff; border: none; line-height: 1;
}

.mgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 14px; padding-bottom: 20px; }
.mcard { position: relative; display: flex; flex-direction: column; overflow: hidden; }
.mcard.sel { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
.mcard.done { opacity: 0.72; }
.mcard.busy { border-color: var(--accent); }
.pick {
  position: absolute; top: 8px; left: 8px; z-index: 2;
  background: var(--panel); border-radius: 5px; padding: 3px 5px; line-height: 0;
}
.mlink { color: inherit; display: block; }
.mlink:hover { text-decoration: none; }
.mlink:hover .mtitle { color: var(--accent); }
.mthumbs {
  position: relative; display: flex; gap: 2px; height: 116px;
  background: var(--panel-2); border-bottom: 1px solid var(--line);
}
.mthumbs img { flex: 1; min-width: 0; object-fit: cover; height: 100%; }
.nothumb { display: grid; place-items: center; width: 100%; }
.viatag {
  position: absolute; right: 6px; top: 6px; background: rgba(0, 0, 0, 0.6);
  color: #fff; padding: 1px 7px; border-radius: 20px;
}
.mbody { padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.mtitle {
  line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2;
  -webkit-box-orient: vertical; overflow: hidden;
}
.raw {
  margin: 0; font-family: inherit; white-space: pre-wrap; word-break: break-word;
  color: var(--muted); line-height: 1.55; max-height: 5.2em; overflow: hidden;
  border-left: 2px solid var(--line); padding-left: 8px;
}
.warn-dot { color: var(--warn); }
.warn-dot::before { content: '● '; }
.mfoot {
  gap: 4px; padding: 8px 10px; border-top: 1px solid var(--line);
  background: var(--panel-2); margin-top: auto;
}
.sm-link { font-size: 13px; }
.quickbar { position: sticky; bottom: 14px; margin-top: 16px; padding: 10px 13px; z-index: 5; }
</style>
