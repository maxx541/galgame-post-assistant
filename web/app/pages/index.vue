<template>
  <div class="page">
    <div class="row wrap" style="margin-bottom: 16px">
      <h1 class="h1">貼文</h1>
      <span class="muted small">{{ filtered.length }} / {{ posts.length }} 則</span>
      <span class="spacer grow" />
      <input v-model="q" type="text" placeholder="搜尋標題、作品、內文…" style="width: 230px" />
      <select v-model="fStatus" style="width: 118px">
        <option value="">全部狀態</option>
        <option v-for="s in STATUSES" :key="s.key" :value="s.key">{{ s.label }}</option>
      </select>
      <select v-model="fCategory" style="width: 118px">
        <option value="">全部類型</option>
        <option v-for="c in categoryOptions" :key="c" :value="c">{{ c }}</option>
      </select>
      <button v-if="posts.length" :class="selecting ? 'primary' : 'ghost'" @click="toggleSelecting">
        {{ selecting ? '完成' : '選取' }}
      </button>
      <NuxtLink to="/inbox" class="btnlink primary">去素材夾寫新的</NuxtLink>
    </div>

    <div v-if="!filtered.length" class="empty">
      <p v-if="!posts.length">
        還沒有貼文。貼文是從<NuxtLink to="/inbox">素材夾</NuxtLink>撰寫完成後產生的。
      </p>
      <p v-else>沒有符合條件的貼文。</p>
    </div>

    <div class="grid">
      <component
        :is="selecting ? 'div' : NuxtLink"
        v-for="p in filtered"
        :key="p.id"
        class="pcard card"
        :class="{ selecting, sel: picked.includes(p.id) }"
        :to="selecting ? undefined : `/posts/${encodeURIComponent(p.id)}`"
        @click="selecting && togglePick(p.id)"
      >
        <div class="thumb">
          <span v-if="selecting" class="pickmark" :class="{ on: picked.includes(p.id) }">✓</span>
          <img v-if="cover(p)" :src="cover(p)!" alt="" loading="lazy" decoding="async" />
          <div v-else class="nothumb tiny faint">無圖</div>
          <span v-if="p.images.length > 1" class="imgcount tiny">{{ p.images.length }} 圖</span>
        </div>
        <div class="body">
          <div class="row wrap" style="gap: 5px">
            <span class="badge">【{{ p.category }}】</span>
            <span class="badge solid" :style="{ background: statusMeta(p.status).color }">
              {{ statusMeta(p.status).label }}
            </span>

          </div>
          <div class="title">{{ p.title }}</div>
          <div class="preview tiny muted">{{ snippet(p) }}</div>
          <div class="row wrap tiny" style="gap: 8px; margin-top: auto">
            <span class="faint">{{ p.variants.length }} 版本</span>
            <span v-if="health(p).error" class="dot err">{{ health(p).error }} 違規</span>
            <span v-else-if="p.variants.length" class="dot ok">符合規範</span>
            <span v-if="health(p).warn" class="dot warn">{{ health(p).warn }} 提醒</span>
            <span v-if="p.missing.length" class="dot warn">待補 {{ p.missing.length }}</span>
            <span class="spacer grow" />
            <span class="faint">{{ shortDate(p.updatedAt) }}</span>
          </div>
        </div>
      </component>
    </div>

    <div v-if="selecting" class="quickbar card">
      <div class="row wrap" style="gap: 8px">
        <label class="chk" :class="{ on: allPicked }">
          <input type="checkbox" :checked="allPicked" :disabled="!filtered.length" @change="toggleAll" />
          全選目前列出的（{{ filtered.length }}）
        </label>
        <button v-if="picked.length" class="ghost sm" @click="picked = []">取消選取</button>
        <span class="small muted">已選 {{ picked.length }} 則</span>
        <span class="spacer grow" />
        <button class="danger" :disabled="deleting || !picked.length" @click="delPicked">
          {{ deleting ? '刪除中…' : `刪除（${picked.length}）` }}
        </button>
      </div>
      <p class="tiny faint" style="margin: 6px 0 0">
        刪除會連圖片資料夾一起移除，對應的素材改回未撰寫，還沒發的本機排程會取消。
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
interface Img { file: string; artist: string; alt: string; sourceUrl: string; selected: boolean }
interface Variant { id: string; label: string; platform: string; locked: boolean; note: string; body: string }
interface Post {
  id: string; title: string; category: string; postType: string; sourceName: string
  platforms: string[]; status: string; missing: string[]; links: { label: string; url: string }[]
  images: Img[]; variants: Variant[]; updatedAt: string
}

const NuxtLink = resolveComponent('NuxtLink')
const { toast, toastErr } = useToast()
const { data, refresh } = await useFetch<Post[]>('/api/posts', { default: () => [] })
const posts = computed(() => data.value || [])

const q = ref('')
const fStatus = ref('')
const fCategory = ref('')

// 清單以設定的類型為主，但資料裡若有舊類型也要列出來，否則那些貼文會篩不到
const categoryOptions = computed(() => {
  const used = new Set(posts.value.map(p => p.category).filter(Boolean))
  return [...new Set([...CATEGORIES, ...used])]
})

