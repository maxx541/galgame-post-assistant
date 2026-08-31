<template>
  <div v-if="m" class="page detail">
    <div class="row wrap bar">
      <NuxtLink to="/inbox" class="ghostlink">← 素材夾</NuxtLink>
      <span class="badge">{{ m.via === 'playwright' ? 'Playwright 讀取' : m.via === 'manual' ? '手動建立' : '網頁抓取' }}</span>
      <span v-if="m.sourceGuess" class="badge">{{ m.sourceGuess }}</span>
      <span v-if="m.postedAt" class="tiny faint">{{ new Date(m.postedAt).toLocaleString('zh-TW') }}</span>
      <span class="spacer grow" />
      <span class="tiny" :class="saving ? 'muted' : 'faint'">{{ saving ? '儲存中…' : '已自動儲存' }}</span>
      <button class="danger sm" @click="del">刪除素材</button>
    </div>

    <p v-if="m.warning" class="warnbox small">{{ m.warning }}</p>

    <div v-if="m.written && m.postId" class="donebox row wrap">
      <span>這則已經撰寫過了。</span>
      <NuxtLink :to="`/posts/${encodeURIComponent(m.postId)}`">開啟貼文 →</NuxtLink>
      <span class="spacer grow" />
      <button class="sm" @click="rewrite">重新撰寫（會另外產生一則新貼文）</button>
    </div>

    <div class="cols">
      <main class="col-main stack">
        <section class="card">
          <div class="row head">
            <strong class="h2">原始內容</strong>
            <span class="tiny faint">{{ charCount }} 字</span>
            <span class="spacer grow" />
            <a v-if="m.finalUrl || m.url" :href="m.finalUrl || m.url" target="_blank" class="tiny">看原文 ↗</a>
            <button class="ghost sm" @click="copyRaw">複製</button>
          </div>
          <textarea
            v-model="m.text"
            class="raw"
            spellcheck="false"
            placeholder="抓不到內文時，可以自己貼上或補充。這段文字就是 AI 撰寫的主要依據。"
            @input="queueSave"
          />
        </section>

        <section class="card pad stack">
          <div class="row">
            <strong class="h2">圖片</strong>
            <span class="tiny faint">{{ m.images.length }} 張，撰寫時會一起送給 AI 看</span>
            <span class="spacer grow" />
            <button class="ghost sm" @click="openFolder">開啟資料夾</button>
          </div>
          <div
            class="drop"
            :class="{ over }"
            @dragover.prevent="over = true"
            @dragleave.prevent="over = false"
            @drop.prevent="onDrop"
            @click="fileEl?.click()"
          >
            <span class="small">拖曳圖片到這裡，或點一下選檔；也可以直接 Ctrl+V 貼上</span>
            <input ref="fileEl" type="file" accept="image/*" multiple hidden @change="onPick" />
          </div>
          <div v-if="m.images.length" class="imgs">
            <div v-for="f in m.images" :key="f" class="imgcell">
              <img :src="`/api/media/inbox/${eid}/${f}`" :alt="f" />
              <button class="del" title="刪除" @click="delImage(f)">×</button>
            </div>
          </div>
        </section>
      </main>

      <aside class="col-side stack">
        <section class="card pad stack">
          <strong class="h2">撰寫</strong>
          <div class="field">
            <label>要寫給哪些平台</label>
            <div class="row wrap" style="gap: 5px">
              <label v-for="p in PLATFORMS" :key="p.key" class="chk" :class="{ on: m.platforms.includes(p.key) }">
                <input v-model="m.platforms" type="checkbox" :value="p.key" @change="queueSave" />{{ p.name }}
              </label>
            </div>
          </div>
          <div class="field">
            <label>版本數</label>
            <select v-model.number="perPlatform" class="sm-in">
              <option :value="1">每平台 1 版</option>
              <option :value="2">每平台 2 版</option>
              <option :value="3">每平台 3 版</option>
            </select>
          </div>
          <div class="field">
            <label>補充指示（選填）</label>
            <textarea
              v-model="m.extra"
              rows="3"
              class="sm-in"
              placeholder="例：語氣輕鬆一點、日期是 9/14 週日、強調這是限定商品"
              @input="queueSave"
            />
          </div>
          <button class="primary" :disabled="writing || !m.platforms.length" @click="write">
            {{ writing ? '撰寫中…' : 'AI 撰寫' }}
          </button>
          <p class="tiny muted" style="margin: 0">
            體裁、子型與待補欄位由 AI 依規範判斷後寫進貼文，這裡不用選。
          </p>
          <p v-if="writeMsg" class="tiny" :class="writeErr ? 'm-err' : 'm-ok'">{{ writeMsg }}</p>
        </section>

        <section class="card pad stack">
          <div class="row">
            <strong class="h2">留言連結</strong>
            <span class="spacer grow" />
            <button class="sm" @click="m.links.push({ url: '', label: '' }); queueSave()">＋</button>
          </div>
          <p class="tiny muted" style="margin: 0">
            內容裡提到的導流連結（不是這則素材本身的網址）。規範第〇節④：正文不放網址，這些會貼到留言。
          </p>
          <div v-for="(l, i) in m.links" :key="i" class="row" style="gap: 5px">
            <input v-model="l.label" type="text" class="sm-in" style="width: 92px" placeholder="標籤" @change="queueSave" />
            <input v-model="l.url" type="url" class="sm-in grow mono" placeholder="https://…" @change="queueSave" />
            <button class="ghost sm danger" @click="m.links.splice(i, 1); queueSave()">刪</button>
          </div>
          <p v-if="!m.links.length" class="tiny faint" style="margin: 0">
            沒有抓到連結。這則內容如果有要導流的網址，按上面的＋自己加。
          </p>
        </section>

        <section class="card pad stack">
          <strong class="h2">來源</strong>
          <div class="field">
            <label>標題（只是給人看的，貼文標題由 AI 下）</label>
            <input v-model="m.title" type="text" class="sm-in" @change="queueSave" />
          </div>
          <div class="field">
            <label>來源名稱／@帳號</label>
            <input v-model="m.sourceGuess" type="text" class="sm-in" @change="queueSave" />
          </div>
          <div class="field">
            <label>網址</label>
            <input v-model="m.url" type="url" class="sm-in mono" @change="queueSave" />
          </div>
        </section>
      </aside>
    </div>
  </div>
  <div v-else class="page empty">載入中…</div>
