<template>
  <div class="page spec">
    <div class="row wrap" style="margin-bottom: 10px">
      <h1 class="h1">撰寫規範</h1>
      <span class="spacer grow" />
      <span v-if="dirty" class="badge solid" style="background: var(--warn)">未儲存</span>
      <button :class="{ primary: !editing }" @click="editing = false">預覽</button>
      <button :class="{ primary: editing }" @click="editing = true">編輯</button>
      <button v-if="editing" class="primary" :disabled="saving || !dirty" @click="save">
        {{ saving ? '儲存中…' : '儲存' }}
      </button>
      <button v-if="editing && dirty" class="ghost" @click="revert">還原</button>
    </div>

    <p class="small muted" style="margin-top: 0">
      這份規範同時是 <strong>AI 撰寫的 system prompt</strong> 與 <strong>編輯器規範檢查的依據</strong>。
      改完存檔，下一次撰寫就會照新的規則寫。存檔前會自動備份成
      <code class="mono">文案撰寫規範.md.bak</code>。
    </p>
    <p v-if="msg" class="small" :class="msgErr ? 'm-err' : 'm-ok'">{{ msg }}</p>

    <textarea
      v-if="editing"
      v-model="draft"
      class="editor mono"
      spellcheck="false"
      @keydown.ctrl.s.prevent="save"
    />
    <article v-else class="card md" v-html="html" />

    <p class="tiny faint" style="margin-top: 10px">
      {{ editing ? 'Ctrl+S 也可以存檔。' : '' }}{{ spec?.path }}
    </p>
  </div>
</template>

<script setup lang="ts">
const { toast, toastErr } = useToast()
const { data: spec, refresh } = await useFetch<{ ok: boolean; content: string; path: string }>('/api/spec')

const editing = ref(false)
const saving = ref(false)
const msg = ref('')
const msgErr = ref(false)
const original = ref(spec.value?.content || '')
const draft = ref(spec.value?.content || '')
const dirty = computed(() => draft.value !== original.value)

async function save() {
  if (!dirty.value) return
  saving.value = true
  msg.value = ''
  try {
    const r = await $fetch<{ bytes: number }>('/api/spec', { method: 'PUT', body: { content: draft.value } })
    original.value = draft.value
    await refresh()
    msgErr.value = false
    msg.value = `已儲存（${r.bytes} bytes）。下一次撰寫就會用新的規範。`
    toast('規範已儲存')
  } catch (e) {
    msgErr.value = true
    msg.value = (e as { data?: { message?: string } }).data?.message || (e as Error).message
  } finally {
    saving.value = false
  }
}

function revert() {
  if (!confirm('放棄未儲存的修改？')) return
  draft.value = original.value
}

onBeforeRouteLeave(() => {
  if (dirty.value && !confirm('規範還沒儲存，要離開嗎？')) return false
  return true
})

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function inline(s: string) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
}

const html = computed(() => {
  const src = (spec.value?.content || '').replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let inCode = false
  let inTable = false
  let listType: '' | 'ul' | 'ol' = ''
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = '' } }
  const closeTable = () => { if (inTable) { out.push('</tbody></table>'); inTable = false } }

  for (const raw of src) {
    const line = raw.trimEnd()
    if (line.startsWith('```')) {
      closeList(); closeTable()
      out.push(inCode ? '</code></pre>' : '<pre><code>')
      inCode = !inCode
      continue
    }
    if (inCode) { out.push(esc(raw)); continue }

    if (/^\|/.test(line)) {
      const cells = line.split('|').slice(1, -1).map(c => c.trim())
      if (/^[\s|:-]+$/.test(line)) continue
      if (!inTable) {
        closeList()
        out.push('<table><thead><tr>' + cells.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>')
        inTable = true
      } else {
        out.push('<tr>' + cells.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>')
      }
      continue
    }
    closeTable()

    if (!line.trim()) { closeList(); continue }
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      closeList()
      const lv = (h[1] as string).length
      out.push(`<h${lv}>${inline(h[2] as string)}</h${lv}>`)
      continue
    }
    if (/^(---|\*\*\*)\s*$/.test(line)) { closeList(); out.push('<hr />'); continue }
    if (/^>\s?/.test(line)) {
      closeList()
      out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`)
      continue
    }
    const li = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/)
    if (li) {
      const type = /\d/.test(li[2] as string) ? 'ol' : 'ul'
      if (listType !== type) { closeList(); out.push(`<${type}>`); listType = type }
      const body = (li[3] as string).replace(/^\[( |x)\]\s*/, (_m, c) => (c === 'x' ? '☑ ' : '☐ '))
      out.push(`<li>${inline(body)}</li>`)
      continue
    }
    closeList()
    out.push(`<p>${inline(line)}</p>`)
  }
  closeList(); closeTable()
  if (inCode) out.push('</code></pre>')
  return out.join('\n')
})
</script>

<style scoped>
.spec { max-width: 940px; }
.m-ok { color: var(--ok); }
.m-err { color: var(--err); }
.editor {
  width: 100%; min-height: 70vh; line-height: 1.7; font-size: 13.5px;
  background: var(--panel); resize: vertical;
}
.md { padding: 24px 28px; line-height: 1.85; }
.md :deep(h1) { font-size: 22px; margin: 0 0 14px; }
.md :deep(h2) { font-size: 18px; margin: 30px 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
.md :deep(h3) { font-size: 15.5px; margin: 20px 0 6px; }
.md :deep(p) { margin: 8px 0; }
.md :deep(ul), .md :deep(ol) { margin: 6px 0; padding-left: 22px; }
.md :deep(li) { margin: 2px 0; }
.md :deep(hr) { border: none; border-top: 1px solid var(--line); margin: 22px 0; }
.md :deep(blockquote) {
  margin: 10px 0; padding: 8px 14px; border-left: 3px solid var(--accent);
  background: var(--panel-2); color: var(--muted); border-radius: 0 7px 7px 0;
}
.md :deep(code) {
  background: var(--panel-2); border: 1px solid var(--line); padding: 1px 5px;
  border-radius: 4px; font-size: 13px; font-family: "Cascadia Mono", Consolas, monospace;
}
.md :deep(pre) {
  background: var(--panel-2); border: 1px solid var(--line);
  border-radius: 8px; padding: 12px 14px; overflow-x: auto;
}
.md :deep(pre code) { background: none; border: none; padding: 0; }
.md :deep(table) {
  border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 13.5px;
  display: block; overflow-x: auto;
}
.md :deep(th), .md :deep(td) {
  border: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top;
}
.md :deep(th) { background: var(--panel-2); font-weight: 700; }
</style>