const filtered = computed(() =>
  posts.value.filter(p => {
    if (fStatus.value && p.status !== fStatus.value) return false
    if (fCategory.value && p.category !== fCategory.value) return false
    if (q.value.trim()) {
      const s = q.value.trim().toLowerCase()
      const hay = [p.title, p.category, p.postType, p.sourceName, ...p.variants.map(v => v.body)]
        .join('\n')
        .toLowerCase()
      if (!hay.includes(s)) return false
    }
    return true
  })
)

const selecting = ref(false)
const picked = ref<string[]>([])
const deleting = ref(false)

const allPicked = computed(() => filtered.value.length > 0 && filtered.value.every(p => picked.value.includes(p.id)))

function toggleSelecting() {
  selecting.value = !selecting.value
  picked.value = []
}
function togglePick(id: string) {
  picked.value = picked.value.includes(id) ? picked.value.filter(x => x !== id) : [...picked.value, id]
}
function toggleAll() {
  const ids = filtered.value.map(p => p.id)
  picked.value = allPicked.value
    ? picked.value.filter(id => !ids.includes(id))
    : [...new Set([...picked.value, ...ids])]
}

async function delPicked() {
  const ids = picked.value
  if (!ids.length) return
  const names = posts.value.filter(p => ids.includes(p.id)).map(p => `・${p.title}`)
  const list = names.slice(0, 8).join('\n') + (names.length > 8 ? `\n…還有 ${names.length - 8} 則` : '')
  if (!confirm(`刪除這 ${ids.length} 則貼文？資料夾與圖片會一併刪除，無法復原。\n\n${list}`)) return
  deleting.value = true
  try {
    const r = await $fetch<{ deleted: number; failed: { message: string }[] }>('/api/posts/bulk-delete', {
      method: 'POST',
      body: { ids }
    })
    picked.value = []
    await refresh()
    if (r.failed.length) toastErr(`刪掉 ${r.deleted} 則，${r.failed.length} 則失敗：${r.failed[0]?.message}`)
    else toast(`已刪除 ${r.deleted} 則貼文`)
    if (!posts.value.length) selecting.value = false
  } catch (e) {
    toastErr((e as { data?: { message?: string } }).data?.message || String(e))
  } finally {
    deleting.value = false
  }
}

function cover(p: Post) {
  const img = p.images.find(i => i.selected) || p.images[0]
  return img ? `/api/media/posts/${encodeURIComponent(p.id)}/${img.file}?w=480` : null
}
function snippet(p: Post) {
  const v = p.variants[0]
  if (!v) return '尚未撰寫文案'
  return [...v.body.replace(/\s+/g, ' ')].slice(0, 70).join('')
}
function health(p: Post) {
  let error = 0
  let warn = 0
  for (const v of p.variants) {
    const s = lintSummary(lintPost(v.body, { platform: v.platform, hasLinks: p.links.length > 0 }))
    error += s.error
    warn += s.warn
  }
  return { error, warn }
}
function shortDate(iso: string) {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}
</script>

<style scoped>
.btnlink {
  display: inline-flex; align-items: center; padding: 6px 13px; border-radius: 7px;
  border: 1px solid var(--accent); background: var(--accent); color: #fff; font-size: 14px;
}
.btnlink:hover { text-decoration: none; filter: brightness(1.08); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; }
.pcard {
  display: flex; flex-direction: column; overflow: hidden; color: inherit;
  transition: transform 0.12s, box-shadow 0.12s, border-color 0.12s;
}
.pcard:hover {
  text-decoration: none; transform: translateY(-2px);
  border-color: var(--line-strong); box-shadow: 0 4px 20px rgba(0, 0, 0, 0.09);
}
.thumb {
  position: relative; aspect-ratio: 16 / 9; background: var(--panel-2);
  border-bottom: 1px solid var(--line); overflow: hidden;
}
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.nothumb { display: grid; place-items: center; height: 100%; }
.imgcount {
  position: absolute; right: 7px; bottom: 7px; background: rgba(0, 0, 0, 0.6);
  color: #fff; padding: 1px 7px; border-radius: 20px;
}
.body { padding: 11px 13px 12px; display: flex; flex-direction: column; gap: 7px; flex: 1; }
.title { font-weight: 700; line-height: 1.4; }
.preview {
  display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2;
  -webkit-box-orient: vertical; overflow: hidden;
}
.pcard.selecting { cursor: pointer; user-select: none; }
.pcard.sel { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
.pickmark {
  position: absolute; left: 8px; top: 8px; z-index: 1; width: 24px; height: 24px;
  display: grid; place-items: center; border-radius: 50%; font-size: 14px; font-weight: 700;
  border: 2px solid #fff; background: rgba(0, 0, 0, 0.35); color: transparent;
}
.pickmark.on { background: var(--accent); color: #fff; }
.quickbar { position: sticky; bottom: 14px; margin-top: 16px; padding: 10px 13px; z-index: 5; }
.chk {
  display: inline-flex; align-items: center; gap: 4px; font-size: 13px;
  border: 1px solid var(--line); border-radius: 6px; padding: 4px 9px; cursor: pointer;
}
.chk.on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.dot::before { content: '● '; }
.dot.err { color: var(--err); }
.dot.warn { color: var(--warn); }
.dot.ok { color: var(--ok); }
</style>
