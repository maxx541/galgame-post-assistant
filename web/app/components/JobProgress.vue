<template>
  <div v-if="job" class="jobbox" :class="job.status">
    <div class="row wrap" style="gap: 8px">
      <strong class="small">{{ job.label }}</strong>
      <span class="tiny cnt">{{ job.done }}<template v-if="job.total"> / {{ job.total }}</template></span>
      <span v-if="pct >= 0 && job.status === 'running'" class="tiny cnt">{{ pct }}%</span>
      <span class="spacer grow" />
      <span v-if="eta" class="tiny faint">約還要 {{ etaText }}</span>
      <span v-if="job.status === 'done'" class="badge solid" style="background: var(--ok)">完成</span>
      <span v-else-if="job.status === 'error'" class="badge solid" style="background: var(--err)">失敗</span>
      <span v-else-if="job.status === 'stopped'" class="badge">已停止</span>
      <button
        v-if="job.status === 'running' && job.canStop"
        class="ghost sm"
        :disabled="stopping || job.stopRequested"
        @click="stop"
      >
        {{ stopping || job.stopRequested ? '停止中…' : '停止' }}
      </button>
      <button v-else-if="job.status !== 'running'" class="ghost sm" @click="dismiss">關閉</button>
    </div>

    <div class="track" :class="{ indet: pct < 0 && job.status === 'running' }">
      <div class="fill" :style="pct >= 0 ? { width: pct + '%' } : undefined" />
    </div>

    <div class="row" style="gap: 6px">
      <span class="msg tiny" :class="{ bad: job.status === 'error' }">{{ job.message }}</span>
      <span class="spacer grow" />
      <button v-if="job.log.length > 1" class="ghost sm tiny" @click="open = !open">
        {{ open ? '收合' : `明細（${job.log.length}）` }}
      </button>
    </div>

    <ol v-if="open" class="joblog tiny">
      <li v-for="(l, i) in [...job.log].reverse()" :key="i" :class="{ bad: !l.ok }">
        <span class="faint">{{ l.at.slice(11, 19) }}</span> {{ l.text }}
      </li>
    </ol>
  </div>
</template>

<script setup lang="ts">
/**
 * 背景工作的進度條。
 *
 * 重點在「接得回來」：長工作跑在伺服器上，這個元件掛載時會先問有沒有
 * 同類型的工作正在跑，有就直接接上去。所以從發掘切到紀錄再切回來，
 * 進度還在，不會像以前那樣一換頁就整個不見。
 */
interface JobLine { at: string; ok: boolean; text: string }
interface Job {
  id: string; kind: string; label: string; status: string
  total: number; done: number; message: string; log: JobLine[]
  error: string; startedAt: string; finishedAt: string
  canStop: boolean; stopRequested: boolean; result: unknown
}

const props = defineProps<{ kind: string; pollMs?: number }>()
const emit = defineEmits<{ done: [Job]; change: [Job | null]; progress: [Job] }>()

const job = ref<Job | null>(null)
const open = ref(false)
const stopping = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null
let lastStatus = ''
/** 上次通知外面時的步數。每前進一步就發一次 progress，讓清單即時跟著長 */
let lastDone = -1

const pct = computed(() => {
  const j = job.value
  if (!j) return -1
  if (j.status !== 'running') return 100
  if (!j.total) return -1
  return Math.max(0, Math.min(100, Math.round((j.done / j.total) * 100)))
})

const eta = computed(() => {
  const j = job.value
  if (!j || j.status !== 'running' || !j.total || j.done < 2) return 0
  const elapsed = Date.now() - Date.parse(j.startedAt)
  if (!(elapsed > 0)) return 0
  return Math.max(0, Math.round((j.total - j.done) * (elapsed / j.done)))
})

const etaText = computed(() => {
  const s = Math.round(eta.value / 1000)
  return s < 60 ? `${s} 秒` : `${Math.round(s / 60)} 分鐘`
})

