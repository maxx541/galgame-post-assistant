<template>
  <div class="page logs">
    <div class="row wrap" style="margin-bottom: 12px">
      <h1 class="h1">後台記錄</h1>
      <span class="muted small">AI 呼叫、抓取、撰寫的即時狀況；點一列可以展開看完整內容</span>
      <span class="spacer grow" />
      <label class="chk" :class="{ on: live }">
        <input v-model="live" type="checkbox" />即時更新
      </label>
      <select v-model="fKind" class="sm-in" style="width: 120px">
        <option value="">全部</option>
        <option v-for="k in kinds" :key="k" :value="k">{{ kindLabel(k) }}</option>
      </select>
      <button class="ghost" @click="clear">清空</button>
    </div>

    <p class="small muted" style="margin-top: 0">
      同樣的內容也會印在啟動視窗那個黑框裡，並存成
      <code class="mono">data/logs/{{ today }}.jsonl</code>。金鑰一律遮蔽。
    </p>

    <div v-if="!shown.length" class="empty">
      還沒有記錄。去抓個素材或按一次「AI 撰寫」就會有東西。
    </div>

    <div class="list">
      <div v-for="e in shown" :key="e.id" class="entry" :class="e.level">
        <div class="row head" @click="toggle(e.id)">
          <span class="tiny time mono">{{ hhmm(e.at) }}</span>
          <span class="badge kind">{{ kindLabel(e.kind) }}</span>
          <span class="msg grow">{{ e.msg }}</span>
          <span v-if="e.ms !== undefined" class="tiny faint">{{ (e.ms / 1000).toFixed(1) }}s</span>
          <span v-if="e.detail" class="tiny faint">{{ open.includes(e.id) ? '收起' : '展開' }}</span>
        </div>
        <div v-if="e.detail && open.includes(e.id)" class="detail">
          <div v-for="(v, k) in e.detail" :key="k" class="block">
            <div class="row">
              <strong class="tiny">{{ k }}</strong>
              <span class="spacer grow" />
              <button class="ghost sm" @click="copyOne(v)">複製</button>
            </div>
            <pre class="tiny">{{ pretty(v) }}</pre>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
interface Entry {
  id: number
  at: string
  level: 'info' | 'ok' | 'warn' | 'error'
  kind: string
  msg: string
  ms?: number
  detail?: Record<string, unknown>
}

const { toast } = useToast()
const entries = ref<Entry[]>([])
const open = ref<number[]>([])
const live = ref(true)
const fKind = ref('')
let lastId = 0
let timer: ReturnType<typeof setInterval> | null = null

const KIND_LABEL: Record<string, string> = {
  ai: 'AI 呼叫',
  material: '素材抓取',
  post: '貼文撰寫',
  feedback: '反饋優化',
  spec: '規範',
  system: '系統'
}
const kindLabel = (k: string) => KIND_LABEL[k] || k
const kinds = computed(() => [...new Set(entries.value.map(e => e.kind))])
const shown = computed(() =>
  [...entries.value].filter(e => !fKind.value || e.kind === fKind.value).reverse()
)
const today = new Date().toISOString().slice(0, 10)

function hhmm(iso: string) {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
function pretty(v: unknown) {
  if (typeof v === 'string') return v
  return JSON.stringify(v, null, 2)
}
function toggle(id: number) {
  open.value = open.value.includes(id) ? open.value.filter(x => x !== id) : [...open.value, id]
}
async function copyOne(v: unknown) {
  try {
    await navigator.clipboard.writeText(pretty(v))
    toast('已複製')
  } catch {
    /* 複製失敗就算了 */
  }
}

async function pull() {
  try {
    const r = await $fetch<{ entries: Entry[]; lastId: number }>('/api/logs', { query: { since: lastId } })
    if (r.entries.length) {
      entries.value = [...entries.value, ...r.entries].slice(-400)
      lastId = r.lastId
    } else if (r.lastId < lastId) {
      // 伺服器重啟或被清空了
      entries.value = []
      lastId = 0
    }
  } catch {
    /* 伺服器可能正在重載，下一輪再試 */
  }
}

async function clear() {
  await $fetch('/api/logs', { method: 'DELETE' })
  entries.value = []
  open.value = []
  lastId = 0
}

watch(live, v => {
  if (v && !timer) timer = setInterval(pull, 2000)
  if (!v && timer) { clearInterval(timer); timer = null }
})

onMounted(async () => {
  await pull()
  if (live.value) timer = setInterval(pull, 2000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<style scoped>
.logs { max-width: 1100px; }
.chk {
  display: inline-flex; align-items: center; gap: 4px; font-size: 13px;
  border: 1px solid var(--line); border-radius: 6px; padding: 5px 10px; cursor: pointer;
}
.chk.on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.sm-in { font-size: 13px; padding: 5px 8px; }
.list { display: flex; flex-direction: column; gap: 3px; }
.entry {
  border: 1px solid var(--line); border-left-width: 3px; border-radius: 7px;
  background: var(--panel); overflow: hidden;
}
.entry.ok { border-left-color: var(--ok); }
.entry.info { border-left-color: var(--info); }
.entry.warn { border-left-color: var(--warn); }
.entry.error { border-left-color: var(--err); }
.head { gap: 9px; padding: 7px 11px; cursor: pointer; }
.head:hover { background: var(--panel-2); }
.time { color: var(--faint); flex: none; }
.kind { flex: none; }
.msg { font-size: 13.5px; word-break: break-word; }
.entry.warn .msg { color: var(--warn); }
.entry.error .msg { color: var(--err); }
.detail { border-top: 1px solid var(--line); background: var(--panel-2); padding: 9px 11px; }
.block + .block { margin-top: 9px; }
.block pre {
  margin: 4px 0 0; white-space: pre-wrap; word-break: break-word; font-family: "Cascadia Mono", Consolas, monospace;
  background: var(--bg); border: 1px solid var(--line); border-radius: 6px;
  padding: 8px 10px; max-height: 340px; overflow-y: auto; line-height: 1.55;
}
</style>