</template>

<script setup lang="ts">
interface Material {
  id: string; title: string; url: string; finalUrl: string; text: string
  author: string; handle: string; postedAt: string; sourceGuess: string; via: string
  platforms: string[]; extra: string; images: string[]; warning: string
  links: { url: string; label: string }[]
  written: boolean; postId: string; addedAt: string
}

const route = useRoute()
const id = route.params.id as string
const eid = encodeURIComponent(id)
const { toast, toastErr } = useToast()

const { data, refresh } = await useFetch<Material>(`/api/inbox/${eid}`)
const m = ref<Material | null>(data.value ? JSON.parse(JSON.stringify(data.value)) : null)

const saving = ref(false)
const writing = ref(false)
const writeMsg = ref('')
const writeErr = ref(false)
const perPlatform = ref(2)
const over = ref(false)
const fileEl = ref<HTMLInputElement | null>(null)

const charCount = computed(() => [...(m.value?.text || '')].length)
useHead(() => ({ title: (m.value?.title || '素材') + ' — 素材夾' }))

function errMsg(e: unknown) {
  return (e as { data?: { message?: string } }).data?.message || (e as Error).message
}

let timer: ReturnType<typeof setTimeout> | null = null
function queueSave() {
  if (timer) clearTimeout(timer)
  saving.value = true
  timer = setTimeout(save, 600)
}
async function save() {
  if (!m.value) return
  if (timer) { clearTimeout(timer); timer = null }
  saving.value = true
  try {
    await $fetch(`/api/inbox/${eid}`, {
      method: 'PUT',
      body: {
        title: m.value.title,
        text: m.value.text,
        url: m.value.url,
        sourceGuess: m.value.sourceGuess,
        platforms: m.value.platforms,
        extra: m.value.extra,
        links: m.value.links
      }
    })
  } catch (e) {
    toastErr('儲存失敗：' + errMsg(e))
  } finally {
    saving.value = false
  }
}
onBeforeUnmount(() => { if (timer) save() })

async function write() {
  if (!m.value) return
  await save()
  writing.value = true
  writeMsg.value = ''
  writeErr.value = false
  try {
    const r = await $fetch<{ postId: string; created: number; model: string; note: string }>('/api/generate', {
      method: 'POST',
      body: { materialId: id, perPlatform: perPlatform.value }
    })
    toast(`寫好 ${r.created} 個版本`)
    await navigateTo(`/posts/${encodeURIComponent(r.postId)}`)
  } catch (e) {
    writeErr.value = true
    writeMsg.value = errMsg(e)
  } finally {
    writing.value = false
  }
}

async function rewrite() {
  if (!confirm('重新撰寫會另外產生一則新貼文，舊的那則不會被動到。繼續？')) return
  await write()
}