async function poll() {
  const j = job.value
  if (!j) return
  try {
    job.value = await $fetch<Job>(`/api/jobs/${j.id}`)
  } catch {
    // 伺服器重開過就接不回來了，停止輪詢而不是一直洗錯誤
    stopPolling()
    return
  }
  const cur = job.value!
  if (cur.done !== lastDone) {
    lastDone = cur.done
    emit('progress', cur)
  }
  if (cur.status !== 'running' && lastStatus === 'running') {
    lastStatus = cur.status
    stopPolling()
    emit('done', cur)
    return
  }
  lastStatus = cur.status
  if (cur.status === 'running') schedule()
}

function schedule() {
  stopPolling()
  timer = setTimeout(poll, props.pollMs || 1000)
}

function stopPolling() {
  if (timer) clearTimeout(timer)
  timer = null
}

/** 剛開好一個工作時由呼叫端接上 */
async function attach(id: string) {
  stopPolling()
  try {
    job.value = await $fetch<Job>(`/api/jobs/${id}`)
    lastStatus = job.value.status
    lastDone = job.value.done
    open.value = false
    emit('change', job.value)
    if (job.value.status === 'running') schedule()
  } catch {
    job.value = null
  }
}

/** 掛載時找有沒有同類型還在跑的，有就接上去 —— 換頁回來靠這個 */
async function resume() {
  try {
    const r = await $fetch<{ items: Job[] }>('/api/jobs', { params: { kind: props.kind } })
    const running = r.items.find(x => x.status === 'running')
    if (running) await attach(running.id)
  } catch {
    /* 沒有就算了 */
  }
}

async function stop() {
  if (!job.value) return
  stopping.value = true
  try {
    await $fetch(`/api/jobs/${job.value.id}/stop`, { method: 'POST' })
    // 馬上把狀態抓回來，按鈕才會立刻變成「停止中…」而不是彈回「停止」
    await poll()
  } catch {
    /* 已經跑完了 */
  } finally {
    stopping.value = false
  }
}

function dismiss() {
  stopPolling()
  job.value = null
  emit('change', null)
}

onMounted(resume)
onBeforeUnmount(stopPolling)
defineExpose({ attach, resume, job })
</script>

<style scoped>
.jobbox {
  display: flex; flex-direction: column; gap: 7px;
  border: 1px solid var(--line); border-left: 3px solid var(--accent);
  border-radius: 8px; padding: 10px 12px; background: var(--panel-2);
}
.jobbox.done { border-left-color: var(--ok); }
.jobbox.error { border-left-color: var(--err); }
.jobbox.stopped { border-left-color: var(--line-strong); }
.cnt { font-variant-numeric: tabular-nums; color: var(--muted); }

.track { height: 6px; border-radius: 4px; background: var(--line); overflow: hidden; }
.fill {
  height: 100%; background: var(--accent); border-radius: 4px;
  transition: width 0.3s ease;
}
.done .fill { background: var(--ok); }
.error .fill { background: var(--err); }
.stopped .fill { background: var(--line-strong); }
/* 總數還不知道時，用來回跑的動畫代替百分比 */
.track.indet .fill { width: 35%; animation: slide 1.2s ease-in-out infinite; }
@keyframes slide {
  0% { margin-left: -35%; }
  100% { margin-left: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .track.indet .fill { animation: none; width: 100%; opacity: 0.4; }
  .fill { transition: none; }
}

.msg { color: var(--muted); word-break: break-word; }
.msg.bad { color: var(--err); }
.joblog {
  margin: 0; padding: 0 0 0 4px; list-style: none;
  max-height: 190px; overflow-y: auto; line-height: 1.75;
  border-top: 1px dashed var(--line); padding-top: 6px;
}
.joblog li { color: var(--muted); word-break: break-word; }
.joblog li.bad { color: var(--err); }
</style>
