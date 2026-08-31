<template>
  <div class="pv">
    <div class="head row">
      <div class="avatar" />
      <div class="grow">
        <div class="name">GalGame文化同好會</div>
        <div class="tiny faint">{{ p.name }} 預覽</div>
      </div>
    </div>

    <div class="text">
      <span>{{ head }}</span><template v-if="tail"><span class="cut-line" :title="p.cutoffLabel" /><span class="tail">{{ tail }}</span></template>
    </div>
    <div v-if="tail" class="tiny more">— {{ p.cutoffLabel }}（{{ p.cutoff }} 字元）之後會被摺疊 —</div>

    <div v-if="images.length" class="imgs" :class="'n' + Math.min(images.length, 4)">
      <img v-for="(src, i) in images.slice(0, 4)" :key="i" :src="src" alt="" />
    </div>

    <div v-if="comment" class="comment">
      <div class="tiny faint" style="margin-bottom: 3px">第一則留言</div>
      <div class="tiny mono">{{ comment }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{ text: string; platform: string; images: string[]; comment?: string }>()

const p = computed(() => getPlatform(props.platform))
const head = computed(() => {
  if (!p.value.cutoff) return props.text
  return [...props.text].slice(0, p.value.cutoff).join('')
})
const tail = computed(() => {
  if (!p.value.cutoff) return ''
  return [...props.text].slice(p.value.cutoff).join('')
})
</script>

<style scoped>
.pv {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 13px;
  max-width: 420px;
}
.head { gap: 9px; margin-bottom: 9px; }
.avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), var(--info));
  flex: none;
}
.name { font-weight: 700; font-size: 14px; }
.text {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 14.5px;
  line-height: 1.65;
}
.tail { color: var(--faint); }
.cut-line {
  display: inline-block;
  width: 100%;
  height: 0;
  border-top: 1px dashed var(--warn);
  margin: 3px 0;
  vertical-align: middle;
}
.more { color: var(--warn); margin-top: 4px; }
.imgs {
  margin-top: 10px;
  display: grid;
  gap: 3px;
  border-radius: 9px;
  overflow: hidden;
}
.imgs.n1 { grid-template-columns: 1fr; }
.imgs.n2 { grid-template-columns: 1fr 1fr; }
.imgs.n3, .imgs.n4 { grid-template-columns: 1fr 1fr; }
.imgs img { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; display: block; }
.imgs.n1 img { aspect-ratio: 16 / 9; }
.comment {
  margin-top: 11px;
  padding-top: 9px;
  border-top: 1px solid var(--line);
  word-break: break-all;
}
</style>