async function upload(files: File[]) {
  const imgs = files.filter(f => f.type.startsWith('image/'))
  if (!imgs.length) return
  try {
    const fd = new FormData()
    imgs.forEach((f, i) => fd.append('f' + i, f, f.name || 'paste.png'))
    await $fetch(`/api/inbox/${eid}/images`, { method: 'POST', body: fd })
    await reload()
    toast(`已加入 ${imgs.length} 張圖`)
  } catch (e) {
    toastErr('上傳失敗：' + errMsg(e))
  }
}
function onDrop(e: DragEvent) {
  over.value = false
  upload([...(e.dataTransfer?.files || [])])
}
function onPick(e: Event) {
  const el = e.target as HTMLInputElement
  upload([...(el.files || [])])
  el.value = ''
}
function onPaste(e: ClipboardEvent) {
  const files: File[] = []
  for (const item of e.clipboardData?.items || []) {
    if (item.kind === 'file') {
      const f = item.getAsFile()
      if (f) files.push(f)
    }
  }
  if (files.length) {
    e.preventDefault()
    upload(files)
  }
}
onMounted(() => window.addEventListener('paste', onPaste))
onBeforeUnmount(() => window.removeEventListener('paste', onPaste))

async function reload() {
  await refresh()
  if (data.value) {
    const keepText = m.value?.text
    m.value = JSON.parse(JSON.stringify(data.value))
    if (keepText !== undefined && m.value) m.value.text = keepText
  }
}

async function delImage(f: string) {
  if (!confirm(`刪除圖片 ${f}？`)) return
  await $fetch(`/api/inbox/${eid}/images/${f}`, { method: 'DELETE' })
  await reload()
}

async function openFolder() {
  try {
    await $fetch('/api/open-folder', { method: 'POST', body: { kind: 'inbox', id } })
  } catch (e) {
    toastErr(errMsg(e))
  }
}

async function copyRaw() {
  try {
    await navigator.clipboard.writeText(m.value?.text || '')
    toast('原始內容已複製')
  } catch {
    toastErr('複製失敗')
  }
}

async function del() {
  if (!confirm('刪除這則素材？圖片會一併刪除。')) return
  await $fetch(`/api/inbox/${eid}`, { method: 'DELETE' })
  await navigateTo('/inbox')
}
</script>

<style scoped>
.detail { max-width: 1200px; }
.bar { gap: 10px; margin-bottom: 12px; }
.ghostlink { color: var(--muted); font-size: 13px; }
.cols { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
.col-main { flex: 1; min-width: 380px; }
.col-side { width: 320px; flex: none; }
@media (max-width: 820px) {
  .col-side, .col-main { width: 100%; min-width: 0; }
}
.pad { padding: 13px; }
.head { padding: 11px 13px; border-bottom: 1px solid var(--line); gap: 8px; }
.raw {
  width: 100%; border: none; border-radius: 0 0 10px 10px; background: var(--panel);
  min-height: 340px; padding: 14px; line-height: 1.75; font-size: 14.5px;
  white-space: pre-wrap; resize: vertical;
}
.raw:focus { box-shadow: none; border-color: transparent; }
.warnbox {
  background: var(--warn-soft); color: var(--warn); padding: 9px 12px;
  border-radius: 8px; margin: 0 0 12px;
}
.donebox {
  background: var(--ok-soft); color: var(--ok); padding: 9px 12px;
  border-radius: 8px; margin: 0 0 12px; gap: 10px; font-size: 14px;
}
.chk {
  display: inline-flex; align-items: center; gap: 4px; font-size: 13px;
  border: 1px solid var(--line); border-radius: 6px; padding: 4px 9px; cursor: pointer;
}
.chk.on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.sm-in { font-size: 13px; padding: 6px 9px; }
.m-ok { color: var(--ok); }
.m-err { color: var(--err); word-break: break-word; }
.drop {
  border: 1.5px dashed var(--line-strong); border-radius: 9px; padding: 12px;
  text-align: center; cursor: pointer; color: var(--muted); transition: 0.12s;
}
.drop:hover, .drop.over { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.imgs { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
.imgcell { position: relative; aspect-ratio: 1; border-radius: 8px; overflow: hidden; background: var(--panel-2); }
.imgcell img { width: 100%; height: 100%; object-fit: cover; display: block; }
.del {
  position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; padding: 0;
  border-radius: 50%; background: rgba(0, 0, 0, 0.6); color: #fff; border: none; line-height: 1;
}
.field > label { font-size: 12px; color: var(--muted); font-weight: 600; }
</style>
