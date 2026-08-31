import { join } from 'node:path'

/**
 * 手動建立素材：直接把使用者提供的文字與連結當成原始內容，不去抓任何網址。
 * 圖片由前端建立完之後再上傳到 /api/inbox/{id}/images。
 */
export default defineEventHandler(async event => {
  const body = await readBody<{
    title?: string
    text?: string
    sourceGuess?: string
    url?: string
    links?: { url: string; label: string }[]
    platforms?: string[]
    extra?: string
  }>(event)

  const text = String(body?.text || '').trim()
  const title = String(body?.title || '').trim()
  if (!text && !title) throw createError({ statusCode: 400, message: '至少要給標題或內容' })

  await ensureDir(inboxDir())
  const id = await uniqueId(inboxDir(), materialSlugBase(title, text, body?.url || ''))
  await ensureDir(join(inboxDir(), id, 'images'))

  const m = emptyMaterial(id, String(body?.url || ''))
  m.title = title || sliceChars(text.split('\n').map(s => s.trim()).find(Boolean) || '', 40)
  m.text = text
  m.sourceGuess = String(body?.sourceGuess || '')
  m.via = 'manual'
  m.platforms = body?.platforms?.length ? body.platforms : ['facebook']
  m.extra = String(body?.extra || '')

  // 明確給的連結優先；沒給就從內容裡挑
  const given = (body?.links || []).filter(l => l.url?.trim())
  m.links = given.length
    ? given.map(l => ({ url: l.url.trim(), label: (l.label || '').trim() }))
    : extractUrls(text).map(u => ({ url: u, label: '' }))

  await saveMaterial(m)
  logOk('material', `手動建立素材：${m.title || id}｜內文 ${[...m.text].length} 字｜連結 ${m.links.length}`)
  return m
})
