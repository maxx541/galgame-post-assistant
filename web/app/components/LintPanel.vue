<template>
  <div class="lint">
    <div class="row" style="margin-bottom: 8px">
      <strong class="h2">規範檢查</strong>
      <span class="spacer grow" />
      <span v-if="s.pass && !s.warn" class="badge solid" style="background: var(--ok)">全部通過</span>
      <template v-else>
        <span v-if="s.error" class="badge solid" style="background: var(--err)">{{ s.error }} 違規</span>
        <span v-if="s.warn" class="badge solid" style="background: var(--warn)">{{ s.warn }} 提醒</span>
        <span v-if="s.info" class="badge">{{ s.info }} 建議</span>
      </template>
    </div>

    <p v-if="!issues.length" class="small ok-msg">
      符合第〇節四條硬規定與平台建議。可以標為「已定稿」。
    </p>

    <ul class="list">
      <li v-for="i in sorted" :key="i.id" :class="i.level">
        <div class="row" style="align-items: flex-start; gap: 7px">
          <span class="mark">{{ i.level === 'error' ? '✕' : i.level === 'warn' ? '!' : 'i' }}</span>
          <div class="grow">
            <div class="msg">{{ i.message }}</div>
            <div v-if="i.hint" class="tiny muted">{{ i.hint }}</div>
          </div>
          <span class="tiny faint rule">{{ i.rule }}</span>
        </div>
      </li>
    </ul>

    <div class="counter small">
      <div class="row wrap" style="gap: 12px">
        <span>正文 <b>{{ bodyLen }}</b> {{ unit }}<span v-if="range" class="faint">（建議 {{ range }}）</span></span>
        <span>全文 <b>{{ allLen }}</b></span>
        <span>tag <b>{{ split.tags.length }}</b> 個<span class="faint">（{{ p.tags[0] }}–{{ p.tags[1] }}）</span></span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{ text: string; platform: string; hasLinks?: boolean; artists?: string[] }>()

const p = computed(() => getPlatform(props.platform))
const issues = computed(() =>
  lintPost(props.text, { platform: props.platform, hasLinks: props.hasLinks, artists: props.artists })
)
const s = computed(() => lintSummary(issues.value))
const order = { error: 0, warn: 1, info: 2 } as const
const sorted = computed(() => [...issues.value].sort((a, b) => order[a.level] - order[b.level]))
const split = computed(() => splitPost(props.text))
const bodyLen = computed(() => countChars(split.value.body, p.value.count))
const allLen = computed(() => countChars(props.text, p.value.count))
const unit = computed(() => (p.value.count === 'weighted' ? '加權字元' : '字元'))
const range = computed(() => {
  const [a, b] = p.value.body
  return a !== null && b !== null ? `${a}–${b}` : ''
})
</script>

<style scoped>
.lint { display: flex; flex-direction: column; gap: 8px; }
.ok-msg {
  background: var(--ok-soft);
  color: var(--ok);
  padding: 9px 11px;
  border-radius: 8px;
  margin: 0;
}
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.list li { padding: 8px 10px; border-radius: 8px; font-size: 13.5px; }
.list li.error { background: var(--err-soft); }
.list li.warn { background: var(--warn-soft); }
.list li.info { background: var(--info-soft); }
.mark {
  width: 17px;
  height: 17px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 11px;
  font-weight: 700;
  color: #fff;
  flex: none;
  margin-top: 2px;
}
.error .mark { background: var(--err); }
.warn .mark { background: var(--warn); }
.info .mark { background: var(--info); }
.msg { line-height: 1.5; }
.rule { flex: none; white-space: nowrap; margin-top: 2px; }
.counter {
  border-top: 1px dashed var(--line);
  padding-top: 8px;
  color: var(--muted);
}
</style>
