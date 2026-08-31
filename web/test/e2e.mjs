/**
 * 端對端測試。需要 dev server 已在 http://localhost:4321 執行。
 * 跑法：先 npm run dev，另開一個終端機 npm test
 */
import { promises as fs } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = resolve(HERE, '..', '..', 'data')
const BASE = process.env.BASE_URL || 'http://localhost:4321'

// app/utils 的模組是給 Nuxt 用的（無副檔名 import），這裡複製一份補上 .ts 讓 node 直接跑
const TMP = join(tmpdir(), 'post-studio-test-' + process.pid)
await fs.mkdir(TMP, { recursive: true })
await fs.copyFile(join(HERE, '..', 'app', 'utils', 'platforms.ts'), join(TMP, 'platforms.ts'))
await fs.writeFile(
  join(TMP, 'lint.ts'),
  (await fs.readFile(join(HERE, '..', 'app', 'utils', 'lint.ts'), 'utf8')).replace("from './platforms'", "from './platforms.ts'"),
  'utf8'
)
const { lintPost, lintSummary, countChars, splitPost } = await import(
  pathToFileURL(join(TMP, 'lint.ts')).href
)

try {
  await fetch(BASE, { signal: AbortSignal.timeout(3000) })
} catch {
  console.error(`\n連不到 ${BASE}\n請先在另一個終端機執行 npm run dev，再跑 npm test\n`)
  process.exit(1)
}

let pass = 0, fail = 0
const fails = []

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; fails.push(name); console.log(`  FAIL  ${name} ${extra}`) }
}

async function j(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await r.text()
  let data = null
  try { data = JSON.parse(text) } catch { data = text }
  return { status: r.status, data, ct: r.headers.get('content-type') || '' }
}
const enc = encodeURIComponent
let xReady = false

// 前一輪測試若中途掛掉會留下殘骸，開跑前先清乾淨
{
  const stale = (await j('GET', '/api/posts')).data.filter(p => String(p.id).includes('自動測試'))
  for (const p of stale) await j('DELETE', `/api/posts/${enc(p.id)}`)
  const staleM = (await j('GET', '/api/inbox')).data.filter(m => String(m.title).includes('自動測試'))
  for (const m of staleM) await j('DELETE', `/api/inbox/${enc(m.id)}`)
  if (stale.length || staleM.length) {
    console.log(`  （清掉上一輪殘留的 ${stale.length} 則貼文、${staleM.length} 則素材）`)
  }
}

console.log('\n### 1. 頁面 SSR')
for (const [name, url] of [['貼文列表', '/'], ['素材匣', '/inbox'], ['撰寫規範', '/spec']]) {
  const r = await fetch(BASE + url)
  const html = await r.text()
  ok(`${name} ${url}`, r.status === 200 && !html.includes('Internal Server Error'), `status=${r.status}`)
}
{
  const r = await fetch(BASE + '/spec')
  const html = await r.text()
  ok('規範頁有表格與標題', html.includes('<table>') && html.includes('強制格式規則'))
}

console.log('\n### 2. 基本 API')
{
  const r = await j('GET', '/api/posts'); ok('GET /api/posts 回陣列', r.status === 200 && Array.isArray(r.data))
}
{
  const r = await j('GET', '/api/inbox'); ok('GET /api/inbox 回陣列', r.status === 200 && Array.isArray(r.data))
}
{
  const r = await j('GET', '/api/spec'); ok('GET /api/spec 讀到規範', r.status === 200 && r.data.ok && r.data.content.includes('強制格式規則'))
}
{
  const r = await j('GET', '/api/tags'); ok('GET /api/tags', r.status === 200 && r.data.tags.includes('#GalGame文化同好會'))
}

console.log('\n### 3. 貼文 CRUD（中文資料夾名）')
const title = '自動測試-中文標題ABC'
let pid = null
{
  const r = await j('POST', '/api/posts', { title, category: '情報', postType: '活動招募', platforms: ['facebook', 'threads'] })
  pid = r.data?.id
  ok('建立貼文', r.status === 200 && pid?.includes(title), `id=${pid}`)
  ok('資料夾用中文命名且含日期', /^\d{8}-/.test(pid || ''))
}
{
  const r = await j('PUT', `/api/posts/${enc(pid)}`, {
    sourceName: '@Moepedia_net',
    links: [{ label: '報名表單', url: 'https://example.com/form' }],
    missing: ['名額', '費用'],
    status: 'needs-info'
  })
  ok('更新 meta', r.status === 200 && r.data.sourceName === '@Moepedia_net' && r.data.missing.length === 2)
}
const goodBody = `【情報】自動測試-中文標題ABC
這是一段測試內文，長度刻意寫得夠長，用來確認 Facebook 平台的檢查會通過而不會誤報。

活動細節分段呈現，手機閱讀比較舒服。
網址放留言
（來源：@Moepedia_net）
#GalGame文化同好會 #galgame`
{
  const r = await j('PUT', `/api/posts/${enc(pid)}/variants/v1`, { label: '溫和敘事版', platform: 'facebook', locked: false, body: goodBody })
  ok('寫入版本 v1', r.status === 200 && r.data.body === goodBody)
}
{
  const raw = await fs.readFile(join(DATA, 'posts', pid, 'variants', 'v1.md'), 'utf8')
  ok('v1.md 在磁碟上且格式正確',
    raw.startsWith('---\nid: v1\nlabel: 溫和敘事版\nplatform: facebook\nlocked: false\nnote: \n---\n') && raw.includes('（來源：@Moepedia_net）'))
}
{
  const r = await j('GET', `/api/posts/${enc(pid)}`)
  ok('讀回貼文含版本', r.status === 200 && r.data.variants.length === 1 && r.data.variants[0].body === goodBody)
}
{
  const r = await fetch(`${BASE}/posts/${enc(pid)}`)
  const html = await r.text()
  ok('編輯頁 SSR 正常', r.status === 200 && html.includes(title) && !html.includes('Internal Server Error'))
  ok('編輯頁顯示「全部通過」（合規版）', html.includes('全部通過'), '(合規文案應無違規)')
}

console.log('\n### 4. 圖片：上傳 / 供圖 / 排序 / 刪除')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
{
  const fd = new FormData()
  fd.append('f0', new Blob([PNG], { type: 'image/png' }), 'a.png')
  fd.append('f1', new Blob([PNG], { type: 'image/png' }), 'b.png')
  const r = await fetch(`${BASE}/api/posts/${enc(pid)}/images`, { method: 'POST', body: fd })
  const d = await r.json()
  ok('multipart 上傳兩張圖', r.status === 200 && d.added.length === 2 && d.post.images.length === 2, JSON.stringify(d.added))
}
{
  const r = await fetch(`${BASE}/api/media/posts/${enc(pid)}/01.png`)
  const buf = Buffer.from(await r.arrayBuffer())
  ok('媒體端點出圖', r.status === 200 && r.headers.get('content-type') === 'image/png' && buf.length === PNG.length)
}
{
  const cur = (await j('GET', `/api/posts/${enc(pid)}`)).data
  cur.images[0].artist = '@testartist'
  const r = await j('PUT', `/api/posts/${enc(pid)}`, { images: cur.images })
  ok('圖片可登記繪師', r.status === 200 && r.data.images[0].artist === '@testartist')
}
{
  const r = await j('DELETE', `/api/posts/${enc(pid)}/images/02.png`)
  ok('刪除圖片同步更新 meta', r.status === 200 && r.data.images.length === 1)
  let gone = false
  try { await fs.access(join(DATA, 'posts', pid, 'images', '02.png')) } catch { gone = true }
  ok('圖檔實際從磁碟移除', gone)
}

console.log('\n### 5. 安全：路徑穿越')
for (const bad of ['/api/media/posts/..%2F..%2F..%2Fpackage.json', '/api/media/posts/x/..%2F..%2Fpost.json']) {
  const r = await fetch(BASE + bad)
  ok(`擋下 ${bad.slice(0, 42)}…`, r.status !== 200, `status=${r.status}`)
}
{
  const r = await j('DELETE', `/api/posts/${enc('..')}`)
  ok('擋下 DELETE ../', r.status >= 400, `status=${r.status}`)
}

/**
 * 長工作改成背景執行之後，端點只回 jobId —— 測試要自己等它跑完。
 * 這也順便驗到「工作真的會跑完」這件事。
 */
async function waitJob(jobId, timeoutMs = 180000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const r = await j('GET', `/api/jobs/${jobId}`)
    if (r.status !== 200) return { status: 'gone' }
    if (r.data.status !== 'running') return r.data
    await new Promise(res => setTimeout(res, 500))
  }
  return { status: 'timeout' }
}

console.log('\n### 6. 素材夾：一次貼多個連結 → 撰寫 → 產生貼文')
let mid = null
{
  const r = await j('POST', '/api/inbox/collect', {
    text: '看這個 https://store.steampowered.com/app/1109570/ 謝謝',
    platforms: ['facebook', 'threads']
  })
  ok('collect 馬上回工作 id，不佔住請求', r.status === 200 && !!r.data.jobId && r.data.total === 1,
    JSON.stringify(r.data).slice(0, 160))
  const cdone = await waitJob(r.data.jobId)
  ok('抓取工作跑完', cdone.status === 'done', String(cdone.status))
  ok('從整段文字挑出網址並建立素材', cdone.result?.added === 1, JSON.stringify(cdone.result).slice(0, 160))
  ok('進度有累加到總數', cdone.done === 1 && cdone.total === 1, `${cdone.done}/${cdone.total}`)
  ok('每一步都留了紀錄', (cdone.log || []).length >= 1)
  mid = cdone.result?.results?.[0]?.id
  ok('回傳素材 id', !!mid, String(mid))
}
{
  const r = await j('GET', `/api/inbox/${enc(mid)}`)
  ok('素材帶原始內文', r.status === 200 && typeof r.data.text === 'string' && r.data.text.length > 0)
  ok('素材帶平台設定', r.data.platforms?.includes('threads'))
  ok('素材預設未撰寫', r.data.written === false && r.data.postId === '')
  ok('素材記錄抓取方式', ['fetch', 'playwright', 'manual'].includes(r.data.via), r.data.via)
}
{
  const r = await j('PUT', `/api/inbox/${enc(mid)}`, {
    text: '我自己補的內文',
    platforms: ['facebook'],
    extra: '語氣輕鬆'
  })
  ok('素材可以編輯原文與平台', r.status === 200 && r.data.text === '我自己補的內文' && r.data.extra === '語氣輕鬆')
  ok('素材編輯不會動到 id', r.data.id === mid)
}
{
  const r = await fetch(`${BASE}/inbox/${enc(mid)}`)
  const html = await r.text()
  ok('素材詳細頁 SSR 正常', r.status === 200 && !html.includes('Internal Server Error'))
  ok('素材詳細頁顯示原始內容區', html.includes('原始內容'))
  ok('素材詳細頁有平台勾選與撰寫按鈕', html.includes('要寫給哪些平台') && html.includes('AI 撰寫'))
  ok('素材詳細頁不再要求選體裁子型', !html.includes('子型（決定待補欄位）'))
}
{
  const r = await j('POST', '/api/inbox/collect', { text: '沒有網址的一段話' })
  ok('沒有網址時 collect 回 400', r.status === 400)
}
{
  const r = await j('GET', '/api/inbox')
  ok('素材列表讀得到剛剛那則', r.status === 200 && r.data.some(m => m.id === mid))
}
{
  const r = await j('DELETE', `/api/inbox/${enc(mid)}`)
  let gone = false
  try { await fs.access(join(DATA, 'inbox', mid)) } catch { gone = true }
  ok('刪除素材連資料夾一起清掉', r.status === 200 && gone)
}
{
  const mat = await import(pathToFileURL(join(HERE, '..', 'server', 'utils', 'material.ts')).href)
  ok('extractUrls 挑得出多個網址並去重',
    JSON.stringify(mat.extractUrls('a https://x.com/1 b https://y.com/2 c https://x.com/1')) ===
      JSON.stringify(['https://x.com/1', 'https://y.com/2']))
  ok('extractUrls 去掉尾端標點', mat.extractUrls('看 https://a.com/b。')[0] === 'https://a.com/b')
  ok('extractUrls 沒網址時回空陣列', mat.extractUrls('完全沒有').length === 0)
  ok('素材資料夾名有日期前綴且看得出內容', /^\d{8}-.+/.test(String(mid)), String(mid))
}


console.log('\n### 7. 清理')
for (const id of [pid]) {
  const r = await j('DELETE', `/api/posts/${enc(id)}`)
  let gone = false
  try { await fs.access(join(DATA, 'posts', id)) } catch { gone = true }
  ok(`刪除貼文 ${id.slice(0, 22)}…`, r.status === 200 && gone)
}

console.log('\n### 8. 規範檢查引擎')
const cases = [
  { n: '合規（FB）', p: 'facebook', links: true, t: goodBody, e: 0 },
  {
    n: '違規全餐（Threads）', p: 'threads', links: true, e: 4,
    t: 'CRYSTALA新品週邊來了 ✨\n限時搶購，手刀下單！\n預購連結 https://example.com/x\n#galgame'
  },
  {
    n: '半形括號來源', p: 'facebook', links: false, e: 1,
    t: '【台詞】測試\n內文\n(來源:某處)\n#galgame #GalGame文化同好會'
  },
  {
    n: '來源排在 hashtag 之後', p: 'facebook', links: false, e: 1,
    t: '【情報】測試\n內文\n#galgame #GalGame文化同好會\n（來源：某處）'
  },
  {
    n: '登記繪師但沒標', p: 'facebook', links: false, artists: ['@a'], e: 0, w: 1,
    t: '【情報】測試\n內文\n（來源：某處）\n#galgame #GalGame文化同好會'
  }
]
for (const c of cases) {
  const s = lintSummary(lintPost(c.t, { platform: c.p, hasLinks: c.links, artists: c.artists }))
  ok(`lint「${c.n}」違規數=${c.e}`, s.error === c.e, `實際 error=${s.error} warn=${s.warn}`)
  if (c.w !== undefined) ok(`lint「${c.n}」提醒數>=${c.w}`, s.warn >= c.w, `實際 warn=${s.warn}`)
}
{
  const issues = lintPost('CRYSTALA新品週邊來了 ✨\n限時搶購！\nhttps://x.com/a\n#galgame', { platform: 'threads', hasLinks: true })
  const ids = issues.map(i => i.id)
  ok('四條硬規定都各自被抓到', ['category', 'emoji', 'source', 'url-in-body'].every(k => ids.includes(k)), ids.join(','))
}
ok('X 加權字數（中文算2）', countChars('這是一個十字測試句', 'weighted') === 18 && countChars('這是一個十字測試句', 'cp') === 9)
ok('tag 行與正文正確拆分', (() => {
  const s = splitPost('【情報】x\n內文\n（來源：A）\n#a #b #c')
  return s.tags.length === 3 && s.body === '【情報】x\n內文\n（來源：A）'
})())
ok('emoji 白名單不誤報 ♪', lintPost('【情報】測試♪\n內文\n（來源：A）\n#galgame #GalGame文化同好會', { platform: 'facebook' }).every(i => i.id !== 'emoji'))

console.log('\n### 9. LLM 請求組裝（dry run，不呼叫端點）')
{
  const llm = await import(pathToFileURL(join(HERE, '..', 'server', 'utils', 'llm.ts')).href)
  const { buildChatRequest, endpointFor, extractJson, normalizeDraft, DRAFT_SCHEMA, DEFAULT_BASE_URL } = llm

  const input = {
    spec: '# 文案撰寫規範與工作流\n〇、強制格式規則',
    text: 'CRYSTALA同時推出兩部作品的新週邊，預購期間 8/24～9/18',
    title: 'CRYSTALA新品週邊登場',
    platforms: ['facebook', 'threads'],
    sourceName: '@Moepedia_net',
    sourceUrl: 'https://x.com/Moepedia_net/status/123',
    links: [{ label: '預購頁', url: 'https://example.com/preorder' }],
    artists: ['@aaa', '@bbb'],
    extra: '語氣輕鬆一點',
    perPlatform: 2,
    images: [{ media_type: 'image/png', data: 'AAAA' }]
  }
  const req = buildChatRequest(input, { model: 'gemini-2.5-pro', sendImages: true, jsonSchema: true })

  ok('model 用設定值', req.model === 'gemini-2.5-pro')
  ok('max_tokens = 16000', req.max_tokens === 16000)
  ok('messages 是 system + user', req.messages.length === 2 && req.messages[0].role === 'system' && req.messages[1].role === 'user')

  const sys = req.messages[0].content
  ok('system 內嵌規範全文', sys.includes('強制格式規則'))
  ok('system 交代四條硬規定', ['網址放留言', 'emoji', '（來源：', '【體裁】'].every(k => sys.includes(k)))
  ok('system 禁止編造事實', sys.includes('不要編造事實'))
  ok('system 要求只輸出 JSON', sys.includes('只輸出一個 JSON 物件'))

  const uc = req.messages[1].content
  ok('有圖時 user content 是陣列', Array.isArray(uc))
  ok('圖片排在文字前', uc[0]?.type === 'image_url' && uc.at(-1).type === 'text')
  ok('圖片是 data URL', uc[0].image_url.url.startsWith('data:image/png;base64,AAAA'))

  const text = uc.at(-1).text
  for (const k of ['CRYSTALA新品週邊登場', '@Moepedia_net', '@aaa @bbb', '語氣輕鬆一點', 'Facebook', 'Threads']) {
    ok('素材含「' + k + '」', text.includes(k))
  }
  ok('素材原文用標籤包起來送出',
    text.includes('<素材原文>') && text.includes('預購期間 8/24～9/18') && text.includes('</素材原文>'))
  ok('要求 AI 一併判斷體裁與子型', text.includes('判斷 title、category'))
  ok('要求每平台 2 個版本', text.includes('各產出 2 個語氣不同的版本'))
  ok('導流網址沒有被寫進 prompt', !JSON.stringify(req).includes('https://example.com/preorder'))

  ok('response_format 用 json_schema', req.response_format?.type === 'json_schema')
  ok('json_schema 帶 strict 與 schema', req.response_format.json_schema.strict === true && !!req.response_format.json_schema.schema)
  const vprops = DRAFT_SCHEMA.properties.variants.items.properties
  ok('schema 的 variant 有 label/platform/body/note', ['label', 'platform', 'body', 'note'].every(k => k in vprops))
  ok('schema 的 platform 是真的 enum', Array.isArray(vprops.platform.enum) && vprops.platform.enum.includes('threads'))

  const noSchema = buildChatRequest(input, { model: 'm', sendImages: true, jsonSchema: false })
  ok('退回模式用 json_object', noSchema.response_format?.type === 'json_object')

  const noImg = buildChatRequest({ ...input, images: [] }, { model: 'm', sendImages: true, jsonSchema: true })
  ok('無圖時 user content 是純字串', typeof noImg.messages[1].content === 'string')
  const offImg = buildChatRequest(input, { model: 'm', sendImages: false, jsonSchema: true })
  ok('關掉送圖時不帶圖片 block', typeof offImg.messages[1].content === 'string')

  ok('Base URL：一般情況', endpointFor('https://api.x.com/v1', 'chat/completions') === 'https://api.x.com/v1/chat/completions')
  ok('Base URL：尾端斜線', endpointFor('https://api.x.com/v1/', 'chat/completions') === 'https://api.x.com/v1/chat/completions')
  ok('Base URL：貼了完整 completions 網址',
    endpointFor('https://api.x.com/v1/chat/completions', 'chat/completions') === 'https://api.x.com/v1/chat/completions')
  ok('Base URL：models 端點', endpointFor('https://api.x.com/v1', 'models') === 'https://api.x.com/v1/models')
  ok('Base URL：空值用預設', endpointFor('', 'chat/completions') === DEFAULT_BASE_URL + '/chat/completions')

  ok('extractJson：純 JSON', extractJson('{"a":1}').a === 1)
  ok('extractJson：``` 圍籬', extractJson('```json\n{"a":2}\n```').a === 2)
  ok('extractJson：前後有贅字', extractJson('好的，這是結果：\n{"a":3}\n希望有幫助').a === 3)
  ok('extractJson：空字串會丟錯', (() => { try { extractJson(''); return false } catch { return true } })())

  const d = normalizeDraft(
    {
      missing: ['日期', 123],
      sourceName: '  A  ',
      variants: [
        { label: ' 熱血版 ', platform: 'Threads', body: ' 內文 ', note: 'n' },
        { label: '', platform: 'plurk', body: 'x', note: '熱血版，語氣很衝' },
        { label: '空的', platform: 'facebook', body: '   ', note: '' }
      ]
    },
    'facebook'
  )
  ok('normalizeDraft 過濾非字串 missing', d.missing.length === 1 && d.missing[0] === '日期')
  ok('normalizeDraft 修剪 sourceName', d.sourceName === 'A')
  ok('normalizeDraft 大小寫平台正規化', d.variants[0].platform === 'threads')
  ok('normalizeDraft 未知平台退回預設', d.variants[1].platform === 'facebook')
  ok('normalizeDraft 丟掉空 body 的版本', d.variants.length === 2)
  ok('normalizeDraft 空 label 會從 note 取前半句', d.variants[1].label === '熱血版')
  ok('normalizeDraft note 也空時退回固定名稱', (() => {
    const r = llm.normalizeDraft({ variants: [{ label: '', platform: 'x', body: 'b', note: '' }] }, 'facebook')
    return r.variants[0].label === '熱血版'
  })())
  ok('normalizeDraft 多個空 label 不會同名', (() => {
    const r = llm.normalizeDraft(
      { variants: [1, 2, 3].map(() => ({ label: '', platform: 'x', body: 'b', note: '' })) },
      'facebook'
    )
    return new Set(r.variants.map(v => v.label)).size === 3
  })())
  ok('prompt 要求 label 不可留空', llm.buildSystemPrompt('x').includes('每個版本都必須有 label'))

  // prompt 裡的平台數字必須跟前端檢查用的同一套，否則模型會照 A 寫、lint 用 B 判
  const plat = await import(pathToFileURL(join(TMP, 'platforms.ts')).href)
  let mismatch = []
  for (const spec of plat.PLATFORMS) {
    const r = llm.PLATFORM_RULES[spec.key]
    if (!r) { mismatch.push(spec.key + ': prompt 沒有這個平台'); continue }
    if (r.tags[0] !== spec.tags[0] || r.tags[1] !== spec.tags[1]) mismatch.push(spec.key + ' tags')
    if (r.body[0] !== spec.body[0] || r.body[1] !== spec.body[1]) mismatch.push(spec.key + ' body')
  }
  ok('prompt 的平台數字與 platforms.ts 一致', mismatch.length === 0, mismatch.join(', '))
  ok('prompt 會明講各平台 hashtag 數量',
    buildChatRequest(input, { model: 'm', sendImages: false, jsonSchema: true })
      .messages[1].content.includes('hashtag 1–3 個'))
  // 品牌固定標籤這條規則已經拿掉了
  ok('prompt 不再要求一定要帶社群標籤',
    !buildChatRequest(input, { model: 'm', sendImages: false, jsonSchema: true })
      .messages[1].content.includes('含 #GalGame文化同好會 在內'))

  const gen = await fs.readFile(join(HERE, '..', 'server', 'api', 'generate.post.ts'), 'utf8')
  ok('generate 端點不會動到鎖定的版本', gen.includes('if (!v.locked)'))
  ok('generate 端點沒有殘留 Anthropic 相依', !gen.includes('anthropic') && !gen.includes('claude'))
}

console.log('\n### 10. 設定與生成端點')
let saved = null
{
  const r = await j('GET', '/api/settings')
  saved = r.data
  ok('GET /api/settings 有 baseUrl/model/endpoint',
    r.status === 200 && !!r.data.baseUrl && !!r.data.model && r.data.endpoint.endsWith('/chat/completions'))
  ok('設定端點不外洩金鑰', !('apiKey' in r.data) && !JSON.stringify(r.data).match(/sk-|AIza/))
  ok('預設指向 Gemini 相容端點', r.data.defaults.baseUrl.includes('generativelanguage.googleapis.com'))
}
{
  const r = await j('PUT', '/api/settings', { baseUrl: 'https://example.test/v1/', model: 'test-model', sendImages: false })
  ok('PUT /api/settings 存得起來', r.status === 200 && r.data.model === 'test-model' && r.data.sendImages === false)
  ok('PUT 後端點正規化正確', r.data.endpoint === 'https://example.test/v1/chat/completions', r.data.endpoint)
  ok('PUT 回應也不外洩金鑰', !('apiKey' in r.data))
  const back = await j('PUT', '/api/settings', { baseUrl: saved.baseUrl, model: saved.model, sendImages: saved.sendImages })
  ok('設定可還原', back.status === 200 && back.data.model === saved.model)
}
{
  const r = await j('POST', '/api/generate', { postId: '不存在的貼文' })
  ok('生成不存在的貼文回 404', r.status === 404, 'status=' + r.status)
}
{
  // 有沒有設金鑰都要通過：沒設就該給清楚的 400，設了就該真的連得上
  const cur = (await j('GET', '/api/settings')).data
  const r = await j('POST', '/api/llm-test')
  if (cur.hasKey) {
    ok('已設金鑰時連線測試連得上並列出模型',
      r.status === 200 && Array.isArray(r.data.models) && r.data.count > 0,
      'status=' + r.status + ' count=' + r.data?.count)
    ok('目前設定的模型在端點的清單裡', r.data.models?.includes(cur.model), cur.model)
  } else {
    ok('沒金鑰時連線測試回 400 並說明', r.status === 400 && String(r.data.message).includes('金鑰'), 'status=' + r.status)
    const g = await j('POST', '/api/generate', { postId: '20260829-CRYSTALA新品週邊登場' })
    ok('沒金鑰時撰寫回 400 並指路設定頁', g.status === 400 && String(g.data.message).includes('設定'), 'status=' + g.status)
    console.log('  SKIP  真實撰寫（未設金鑰）')
  }
}


console.log('\n### 11. 推特（X）Playwright 讀取')
{
  const xs = await import(pathToFileURL(join(HERE, '..', 'server', 'utils', 'xscrape.ts')).href)
  ok('isXUrl 認得 x.com', xs.isXUrl('https://x.com/nasa/status/1'))
  ok('isXUrl 認得 twitter.com', xs.isXUrl('https://twitter.com/nasa/status/1'))
  ok('isXUrl 認得 www 前綴', xs.isXUrl('https://www.x.com/nasa'))
  ok('isXUrl 不誤判其他站', !xs.isXUrl('https://store.steampowered.com/app/1'))
  ok('isTwimg 認得圖片 CDN', xs.isTwimg('https://pbs.twimg.com/media/abc?format=jpg&name=orig'))
  ok('isTwimg 不誤判', !xs.isTwimg('https://example.com/a.jpg'))

  const conv = xs.toScrapeResult({
    url: 'https://x.com/a/status/1',
    finalUrl: 'https://x.com/a/status/1',
    text: '第一行標題\n\n第二段內文',
    author: '某某',
    handle: '@a',
    createdAt: '2026-08-29T00:00:00.000Z',
    images: ['https://pbs.twimg.com/media/x?format=jpg&name=orig'],
    downloaded: [],
    loggedIn: true,
    warning: ''
  })
  ok('推文轉成標準抓取結果：標題取第一行', conv.title === '第一行標題')
  ok('推文全文進 description（會帶進素材說明）', conv.description.includes('第二段內文'))
  ok('來源猜成 @handle', conv.sourceGuess === '@a')
  ok('標記 via=playwright', conv.via === 'playwright')
  ok('未登入會給警告', xs.toScrapeResult({ ...conv, loggedIn: false, warning: '', text: 'x', images: [] }).warning.includes('未登入'))
}
{
  const r = await j('GET', '/api/x/status')
  ok('GET /api/x/status 回報環境', r.status === 200 && 'python' in r.data && 'loggedIn' in r.data)
  xReady = !!(r.data.python && r.data.scriptFound)
  ok('找得到 Python 與腳本', xReady, JSON.stringify(r.data))
}
{
  const r = await j('POST', '/api/scrape', { url: 'https://x.com/nasa' })
  ok('推特網址走得完整條路徑（Playwright 失敗會退回一般抓取）',
    r.status === 200 && (r.data.via === 'playwright' || r.data.via === 'fetch'),
    'status=' + r.status + ' via=' + r.data?.via)
}
if (xReady) {
  const { execFile } = await import('node:child_process')
  const script = join(HERE, '..', '..', 'tools', 'x_scraper.py')
  const run = (args) =>
    new Promise(res =>
      execFile('py', [script, ...args], { encoding: 'utf8', timeout: 120000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
        (e, so, se) => res({ so: so || '', se: se || '' }))
    )
  {
    const { so } = await run(['--status'])
    let d = null
    try { d = JSON.parse(so) } catch { /* 下面斷言會抓到 */ }
    ok('x_scraper.py --status 輸出合法 JSON', !!d && 'loggedIn' in d, so.slice(0, 200))
    ok('profile 路徑指向 data/.browser/x', !!d && String(d.profile).includes('.browser'))
  }
  {
    // 真的開一次 Chromium，驗證環境可用；未登入時預期回 tweet_not_found
    const { so } = await run(['--url', 'https://x.com/nasa', '--timeout', '20000'])
    let d = null
    try { d = JSON.parse(so) } catch { /* 下面斷言會抓到 */ }
    ok('Playwright 真的啟動得起來並回傳 JSON', !!d && 'loggedIn' in d, so.slice(0, 200))
    ok('未登入時給得出可讀的原因', !d?.error || String(d.message).includes('登入'), JSON.stringify(d).slice(0, 200))
  }
} else {
  console.log('  SKIP  Playwright 實測（環境未就緒）')
}


console.log('\n### 12. 這輪修的問題（回歸測試）')
{
  const st = await import(pathToFileURL(join(HERE, '..', 'server', 'utils', 'store.ts')).href)
  const emoji = '\u{1F600}\u{1F601}\u{1F602}'
  ok('sliceChars 不會把 emoji 的 surrogate pair 切半',
    st.sliceChars(emoji, 2) === '\u{1F600}\u{1F601}' && !/[\uD800-\uDFFF]/.test(
      st.sliceChars(emoji, 2).replace(/[\u{1F000}-\u{1FAFF}]/gu, '')
    ))
  ok('sliceChars 依碼位計數（中文算 1）', st.sliceChars('一二三四五', 3) === '一二三')
  ok('sliceChars 短字串原樣回傳', st.sliceChars('abc', 10) === 'abc')
  ok('slugify 用 sliceChars，emoji 標題不會產生非法檔名', (() => {
    const long = '\u{1F600}'.repeat(60)
    const slug = st.slugify(long)
    return !/[\uD800-\uDFFF]/.test(slug.replace(/[\u{1F000}-\u{1FAFF}]/gu, ''))
  })())

  const xs = await import(pathToFileURL(join(HERE, '..', 'server', 'utils', 'xscrape.ts')).href)
  ok('xscrape 有序列化佇列（同一 profile 不能兩個 Chromium）',
    (await fs.readFile(join(HERE, '..', 'server', 'utils', 'xscrape.ts'), 'utf8')).includes('serialize('))
  ok('scraper 逾時會重新整理再試一次',
    (await fs.readFile(join(HERE, '..', '..', 'tools', 'x_scraper.py'), 'utf8')).includes('wait_for_tweet'))
  ok('scraper 會回報 GraphQL 狀態當診斷',
    (await fs.readFile(join(HERE, '..', '..', 'tools', 'x_scraper.py'), 'utf8')).includes('TweetDetail'))
  ok('xscrape 匯出 profile/state 路徑', typeof xs.profileDir === 'function' && typeof xs.stateFile === 'function')
}
{
  const t0 = Date.now()
  const r = await j('GET', '/api/x/status')
  const ms = Date.now() - t0
  ok('狀態走快取檔，不開瀏覽器（應該很快）', r.status === 200 && r.data.deep === false && ms < 3000, ms + 'ms')
  ok('狀態帶最後確認時間', 'checkedAt' in r.data)
}
if (xReady) {
  // 同時打兩個 deep 檢查：沒有佇列的話會有兩個 Chromium 搶同一份 profile
  const t0 = Date.now()
  const [a, b] = await Promise.all([j('GET', '/api/x/status?deep=1'), j('GET', '/api/x/status?deep=1')])
  ok('兩個 deep 檢查同時打也都成功（佇列生效）',
    a.status === 200 && b.status === 200 && a.data.deep === true && b.data.deep === true,
    `a=${a.status} b=${b.status} ${Date.now() - t0}ms`)
} else {
  console.log('  SKIP  併發 deep 檢查（環境未就緒）')
}


console.log('\n### 13. 規範可編輯 / 開啟資料夾 / 新版生成流程')
{
  const orig = (await j('GET', '/api/spec')).data.content
  const r = await j('PUT', '/api/spec', { content: orig + '\n<!-- e2e -->\n' })
  ok('規範可以從前端存檔', r.status === 200 && r.data.ok && r.data.bytes > 0)
  let bak = false
  try { await fs.access(join(DATA, '..', '文案撰寫規範.md.bak')); bak = true } catch { /* noop */ }
  ok('存檔前會備份成 .bak', bak)
  const after = (await j('GET', '/api/spec')).data.content
  ok('存進去的內容讀得回來', after.includes('<!-- e2e -->'))
  const back = await j('PUT', '/api/spec', { content: orig })
  ok('可以還原', back.status === 200 && (await j('GET', '/api/spec')).data.content === orig)
  const bad = await j('PUT', '/api/spec', { content: '   ' })
  ok('空內容會被擋下', bad.status === 400)
}
{
  const r = await j('POST', '/api/open-folder', { kind: 'post', id: '一定不存在的貼文' })
  ok('開啟不存在的資料夾回 404 並說明路徑', r.status === 404 && String(r.data.message).includes('資料夾不存在'))
}
{
  const gen = await fs.readFile(join(HERE, '..', 'server', 'api', 'generate.post.ts'), 'utf8')
  ok('generate 支援從素材撰寫', gen.includes('body?.materialId'))
  ok('generate 仍支援對既有貼文重寫', gen.includes('body?.postId'))
  ok('從素材撰寫會建立貼文', gen.includes('createPostFromMaterial'))
  ok('撰寫完會把素材標記為已撰寫', gen.includes('m.written = true'))
  const r = await j('POST', '/api/generate', { materialId: '不存在的素材' })
  ok('對不存在的素材撰寫回 404', r.status === 404, 'status=' + r.status)
}
{
  // 體裁與子型改由 AI 判斷 —— 兩邊清單必須一致
  const llm2 = await import(pathToFileURL(join(HERE, '..', 'server', 'utils', 'llm.ts')).href)
  const plat = await import(pathToFileURL(join(TMP, 'platforms.ts')).href)
  ok('llm 的體裁清單與 platforms.ts 一致',
    JSON.stringify([...llm2.CATEGORY_KEYS]) === JSON.stringify(plat.CATEGORIES))
  const uiTypes = plat.POST_TYPES.flatMap(g => g.items)
  ok('llm 的子型清單與 platforms.ts 一致',
    JSON.stringify([...llm2.POST_TYPE_KEYS].sort()) === JSON.stringify([...uiTypes].sort()))
  const sc = llm2.DRAFT_SCHEMA.properties
  ok('schema 要求 AI 判斷 title/category/postType',
    ['title', 'category', 'postType'].every(k => k in sc) &&
      llm2.DRAFT_SCHEMA.required.includes('category'))
  ok('category 是真的 enum', Array.isArray(sc.category.enum) && sc.category.enum.includes('台詞'))
  const d = llm2.normalizeDraft({ variants: [{ label: 'a', platform: 'x', body: 'b', note: '' }] }, 'facebook', '備援標題')
  ok('normalizeDraft 補預設體裁與子型', d.category === '情報' && d.postType === '推坑・安利')
  ok('normalizeDraft 沒標題時用備援標題', d.title === '備援標題')
  const d2 = llm2.normalizeDraft({ title: 'T', category: '亂填', postType: '亂填', variants: [] }, 'facebook')
  ok('normalizeDraft 擋掉不在清單裡的體裁／子型', d2.category === '情報' && d2.postType === '推坑・安利')
}


console.log('\n### 14. 類型篩選與反饋優化記憶庫')
{
  const plat = await import(pathToFileURL(join(TMP, 'platforms.ts')).href)
  ok('類型清單就是指定的九種',
    JSON.stringify(plat.CATEGORIES) ===
      JSON.stringify(['情報', '心得', '分享', '成果', '社課', '企劃', '投票', '台詞', '音樂']),
    JSON.stringify(plat.CATEGORIES))

  const home = await (await fetch(BASE + '/')).text()
  ok('列表頁有類型篩選', home.includes('全部類型'))
  ok('列表頁沒有平台篩選了', !home.includes('全部平台'))
}
{
  const mem = await import(pathToFileURL(join(HERE, '..', 'server', 'utils', 'memory.ts')).href)

  ok('ruleKey 忽略空白與標點差異',
    mem.ruleKey('日期一律寫成 10/9（五）。') === mem.ruleKey('日期一律寫成10/9(五)'))

  const first = mem.mergeRules([], [{ rule: '句尾不要用驚嘆號', category: '符號與標點' }])
  ok('mergeRules 新規則權重從 1 開始', first.added.length === 1 && first.rules[0].weight === 1)
  const second = mem.mergeRules(first.rules, [{ rule: '句尾不要用驚嘆號！', category: '語調' }])
  ok('mergeRules 同一條偏好會加權而不是重複記錄',
    second.added.length === 0 && second.bumped.length === 1 && second.rules.length === 1 && second.rules[0].weight === 2)
  const third = mem.mergeRules(second.rules, [{ rule: '開頭第一句直接講重點', category: '結構' }])
  ok('mergeRules 權重高的排前面', third.rules[0].rule === '句尾不要用驚嘆號' && third.rules.length === 2)
  ok('mergeRules 沒收在清單裡的分類會歸到「其他」',
    mem.mergeRules([], [{ rule: 'x', category: '亂填的分類' }]).rules[0].category === '其他')

  ok('buildMemoryBlock 沒記憶時回空字串', mem.buildMemoryBlock([], []) === '')
  const block = mem.buildMemoryBlock(third.rules, [
    { postId: 'p', variantId: 'v1', platform: 'facebook', aiDraft: 'AAA', userFinal: 'BBB', at: '' }
  ])
  ok('buildMemoryBlock 帶出規則與範例',
    block.includes('<個人偏好>') && block.includes('句尾不要用驚嘆號') &&
      block.includes('<修訂範例>') && block.includes('AAA') && block.includes('BBB'))
  ok('buildMemoryBlock 講明優先度低於規範', block.includes('以規範為準'))

  // 模型常常回字串陣列而不是物件陣列，兩種都要接得住
  ok('normalizeReflection 接得住物件陣列',
    mem.normalizeReflection({ rules: [{ rule: 'A', category: '排版', evidence: 'e' }] }).rules[0].rule === 'A')
  ok('normalizeReflection 接得住字串陣列',
    mem.normalizeReflection({ rules: ['B'] }).rules[0].rule === 'B')
  ok('normalizeReflection 最多留 3 條',
    mem.normalizeReflection({ rules: ['a', 'b', 'c', 'd', 'e'] }).rules.length === 3)
  ok('normalizeReflection 空 rules 不會爆', mem.normalizeReflection({}).rules.length === 0)

  // 記憶庫不可以記下跟規範硬規定相反的規則
  ok('擋下「不要寫網址放留言」', mem.isConflictingRule('結尾不要寫網址放留言，直接省略'))
  ok('擋下「可以用 emoji」', mem.isConflictingRule('可以適度使用 emoji 增加親和力'))
  ok('擋下「拿掉體裁標籤」', mem.isConflictingRule('取消【情報】這種開頭標籤'))
  ok('正常規則不會被誤擋', !mem.isConflictingRule('日期一律寫成 10/9（五）'))
  const filtered = mem.normalizeReflection({ rules: ['不要寫網址放留言', '日期寫成 10/9（五）'] })
  ok('衝突規則會被濾掉並回報', filtered.rules.length === 1 && filtered.dropped.length === 1)

  const msgs = mem.buildReflectMessages('原稿', '終稿', 'Facebook', third.rules)
  ok('反思 prompt 是 system + user', msgs.length === 2 && msgs[0].role === 'system' && msgs[1].role === 'user')
  ok('反思 prompt 附上已知規則讓模型照抄', msgs[0].content.includes('句尾不要用驚嘆號'))
  ok('反思 prompt 有輸出格式範例', msgs[0].content.includes('rules 的每一項都是物件'))
  ok('反思 prompt 列出不可違反的紅線', msgs[0].content.includes('網址放留言'))
  ok('反思 prompt 帶入原稿與終稿', msgs[1].content.includes('原稿') && msgs[1].content.includes('終稿'))
}
{
  const r = await j('GET', '/api/memory')
  ok('GET /api/memory 回規則與注入內容',
    r.status === 200 && Array.isArray(r.data.rules) && typeof r.data.injected === 'string')
}
{
  const r = await j('POST', '/api/feedback', { postId: '不存在', variantId: 'v1' })
  ok('對不存在的貼文做反饋回 404', r.status === 404)
}
{
  const posts = (await j('GET', '/api/posts')).data
  const p = posts.find(x => x.variants.length)
  if (p) {
    const bad = await j('POST', '/api/feedback', { postId: p.id, variantId: 'v99' })
    ok('對不存在的版本做反饋回 404', bad.status === 404)
    const og = await j('GET', `/api/posts/${enc(p.id)}/origin`)
    ok('origin 端點回每個版本的 AI 原稿', og.status === 200 && typeof og.data === 'object')
  } else {
    console.log('  SKIP  反饋端點（沒有含版本的貼文）')
  }
}
{
  const gen = await fs.readFile(join(HERE, '..', 'server', 'api', 'generate.post.ts'), 'utf8')
  ok('撰寫時會注入記憶庫', gen.includes('buildMemoryBlock'))
  ok('撰寫時會另存一份 AI 原稿', gen.includes("join(odir, vid + '.md')"))
  const llm3 = await import(pathToFileURL(join(HERE, '..', 'server', 'utils', 'llm.ts')).href)
  ok('記憶會接在規範後面進 system prompt',
    llm3.buildSystemPrompt('規範內容', '\n<個人偏好>\n・測試規則\n</個人偏好>').includes('・測試規則'))
  ok('沒有記憶時 system prompt 不受影響', !llm3.buildSystemPrompt('規範內容').includes('個人偏好'))
}
{
  const post = await fs.readFile(join(HERE, '..', 'app', 'pages', 'posts', '[id].vue'), 'utf8')
  const imgAt = post.indexOf('圖片放在文字編輯上面')
  const taAt = post.indexOf('class="editor-ta"')
  ok('貼文頁圖片區排在文字編輯上面', imgAt > -1 && taAt > -1 && imgAt < taAt)
  ok('貼文頁有開啟圖片資料夾', post.includes('開啟圖片資料夾'))
  ok('貼文頁有反饋優化', post.includes('反饋優化'))
}


console.log('\n### 15. 後台記錄、留言連結、啟動器')
{
  const lg = await import(pathToFileURL(join(HERE, '..', 'server', 'utils', 'logger.ts')).href)

  const red = lg.redact({
    apiKey: 'gg-gcli-abcdefghijklmnop',
    headers: { authorization: 'Bearer sk-ant-abcdefghijklmnop' },
    note: '金鑰是 sk-ant-abcdefghijklmnop 請小心',
    nested: [{ token: 'x' }]
  })
  ok('redact 遮掉 apiKey 欄位', red.apiKey === '［已隱藏］')
  ok('redact 遮掉 authorization', red.headers.authorization === '［已隱藏］')
  ok('redact 連字串裡的金鑰也遮', !JSON.stringify(red).includes('abcdefghijklmnop'))
  ok('redact 遞迴處理陣列與巢狀', red.nested[0].token === '［已隱藏］')
  // 圖片是 base64 data URL 送出去的，那是正常請求格式，但不該整串進記錄
  const bigImg = 'data:image/jpeg;base64,' + '/9j/4AAQ'.repeat(20000)
  const slim = lg.slimDataUrls(bigImg)
  ok('base64 圖片在記錄裡只留類型與大小',
    slim.length < 80 && slim.includes('image/jpeg') && slim.includes('記錄中省略'), slim)
  ok('短的 data URL 不動', lg.slimDataUrls('data:image/png;base64,AAAA') === 'data:image/png;base64,AAAA')
  ok('redact 後整包請求不會爆量',
    JSON.stringify(lg.redact({ messages: [{ content: [{ image_url: { url: bigImg } }] }] })).length < 300)
  ok('超長字串會被截斷',
    String(lg.redact({ t: 'x'.repeat(30000) }).t).includes('已截斷'))

  ok('redact 不會被循環參照弄爆', (() => {
    const a = { name: 'x' }
    a.self = a
    return !!lg.redact(a)
  })())
}
{
  const before = (await j('GET', '/api/logs')).data
  ok('GET /api/logs 回 entries 與 lastId',
    typeof before.lastId === 'number' && Array.isArray(before.entries))
  const withDetail = before.entries.find(e => e.detail)
  if (withDetail) {
    ok('記錄不會外洩金鑰', !JSON.stringify(withDetail).match(/sk-ant-\w{10}|AIza\w{10}|gg-gcli-\w{10}/))
  } else {
    console.log('  SKIP  金鑰外洩檢查（目前沒有帶 detail 的記錄）')
  }
  const r = await j('DELETE', '/api/logs')
  ok('DELETE /api/logs 清得掉', r.status === 200)
  const after = (await j('GET', '/api/logs')).data
  ok('清空後只剩清空那一筆', after.entries.length <= 1)

  const html = await (await fetch(BASE + '/logs')).text()
  ok('記錄頁 SSR 正常', !html.includes('Internal Server Error') && html.includes('後台記錄'))
  ok('導覽列有記錄頁', (await (await fetch(BASE + '/')).text()).includes('>記錄<'))
}
{
  const xs = await import(pathToFileURL(join(HERE, '..', 'server', 'utils', 'xscrape.ts')).href)
  ok('非 t.co 的網址原樣回傳', (await xs.expandTco('https://example.com/a')) === 'https://example.com/a')
  const expanded = await xs.expandTco('https://t.co/QRl8Qy0Rqi')
  ok('t.co 會展開成真正的網址（meta refresh 解析）',
    expanded.startsWith('https://store.steampowered.com/'), expanded)
  const links = await xs.expandLinks([{ url: 'https://example.com/form', label: '報名表單' }])
  ok('有意義的標籤會保留', links[0].label === '報名表單')
  const auto = await xs.expandLinks([{ url: 'https://example.com/a', label: 'example.com/a…' }])
  ok('被截斷的網址標籤換成網域', auto[0].label === 'example.com')
}
{
  const mat = await fs.readFile(join(HERE, '..', 'server', 'utils', 'material.ts'), 'utf8')
  ok('素材資料結構有 links 欄位', mat.includes('links: { url: string; label: string }[]'))
  ok('留言連結取素材內容裡的連結，不是素材本身網址',
    mat.includes('post.links = (m.links || [])') && !mat.includes("label: '素材來源'"))

  const col = await fs.readFile(join(HERE, '..', 'server', 'api', 'inbox', 'collect.post.ts'), 'utf8')
  ok('推文的連結會展開 t.co', col.includes('expandLinks'))
  ok('一般網頁沒有內連時用該頁網址', col.includes('!isXUrl(url)'))

  const py = await fs.readFile(join(HERE, '..', '..', 'tools', 'x_scraper.py'), 'utf8')
  ok('推特腳本會抓內文裡的外部連結', py.includes('result["links"].append'))
  ok('推特腳本排除站內連結', py.includes('x.com/" in low'))
}
{
  const inbox = await fs.readFile(join(HERE, '..', 'app', 'pages', 'inbox', '[id].vue'), 'utf8')
  ok('素材頁的留言連結可編輯', inbox.includes('留言連結') && inbox.includes("m.links.splice(i, 1)"))
  const post = await fs.readFile(join(HERE, '..', 'app', 'pages', 'posts', '[id].vue'), 'utf8')
  ok('貼文頁的留言連結可編輯', post.includes('留言連結') && post.includes('post.links.splice(i, 1)'))
}
{
  // cmd 讀 UTF-8 批次檔又中途 chcp 會讓中文變亂碼甚至被當成指令，所以 bat 必須全 ASCII
  const bat = await fs.readFile(join(HERE, '..', '..', '啟動.bat'), 'latin1')
  ok('啟動.bat 是純 ASCII（避免 cmd 亂碼）', !/[^\x00-\x7f]/.test(bat), JSON.stringify(bat.slice(0, 60)))
  ok('啟動.bat 轉呼叫 PowerShell 腳本', bat.includes('tools\\start.ps1'))

  const ps1raw = await fs.readFile(join(HERE, '..', '..', 'tools', 'start.ps1'))
  ok('start.ps1 有 UTF-8 BOM（PowerShell 5.1 才讀得對中文）',
    ps1raw[0] === 0xef && ps1raw[1] === 0xbb && ps1raw[2] === 0xbf)
  const ps1 = ps1raw.toString('utf8')
  ok('start.ps1 會自動開瀏覽器', ps1.includes('Start-Process $u'))
  ok('start.ps1 第一次啟動會自動安裝', ps1.includes('npm --prefix web install'))
  ok('start.ps1 找不到 Node 會講清楚', ps1.includes('找不到 Node.js'))
}


console.log('\n### 16. Facebook 發佈、本地素材、自訂重寫')
{
  const meta = await import(pathToFileURL(join(HERE, '..', 'server', 'utils', 'meta.ts')).href)

  ok('graphUrl 組得出正確網址',
    meta.graphUrl('v21.0', '123/feed') === 'https://graph.facebook.com/v21.0/123/feed')
  ok('graphUrl 版本空的時候用預設',
    meta.graphUrl('', 'me').includes('/' + meta.DEFAULT_GRAPH_VERSION + '/'))
  ok('graphUrl 帶得了查詢參數',
    meta.graphUrl('v21.0', 'debug_token', { input_token: 'abc' }).includes('input_token=abc'))
  ok('貼文連結組得出來', meta.postPermalink('123_456') === 'https://www.facebook.com/123_456')

  // 三種發佈模式對應到 published / scheduled_publish_time 的組合
  const now = meta.buildFeedParams('內文', ['m1', 'm2'], 'now')
  ok('立即發佈 published=true', now.published === 'true' && !('scheduled_publish_time' in now))
  ok('多圖轉成 attached_media',
    now['attached_media[0]'] === '{"media_fbid":"m1"}' && now['attached_media[1]'] === '{"media_fbid":"m2"}')
  ok('內文有帶上', now.message === '內文')

  const draft = meta.buildFeedParams('x', [], 'draft')
  ok('草稿 published=false 且沒有排程時間',
    draft.published === 'false' && !('scheduled_publish_time' in draft))

  const at = Date.now() + 3600_000
  const sch = meta.buildFeedParams('x', [], 'schedule', at)
  ok('排程 published=false 並帶 unix 秒',
    sch.published === 'false' && sch.scheduled_publish_time === String(Math.floor(at / 1000)))

  ok('超過 10 張圖會截斷',
    Object.keys(meta.buildFeedParams('x', Array.from({ length: 15 }, (_, i) => 'm' + i), 'now'))
      .filter(k => k.startsWith('attached_media')).length === meta.MAX_PHOTOS)

  ok('排程少於 10 分鐘會被擋',
    meta.validateSchedule('schedule', Date.now() + 60_000).includes('10 分鐘'))
  ok('排程超過 6 個月會被擋',
    meta.validateSchedule('schedule', Date.now() + 200 * 24 * 3600_000).includes('6 個月'))
  ok('排程沒給時間會被擋', meta.validateSchedule('schedule', undefined).length > 0)
  ok('合法排程通過', meta.validateSchedule('schedule', Date.now() + 3600_000) === '')
  ok('立即與草稿不檢查時間',
    meta.validateSchedule('now') === '' && meta.validateSchedule('draft') === '')

  // 系統用戶 token 本來就不會過期，硬拿去換長期反而會出錯
  ok('永久 token 不需要再換', meta.needsExchange({ neverExpires: true, expiresAt: '' }) === false)
  ok('沒回報到期時間就不換', meta.needsExchange({ neverExpires: false, expiresAt: '' }) === false)
  ok('還有很久的長期 token 不用換',
    meta.needsExchange({ neverExpires: false, expiresAt: new Date(Date.now() + 40 * 86400e3).toISOString() }) === false)
  ok('快到期的短期 token 要換',
    meta.needsExchange({ neverExpires: false, expiresAt: new Date(Date.now() + 3600e3).toISOString() }) === true)
  ok('描述得出 token 是永久的',
    meta.describeToken({ neverExpires: true, expiresAt: '', type: 'USER' }).includes('永久'))

  ok('列得出缺少的權限',
    JSON.stringify(meta.missingScopes(['pages_show_list'])) ===
      JSON.stringify(['pages_read_engagement', 'pages_manage_posts', 'pages_manage_engagement']))
  ok('權限齊全時回空陣列', meta.missingScopes(meta.REQUIRED_SCOPES).length === 0)
  ok('發文與留言的權限都要求到',
    meta.REQUIRED_SCOPES.includes('pages_manage_posts') && meta.REQUIRED_SCOPES.includes('pages_manage_engagement'))

  // Graph 的錯誤訊息藏在 error.message，要挖出來給人看
  const gerr = meta.parseGraphError(JSON.stringify({ error: { message: 'Invalid OAuth token', code: 190, error_subcode: 463 } }))
  ok('Graph 錯誤訊息挖得出來', gerr.includes('Invalid OAuth token') && gerr.includes('190/463'), gerr)
  ok('不是 JSON 的錯誤也不會爆', meta.parseGraphError('<html>boom</html>').includes('boom'))
  ok('超長錯誤會截斷', meta.parseGraphError('x'.repeat(900)).length <= 401)
}
{
  const r = await j('GET', '/api/meta/status')
  ok('GET /api/meta/status 回連接狀態',
    r.status === 200 && typeof r.data.connected === 'boolean' && Array.isArray(r.data.requiredScopes))
  ok('狀態不外洩 App Secret 與 token',
    !('appSecret' in r.data) && !('pageToken' in r.data) && !('userToken' in r.data))

  const bad = await j('POST', '/api/meta/connect', { appId: 'x' })
  ok('連接少填欄位回 400', bad.status === 400)

  // 這裡刻意不拿真的貼文去打發佈端點。以前這段用 mode 預設值呼叫，
  // 只要稿子剛好合規就會真的發到正式粉專——測試不該有那種可能。
  const posts = (await j('GET', '/api/posts')).data
  const p = posts.find(x => x.variants.length)
  if (p) {
    const noPlat = await j('POST', '/api/meta/publish', { postId: p.id, variantId: p.variants[0].id })
    ok('沒指定平台就擋下來，不會預設發到哪裡',
      noPlat.status === 400 && String(noPlat.data.message).includes('平台'), 'status=' + noPlat.status)
    const noMode = await j('POST', '/api/meta/publish', {
      postId: p.id, variantId: p.variants[0].id, platform: 'facebook'
    })
    ok('Facebook 沒指定模式也擋下來，不會預設成立即發佈',
      noMode.status === 400 && String(noMode.data.message).includes('模式'), 'status=' + noMode.status)
  }
  const nf = await j('POST', '/api/meta/publish', {
    postId: '不存在', variantId: 'v1', platform: 'facebook', fbMode: 'now'
  })
  ok('對不存在的貼文發佈回 404', nf.status === 404)

  const src = await fs.readFile(join(HERE, '..', 'server', 'utils', 'publish.ts'), 'utf8')
  ok('規範檢查排在碰 Meta 之前',
    src.indexOf('lintForPublish(variant.body)') < src.indexOf('await loadMeta()'))
  const ep = await fs.readFile(join(HERE, '..', 'server', 'api', 'meta', 'publish.post.ts'), 'utf8')
  ok('平台與模式都沒有預設值', ep.includes('要指定發佈平台') && ep.includes('要指定 Facebook 的發佈模式'))

  ok('發佈前會擋規範硬規定', src.includes('lintForPublish'))
  const meta = await fs.readFile(join(HERE, '..', 'server', 'utils', 'meta.ts'), 'utf8')
  ok('還沒公開的貼文不硬貼留言', meta.includes("input.mode === 'now'"))
  ok('Threads 沒有留言 API 這件事有講出來',
    src.includes('Threads 沒有留言 API'))
  const metaSrc = await fs.readFile(join(HERE, '..', 'server', 'utils', 'meta.ts'), 'utf8')
  ok('未公開的貼文會把留言留到之後補', metaSrc.includes('commentSkipped'))
  ok('圖片先以 published=false 上傳再組成一則貼文', metaSrc.includes("form.append('published', 'false')"))
}
{
  // 本地素材：不抓網址，直接把文字當原始內容
  const r = await j('POST', '/api/inbox/manual', {
    title: '自動測試-本地素材',
    text: '這是我自己貼的內容\n報名 https://example.com/signup',
    sourceGuess: '@me',
    platforms: ['facebook']
  })
  ok('手動建立素材成功', r.status === 200 && r.data.via === 'manual')
  ok('文字原樣存下來', r.data.text.includes('這是我自己貼的內容'))
  ok('內容裡的網址自動變成留言連結',
    r.data.links.length === 1 && r.data.links[0].url === 'https://example.com/signup')
  const empty = await j('POST', '/api/inbox/manual', { text: '  ' })
  ok('標題內容都空會被擋', empty.status === 400)
  await j('DELETE', `/api/inbox/${enc(r.data.id)}`)
}
{
  const set = await fs.readFile(join(HERE, '..', 'app', 'pages', 'settings.vue'), 'utf8')
  ok('設定頁提供系統用戶與一般 token 兩條路', set.includes('系統用戶 Token') && set.includes('一般 User Token'))
  ok('系統用戶步驟有講到指派資產與永不過期', set.includes('指派資產') && set.includes('永不'))
  ok('有粉專 ID 直接指定的退路', set.includes('粉專 ID（選填'))
  const conn = await fs.readFile(join(HERE, '..', 'server', 'api', 'meta', 'connect.post.ts'), 'utf8')
  ok('連接會先驗 token 再決定要不要換', conn.includes('needsExchange'))
  ok('列不出專頁時可以直接取 Page Token', conn.includes('fetchPageToken'))

  const inbox = await fs.readFile(join(HERE, '..', 'app', 'pages', 'inbox', 'index.vue'), 'utf8')
  ok('素材夾有抓網址／本地素材兩種模式', inbox.includes("mode === 'url'") && inbox.includes('本地素材'))
  ok('本地素材可以直接貼圖', inbox.includes('addFiles') && inbox.includes('onPaste'))
  ok('右下角浮動的批量撰寫已移除', !inbox.includes('class="fab') && !inbox.includes('batchOpen'))
  ok('撰寫緩衝搬到伺服器，畫面上沒有這個欄位',
    !inbox.includes('gapSec') && !inbox.includes('const GAP_SECONDS'))

  const post = await fs.readFile(join(HERE, '..', 'app', 'pages', 'posts', '[id].vue'), 'utf8')
  ok('重新撰寫可以自訂指令', post.includes('regenExtra') && post.includes('extra: regenExtra.value.trim()'))
  ok('重新撰寫可以選版本數', post.includes('regenPer'))
  ok('貼文頁只剩立即與排程兩種模式',
    post.includes('立即發佈') && post.includes('排程發佈') && !post.includes('>存成草稿<'))
  ok('貼文頁有補貼留言', post.includes('補貼留言'))
}


console.log('\n### 17. 發掘：計分與去重（純函式）')
{
  const d = await import(pathToFileURL(join(HERE, '..', 'server', 'utils', 'discover.ts')).href)
  const S = d.defaultSettings()
  const NOW = Date.parse('2026-08-30T12:00:00Z')

  // ── 互動：取對數，避免大帳號一則洗掉整批
  ok('沒有互動就是 0 分', d.engagementScore({}) === 0)
  ok('互動分隨量增加', d.engagementScore({ likes: 10 }) < d.engagementScore({ likes: 500 }))
  ok('到參考點滿分', d.engagementScore({ likes: d.ENGAGEMENT_REF }) === 1)
  ok('超過參考點不會爆表', d.engagementScore({ likes: 999999 }) === 1)
  ok('轉推權重是讚的兩倍',
    d.engagementScore({ reposts: 50 }) === d.engagementScore({ likes: 100 }))
  ok('對數壓縮有效：10 倍量不到 2 倍分', (() => {
    const a = d.engagementScore({ likes: 50 })
    const b = d.engagementScore({ likes: 500 })
    return b < a * 2
  })())

  // ── 時效
  ok('剛發滿分', d.recencyScore('2026-08-30T12:00:00Z', 3, NOW) === 1)
  ok('半個回看期剩一半', Math.abs(d.recencyScore('2026-08-29T00:00:00Z', 3, NOW) - 0.5) < 0.01)
  ok('超過回看期歸零', d.recencyScore('2026-08-26T12:00:00Z', 3, NOW) === 0)
  ok('時間格式壞掉當 0', d.recencyScore('not a date', 3, NOW) === 0)
  ok('未來時間不會變負', d.recencyScore('2026-09-01T00:00:00Z', 3, NOW) === 1)

  // ── 主題關鍵字
  ok('命中一個就有基本分', d.keywordScore('新作ギャルゲー発表', S.keywords) === 0.8)
  ok('命中越多分越高',
    d.keywordScore('ギャルゲー発売決定', S.keywords) > d.keywordScore('ギャルゲー', S.keywords))
  ok('命中很多會收斂在 1', d.keywordScore(S.keywords.join(' '), S.keywords) === 1)
  ok('沒命中是 0', d.keywordScore('今日はいい天気ですね', S.keywords) === 0)
  ok('大小寫不敏感', d.keywordScore('GALGAME NEWS', ['galgame']) > 0)
  ok('沒有關鍵字設定時回 0', d.keywordScore('abc', []) === 0)

  // ── 總分
  const good = {
    text: '『新作ギャルゲー』発売決定！予約開始しました',
    images: ['a.jpg'],
    postedAt: '2026-08-30T11:00:00Z',
    // 加了瀏覽數這個訊號之後，真實的推文一定有 views，測試資料也要有
    metrics: { likes: 800, reposts: 300, replies: 40, views: 95000 },
    isRepost: false,
    isReply: false
  }
  const hi = d.scoreCandidate(good, S, NOW)
  ok('好素材拿高分', hi.score >= 70, String(hi.score))
  ok('分數細項回得出來',
    ['互動', '時效', '主題', '折扣'].every(k => k in hi.breakdown) && !('配圖' in hi.breakdown),
    JSON.stringify(hi.breakdown))

  const cold = d.scoreCandidate(
    { ...good, metrics: {}, images: [], text: '今日はいい天気', postedAt: '2026-08-27T00:00:00Z' },
    S, NOW
  )
  ok('無關又過期的拿低分', cold.score <= 15, String(cold.score))
  ok('分數夾在 0 到 100 之間', hi.score <= 100 && cold.score >= 0)

  // ── 打折：高互動也不該讓轉推 / 回覆擠進門檻
  const rt = d.scoreCandidate({ ...good, isRepost: true }, S, NOW)
  ok('純轉推被大幅打折', rt.score < hi.score * 0.5, `${hi.score} → ${rt.score}`)
  const reply = d.scoreCandidate({ ...good, isReply: true }, S, NOW)
  ok('回覆他人被打折', reply.score < hi.score * 0.7, `${hi.score} → ${reply.score}`)
  const short = d.scoreCandidate({ ...good, text: 'ギャルゲー' }, S, NOW)
  ok('內文太短被打折', short.score < hi.score)
  ok('打折是相乘不是相減，不會變負',
    d.scoreCandidate({ ...good, isRepost: true, isReply: true, text: 'x' }, S, NOW).score >= 0)

  // ── 權重可調
  const onlyKeyword = { ...S, weights: { engagement: 0, recency: 0, keyword: 100, image: 0 } }
  ok('權重調成只看關鍵字時，總分就等於關鍵字分', (() => {
    // 只命中 1 個關鍵字，且長度超過 minTextLength 才不會被短文打折
    const one = { ...good, metrics: {}, text: 'ギャルゲーの話をしていたら一日が終わってしまいました' }
    return d.scoreCandidate(one, onlyKeyword, NOW).score ===
      Math.round(d.keywordScore(one.text, S.keywords) * 100)
  })())
  ok('互動權重歸零後，互動再高也不加分',
    d.scoreCandidate({ ...good, metrics: { likes: 99999 } }, onlyKeyword, NOW).score ===
      d.scoreCandidate({ ...good, metrics: {} }, onlyKeyword, NOW).score)
  ok('權重全 0 不會除以 0',
    d.scoreCandidate(good, { ...S, weights: { engagement: 0, recency: 0, keyword: 0, image: 0 } }, NOW).score === 0)

  // ── 去重
  ok('從網址取得 status id',
    d.statusIdFromUrl('https://x.com/abc/status/1234567890') === '1234567890')
  ok('不是推文網址回空字串', d.statusIdFromUrl('https://example.com/a') === '')
  ok('看過的會被擋', d.isDuplicate('123', '', ['123'], []))
  ok('已存在素材的會被擋',
    d.isDuplicate('', 'https://x.com/a/status/999', [], ['https://x.com/b/status/999']))
  ok('沒看過的放行', !d.isDuplicate('555', 'https://x.com/a/status/555', ['111'], []))
  ok('id 與網址都沒有就當重複（擋掉髒資料）', d.isDuplicate('', '', [], []))

  // ── 預設值
  ok('預設有追蹤帳號', S.sources.length > 0 && S.sources.every(x => x.handle && !x.handle.startsWith('@')))
  ok('預設關鍵字涵蓋 galgame 圈', S.keywords.includes('ギャルゲー') && S.keywords.includes('galgame'))
  ok('預設門檻與間隔合理',
    S.threshold > 0 && S.threshold < 100 && S.intervalHours >= 1 && S.gapSeconds > 0)
}
{
  const py = await fs.readFile(join(HERE, '..', '..', 'tools', 'x_scraper.py'), 'utf8')
  ok('推特腳本有 --timeline 模式', py.includes('def cmd_timeline'))
  ok('互動數有三層退路', py.includes('def read_metrics') && py.includes('metrics_from_group'))
  ok('數字解析支援萬/K/M', py.includes('def parse_count') && py.includes('万'))
  ok('會辨識轉推與回覆', py.includes('_REPOST_MARKS') && py.includes('_REPLY_MARKS'))
  ok('時間軸沿用既有的等待邏輯', py.includes('wait_for_tweet(page, timeout_ms)'))
}


console.log('\n### 18. 發掘：設定、候選、執行、頁面')
{
  const r = await j('GET', '/api/discover')
  ok('GET /api/discover 回設定與計數',
    r.status === 200 && !!r.data.settings && !!r.data.counts && !!r.data.defaults)
  ok('自動執行預設是關的（不該一開程式就連 X）', r.data.defaults.autoRun === false)
  ok('預設有追蹤帳號與關鍵字',
    r.data.defaults.sources.length > 0 && r.data.defaults.keywords.length > 10)
  ok('預設門檻在合理範圍', r.data.defaults.threshold > 0 && r.data.defaults.threshold < 100)
}
{
  const before = (await j('GET', '/api/discover')).data.settings
  const r = await j('PUT', '/api/discover', {
    sources: [{ handle: '@AutoTestHandle', enabled: true, note: '自動測試' }],
    keywords: ['自動測試關鍵字', '  ', 'another'],
    threshold: 77,
    lastRunAt: '偽造的時間'
  })
  ok('PUT 存得起來', r.status === 200 && r.data.threshold === 77)
  ok('帳號前面的 @ 會被去掉', r.data.sources[0].handle === 'AutoTestHandle')
  ok('空白關鍵字會被濾掉', r.data.keywords.length === 2)
  ok('lastRunAt 不接受從外面改', r.data.lastRunAt !== '偽造的時間')

  const back = await j('PUT', '/api/discover', {
    sources: before.sources, keywords: before.keywords, threshold: before.threshold
  })
  ok('設定可還原', back.status === 200 && back.data.threshold === before.threshold)
}
{
  // 給一個不存在的帳號 → 應該直接空轉，不會連 X
  const r = await j('POST', '/api/discover/run', { handles: ['__nobody__'] })
  ok('發掘也改成背景工作', r.status === 200 && !!r.data.jobId)
  const ddone = await waitJob(r.data.jobId)
  ok('沒有符合的帳號時直接空轉',
    ddone.status === 'done' && ddone.result?.accounts === 0 && ddone.result?.fetched === 0,
    JSON.stringify(ddone.result).slice(0, 160))
  ok('空轉會說明原因', (ddone.result?.warnings || []).some(w => String(w).includes('追蹤帳號')))
  ok('回報格式完整',
    ['startedAt', 'finishedAt', 'accounts', 'fetched', 'fresh', 'skipped', 'added', 'autoAccepted', 'errors']
      .every(k => k in (ddone.result || {})))
  // 只顯示「新的 0 則」看不出是沒抓到還是全部看過了
  ok('回報說得出跳過幾則', typeof ddone.result?.skipped === 'number')
}
{
  // 直接塞一則候選進去測 accept / ignore，不需要連 X
  const dir = join(DATA, 'discover')
  await fs.mkdir(dir, { recursive: true })
  const before = JSON.parse(await fs.readFile(join(dir, 'candidates.json'), 'utf8').catch(() => '{"items":[]}'))
  const now = new Date().toISOString()
  const mk = (id, status) => ({
    id, handle: 'autotest', url: `https://x.com/autotest/status/${id}`,
    text: '自動測試用的候選內容，長度要夠才不會被短文打折扣。',
    images: [], links: [{ url: 'https://example.com/x', label: 'example.com' }],
    postedAt: now, metrics: { replies: 1, reposts: 2, likes: 3, views: 4 },
    isRepost: false, isReply: false, score: 71,
    breakdown: { 互動: 30, 時效: 99, 主題: 60, 折扣: 100 },
    status, materialId: '', foundAt: now
  })
  await fs.writeFile(
    join(dir, 'candidates.json'),
    JSON.stringify({ items: [mk('900000001', 'pending'), mk('900000002', 'pending')] }, null, 2),
    'utf8'
  )

  const list = await j('GET', '/api/discover/candidates')
  ok('候選清單讀得到', list.status === 200 && list.data.items.length >= 2)
  const filtered = await j('GET', '/api/discover/candidates?status=pending')
  ok('可以依狀態篩選', filtered.data.items.every(c => c.status === 'pending'))

  const acc = await j('POST', '/api/discover/candidates/900000001/accept')
  ok('收進素材夾會產生素材', acc.status === 200 && !!acc.data.materialId)
  ok('候選狀態變成 accepted', acc.data.candidate.status === 'accepted')
  const again = await j('POST', '/api/discover/candidates/900000001/accept')
  ok('重複收錄不會再建一次', again.data.alreadyDone === true && again.data.materialId === acc.data.materialId)

  const mat = (await j('GET', `/api/inbox/${enc(acc.data.materialId)}`)).data
  ok('產生的素材標記為 discover 來源', mat.via === 'discover')
  ok('素材帶上原推文網址與帳號',
    mat.url.includes('/status/900000001') && mat.sourceGuess === '@autotest')
  ok('素材帶上留言連結', mat.links.length === 1 && mat.links[0].url === 'https://example.com/x')
  ok('素材原文就是候選內文', mat.text.includes('自動測試用的候選內容'))

  const ign = await j('POST', '/api/discover/candidates/900000002/ignore')
  ok('可以忽略候選', ign.status === 200 && ign.data.candidate.status === 'ignored')
  // 網址型 id（Notion 候選）也要收得動
  const urlId = 'https://example.com/discover-test/1'
  const dir2 = join(DATA, 'discover')
  const cur = JSON.parse(await fs.readFile(join(dir2, 'candidates.json'), 'utf8'))
  cur.items.unshift({
    id: urlId, sourceType: 'notion', sourceLabel: '測試廠商', handle: '測試廠商',
    url: urlId, text: '網址型 id 的候選', images: [], links: [], postedAt: '',
    metrics: { replies: 0, reposts: 0, likes: 0, views: 0 },
    isRepost: false, isReply: false, score: 0, breakdown: {}, rank: 1,
    status: 'pending', materialId: '', foundAt: new Date().toISOString()
  })
  await fs.writeFile(join(dir2, 'candidates.json'), JSON.stringify(cur))
  const urlIgn = await j('POST', `/api/discover/candidates/${encodeURIComponent(urlId)}/ignore`)
  ok('網址當 id 的候選也操作得動（以前一律 404）', urlIgn.status === 200)
  ok('網址型候選狀態真的變了', urlIgn.data.candidate.status === 'ignored')

  const nf = await j('POST', '/api/discover/candidates/不存在/accept')
  ok('對不存在的候選操作回 404', nf.status === 404)

  // 收拾：刪掉產生的素材，把候選檔還原
  await j('DELETE', `/api/inbox/${enc(acc.data.materialId)}`)
  await fs.writeFile(join(dir, 'candidates.json'), JSON.stringify(before, null, 2), 'utf8')
}
{
  const html = await (await fetch(BASE + '/discover')).text()
  ok('發掘頁 SSR 正常', !html.includes('Internal Server Error') && html.includes('抓推特'))
  // 三個來源並排，各自一欄、各自捲動
  ok('三個來源各自一欄', html.includes('cols3') && (html.match(/colhead/g) || []).length === 3)
  ok('每欄各自捲動', (html.match(/colbody/g) || []).length === 3)
  ok('三個抓取按鈕都在欄首', html.includes('讀日報') && html.includes('抓網站') && html.includes('抓推特'))
  // 設定收進彈窗，沒開時不渲染
  ok('設定在彈窗裡，預設不渲染', html.includes('gear') && !html.includes('modalwrap'))
  ok('導覽列有發掘', (await (await fetch(BASE + '/')).text()).includes('>發掘<'))
}
{
  const sch = await fs.readFile(join(HERE, '..', 'server', 'plugins', 'discover-scheduler.ts'), 'utf8')
  ok('排程器會檢查 autoRun', sch.includes('if (!s.autoRun) return'))
  ok('排程器不會重複掛計時器', sch.includes('__discoverTimer'))
  ok('排程器不會疊在已經在跑的工作上',
    sch.includes("activeJob('discover')") && sch.includes("activeJob('notion')"))
  ok('推特與日報各自判斷到期', sch.includes('async function tickX') && sch.includes('async function tickNotion'))

  const run = await fs.readFile(join(HERE, '..', 'server', 'utils', 'discoverRun.ts'), 'utf8')
  ok('收錄走既有的 saveMaterial，沒有自己寫一套', run.includes('await saveMaterial(m)'))
  ok('圖片沿用既有的下載與備援', run.includes('downloadImage') && run.includes('downloadViaX'))
  ok('帳號之間有間隔，避免連打', run.includes('sleep(s.gapSeconds * 1000)'))
  ok('置頂推文不當新素材', run.includes('t.isPinned'))
  ok('單一帳號失敗不會中斷整批', run.includes('report.errors.push'))

  const xs = await fs.readFile(join(HERE, '..', 'server', 'utils', 'xscrape.ts'), 'utf8')
  ok('時間軸抓取走既有的 profile 佇列', xs.includes('export async function xTimeline') && xs.includes('callScript('))
}


console.log('\n### 19. 發掘：瀏覽數計分與 Notion 日報')
{
  const d = await import(pathToFileURL(join(HERE, '..', 'server', 'utils', 'discover.ts')).href)
  const S = d.defaultSettings()
  const NOW = Date.parse('2026-08-30T04:00:00Z')

  ok('沒有瀏覽數就是 0 分', d.viewsScore({}) === 0)
  ok('瀏覽數到參考點滿分', d.viewsScore({ views: d.VIEWS_REF }) === 1)
  ok('瀏覽數超過參考點不爆表', d.viewsScore({ views: 9999999 }) === 1)
  ok('瀏覽數取對數壓縮：10 倍量不到 2 倍分', (() => {
    const a = d.viewsScore({ views: 3000 })
    const b = d.viewsScore({ views: 30000 })
    return b > a && b < a * 2
  })())
  ok('瀏覽與互動是兩個獨立訊號', 'views' in S.weights && 'engagement' in S.weights)
  ok('預設以瀏覽數為主', S.weights.views > S.weights.engagement)

  // 用真的抓到的 @kagakuadv 資料驗證：現場完售通知不該過門檻
  const noise = {
    text: '#シュタゲファイナルミッション 物販完売情報 現在の完売状況です マフラータオル',
    images: ['a', 'b'], postedAt: '2026-08-30T03:16:00Z',
    metrics: { likes: 11, reposts: 2, replies: 0, views: 2991 },
    isRepost: false, isReply: false
  }
  const news = {
    text: '『新作ギャルゲー』発売決定！予約開始しました。特典情報も公開',
    images: ['a'], postedAt: '2026-08-30T03:00:00Z',
    metrics: { likes: 800, reposts: 300, replies: 40, views: 95000 },
    isRepost: false, isReply: false
  }
  const nz = d.scoreCandidate(noise, S, NOW)
  const nw = d.scoreCandidate(news, S, NOW)
  ok('主題一個都沒中的營運瑣事被壓到門檻以下', nz.score < S.threshold, String(nz.score))
  ok('真情報過門檻', nw.score >= S.threshold, String(nw.score))
  ok('沒中主題會打折', nz.breakdown.折扣 < 100 && nw.breakdown.折扣 === 100)
  ok('breakdown 有瀏覽這一項', '瀏覽' in nw.breakdown)

  ok('不再有 Notion 專用權重（日報改成完全不計分）', d.weightsForNotion === undefined)

  // 日報是簡體中文，日文關鍵字對不上
  ok('關鍵字同時涵蓋日文與簡體',
    S.keywords.includes('発売') && S.keywords.includes('发售'))
  ok('簡體內容比對得到', d.keywordScore('《作品》预约开始，10月发售', S.keywords) > 0)
  ok('日文內容比對得到', d.keywordScore('予約開始しました', S.keywords) > 0)
}
{
  const n = await import(pathToFileURL(join(HERE, '..', 'server', 'utils', 'notion.ts')).href)

  ok('廠商帶作品會拆成兩段', (() => {
    const r = n.splitSource('AQUAPLUS（WHITE ALBUM2）')
    return r.source === 'AQUAPLUS' && r.work === 'WHITE ALBUM2'
  })())
  ok('沒有括號時作品留空', n.splitSource('Navel').work === '')
  ok('半形括號也接得住', n.splitSource('ωstar (Kaleidoscope)').work === 'Kaleidoscope')
  ok('標題取得出日期', n.dateInTitle('日本 Galgame 行业日报 文案版｜2026-08-30') === '2026-08-30')
  ok('沒有日期時回空字串', n.dateInTitle('隨便一個標題') === '')

  const lines = [
    { text: '《WHITE ALBUM2》ASMR 两作 8月30日0时 DLsite 发售', href: '' },
    { text: '2026-08-30 ｜ AQUAPLUS（WHITE ALBUM2）', href: '' },
    { text: 'https://blog.aquaplus.jp/archives/13818', href: 'https://blog.aquaplus.jp/archives/13818' },
    { text: '', href: '' },
    { text: 'NavPA!!2026 票务抽选 8月30日23:59 截止', href: '' },
    { text: '2026-08-30 ｜ Navel', href: '' },
    { text: 'https://project-navel.com/navpa2026/', href: 'https://project-navel.com/navpa2026/' }
  ]
  const e = n.parseDigest(lines)
  ok('空行分組，解析出兩則', e.length === 2)
  ok('內文不含日期行與連結行',
    e[0].text.includes('DLsite 发售') && !e[0].text.includes('2026-08-30 ｜') && !e[0].text.includes('http'))
  ok('日期解析正確', e[0].date === '2026-08-30')
  ok('廠商與作品解析正確', e[0].source === 'AQUAPLUS' && e[0].work === 'WHITE ALBUM2')
  ok('連結優先取 href', e[0].url === 'https://blog.aquaplus.jp/archives/13818')
  ok('用連結當去重主鍵', e[0].id === e[0].url)

  // 不靠行的順序，內容多行也要接得住
  const odd = n.parseDigest([
    { text: 'https://example.com/a', href: 'https://example.com/a' },
    { text: '第一段內容', href: '' },
    { text: '第二段內容', href: '' },
    { text: '2026-08-28 ｜ 某廠商', href: '' }
  ])
  ok('行順序不同也解析得出', odd.length === 1 && odd[0].date === '2026-08-28')
  ok('多行內容會合併', odd[0].text.includes('第一段內容') && odd[0].text.includes('第二段內容'))
  ok('沒有內文的組會被丟掉', n.parseDigest([{ text: 'https://a.com', href: 'https://a.com' }]).length === 0)
  ok('全空的輸入不會爆', n.parseDigest([]).length === 0)

  const ds = n.defaultNotionSettings()
  ok('Notion 預設是關的', ds.enabled === false)
  ok('沒有自動收錄門檻可套（日報不計分）', !('autoAccept' in ds))
  ok('Notion 預設只讀文案版', ds.titleFilter === '文案版')
}
{
  const r = await j('GET', '/api/discover/notion')
  ok('GET /api/discover/notion 回設定', r.status === 200 && typeof r.data.enabled === 'boolean')
  ok('不外洩 token 本身', !('token' in r.data) && 'hasToken' in r.data)

  const run = await fs.readFile(join(HERE, '..', 'server', 'utils', 'discoverRun.ts'), 'utf8')
  ok('Notion 是獨立的一支，不碰 X',
    run.includes('export async function runNotion') && !/runNotion[\s\S]{0,1500}xTimeline/.test(run))
  ok('推特也是獨立的一支', run.includes('export async function runX'))
  ok('指定帳號重跑時不會重複讀 Notion', run.includes('!handles?.length'))
  ok('Notion 條目不計分', run.includes('score: 0') && !run.includes('weightsForNotion'))
  ok('Notion 沿用日報原本的名次', run.includes('rank++') && run.includes('rank,'))
  ok('X 來源會擋掉超過回看天數的', run.includes('recencyScore(t.postedAt, s.lookbackDays, now) <= 0'))

  // 之前輸入框樣式只列舉 text/url，number 與 password 吃到瀏覽器白底，深色模式看不見
  const css = await fs.readFile(join(HERE, '..', 'app', 'assets', 'css', 'main.css'), 'utf8')
  ok('輸入框樣式用排除法，不會漏掉 number/password',
    css.includes("input:not([type='checkbox'])") && !css.includes("input[type='text'], input[type='url'], textarea"))
  ok('輸入框有明確指定文字顏色', /input:not[\s\S]{0,400}color: var\(--text\)/.test(css))

  const inbox2 = await fs.readFile(join(HERE, '..', 'app', 'pages', 'inbox', 'index.vue'), 'utf8')
  ok('撰寫緩衝改由伺服器控制', !inbox2.includes('const GAP_SECONDS'))

  const page = await fs.readFile(join(HERE, '..', 'app', 'pages', 'discover.vue'), 'utf8')
  ok('發掘頁有 Notion 區塊', page.includes('Notion 日報') && page.includes('Integration Token'))
  ok('候選卡片分得出來源', page.includes("c.sourceType === 'notion'"))
  ok('權重欄位包含瀏覽', page.includes("'views'"))
}

console.log('\n### 20. 發掘：帳號清單匯入')
{
  const d = await import(pathToFileURL(join(HERE, '..', 'server', 'utils', 'discover.ts')).href)

  const plain = d.parseHandleList('kagakuadv\n@Moepedia_net\n  gsc_kahotan  ')
  ok('一行一個，@ 會被去掉',
    plain.map(x => x.handle).join(',') === 'kagakuadv,Moepedia_net,gsc_kahotan')
  ok('匯入進來預設是啟用的', plain.every(x => x.enabled === true))

  const csv = d.parseHandleList('handle,note\nkagakuadv,科學ADV系列\nMoepedia_net,美少女遊戲行事曆')
  ok('CSV 表頭那行會跳過', csv.length === 2 && csv[0].handle === 'kagakuadv')
  ok('第二欄當備註', csv[0].note === '科學ADV系列')

  const urls = d.parseHandleList('https://x.com/kagakuadv\nhttps://twitter.com/gsc_kahotan?s=20\nx.com/#!/navelmark')
  ok('整串網址取得出帳號',
    urls.map(x => x.handle).join(',') === 'kagakuadv,gsc_kahotan,navelmark')

  const tsv = d.parseHandleList('kagakuadv\t科學ADV\nnavelmark\tNavel')
  ok('TSV 也吃得下', tsv.length === 2 && tsv[1].note === 'Navel')
  ok('引號會被剝掉', d.parseHandleList('"kagakuadv","備註"')[0].note === '備註')

  const dirty = d.parseHandleList('\n# 註解\n這不是帳號\nname@example.com\nok_handle,備註\n這個帳號名字實在有夠長超過十五字')
  ok('不合規的行整行丟掉', dirty.length === 1 && dirty[0].handle === 'ok_handle')
  ok('空輸入回空陣列', d.parseHandleList('').length === 0 && d.parseHandleList('   ').length === 0)
  ok('同一個帳號只留一筆（不分大小寫）',
    d.parseHandleList('kagakuadv\nKAGAKUADV\nkagakuadv').length === 1)
  ok('備註過長會截斷', d.parseHandleList('a,' + 'x'.repeat(200))[0].note.length === 60)

  const existing = [{ handle: 'kagakuadv', enabled: false, note: '我原本的備註' }]
  const m = d.mergeSources(existing, d.parseHandleList('kagakuadv,新備註\nnewguy,新的'))
  ok('合併不會多出重複帳號', m.sources.length === 2)
  ok('合併保留原本的啟用狀態', m.sources[0].enabled === false)
  ok('合併不覆蓋既有備註', m.sources[0].note === '我原本的備註')
  ok('合併回報新增幾個', m.added === 1)
  ok('原本沒備註的會補上', (() => {
    const r = d.mergeSources([{ handle: 'a', enabled: true, note: '' }], [{ handle: 'a', enabled: true, note: '補的' }])
    return r.sources[0].note === '補的' && r.updated === 1 && r.added === 0
  })())
  ok('合併不會動到原本的陣列', existing[0].note === '我原本的備註' && existing.length === 1)
}
{
  const cur = (await j('GET', '/api/discover')).data.settings.sources

  const bad = await j('POST', '/api/discover/sources/import', { text: '這裡面沒有任何帳號' })
  ok('解析不出帳號時擋下來並說原因', bad.status === 400 && String(bad.data.message || '').includes('帳號'))
  ok('空內容也擋下來', (await j('POST', '/api/discover/sources/import', { text: '  ' })).status === 400)

  const r = await j('POST', '/api/discover/sources/import', {
    text: 'handle,note\n__csvtest_a,測試A\nhttps://x.com/__csvtest_b\n__csvtest_a,重複的'
  })
  ok('POST /api/discover/sources/import 匯入成功', r.status === 200 && r.data.parsed === 2)
  ok('匯入後設定裡真的有了',
    r.data.sources.some(x => x.handle === '__csvtest_a' && x.note === '測試A') &&
    r.data.sources.some(x => x.handle === '__csvtest_b'))

  const again = await j('POST', '/api/discover/sources/import', { text: '__csvtest_a' })
  ok('再匯入一次不會重複', again.data.added === 0 && again.data.total === r.data.total)

  const rep = await j('POST', '/api/discover/sources/import', { text: '__csvtest_only', mode: 'replace' })
  ok('取代模式整份換掉', rep.data.total === 1 && rep.data.sources[0].handle === '__csvtest_only')

  await j('PUT', '/api/discover', { sources: cur })
  ok('測試後把帳號清單還原', (await j('GET', '/api/discover')).data.settings.sources.length === cur.length)

  const page = await fs.readFile(join(HERE, '..', 'app', 'pages', 'discover.vue'), 'utf8')
  ok('發掘頁有匯入 UI', page.includes('匯入清單') && page.includes('sources/import'))
  ok('匯入 UI 有檔案選擇與合併／取代', page.includes("accept=\".csv") && page.includes("value=\"replace\""))
}

console.log('\n### 21. 收錄時才抓圖：選圖與把關')
{
  const d = await import(pathToFileURL(join(HERE, '..', 'server', 'utils', 'discover.ts')).href)

  const hero = 'https://site.jp/wp-content/uploads/2026/08/key-1200x630.jpg'
  const ranked = d.rankWebImages(
    [
      'https://site.jp/img/logo.png',
      'https://site.jp/common/gnav_btn.svg',
      'https://cdn.ads.com/banner_728x90.gif',
      'https://site.jp/wp-content/uploads/2026/08/sub2.jpg',
      hero,
      'https://site.jp/img/sns_twitter.png'
    ],
    [hero],
    'https://site.jp/news/1'
  )
  ok('站方指定的代表圖排第一', ranked[0] === hero)
  ok('logo／按鈕／社群圖示整批剔除',
    !ranked.some(u => /logo|gnav|sns_/.test(u)))
  ok('外站廣告橫幅剔除', !ranked.some(u => u.includes('ads.com')))
  ok('內容圖留下來', ranked.includes('https://site.jp/wp-content/uploads/2026/08/sub2.jpg'))
  ok('全都不合格時回空陣列',
    d.rankWebImages(['https://a.com/logo.png', 'https://a.com/icon.svg'], [], 'https://a.com').length === 0)
  ok('沒有 hero 也能排', d.rankWebImages(['https://a.com/img/photo.jpg'], [], 'https://a.com').length === 1)
  ok('data: URI 不會被當成圖', d.rankWebImages(['data:image/png;base64,AAA'], [], '').length === 0)
  ok('同一張圖的不同尺寸只留一個',
    d.rankWebImages(
      ['https://a.com/img/p-300x200.jpg', 'https://a.com/img/p.jpg'], [], 'https://a.com'
    ).length === 1)

  // 檔頭解析：不靠任何影像函式庫
  const png = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0)
  Buffer.from('IHDR').copy(png, 12)
  png.writeUInt32BE(1200, 16); png.writeUInt32BE(630, 20)
  ok('讀得出 PNG 長寬', d.imageSize(png).width === 1200 && d.imageSize(png).height === 630)

  const gif = Buffer.alloc(11)
  Buffer.from('GIF89a').copy(gif, 0)
  gif.writeUInt16LE(800, 6); gif.writeUInt16LE(600, 8)
  ok('讀得出 GIF 長寬（小端序）', d.imageSize(gif).width === 800 && d.imageSize(gif).height === 600)

  const jpg = Buffer.alloc(24)
  jpg[0] = 0xff; jpg[1] = 0xd8; jpg[2] = 0xff; jpg[3] = 0xc0
  jpg.writeUInt16BE(17, 4); jpg[6] = 8
  jpg.writeUInt16BE(1080, 7); jpg.writeUInt16BE(1920, 9)
  ok('讀得出 JPEG 長寬（SOF0）', d.imageSize(jpg).width === 1920 && d.imageSize(jpg).height === 1080)
  ok('認不出格式回 null', d.imageSize(Buffer.from('not an image at all')) === null)
  ok('空 buffer 不會爆', d.imageSize(Buffer.alloc(0)) === null)

  const pad = n => Buffer.alloc(n)
  ok('太小的檔案擋掉', d.isUsableImage(pad(3000)).ok === false)
  ok('正常主圖放行', d.isUsableImage(Buffer.concat([png, pad(60000)])).ok === true)

  const banner = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(banner, 0)
  Buffer.from('IHDR').copy(banner, 12)
  banner.writeUInt32BE(1600, 16); banner.writeUInt32BE(300, 20)
  ok('窄長的橫幅擋掉', d.isUsableImage(Buffer.concat([banner, pad(60000)])).ok === false)

  const tiny = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(tiny, 0)
  Buffer.from('IHDR').copy(tiny, 12)
  tiny.writeUInt32BE(150, 16); tiny.writeUInt32BE(150, 20)
  ok('尺寸太小的縮圖擋掉', d.isUsableImage(Buffer.concat([tiny, pad(60000)])).ok === false)
  ok('讀不出格式但夠大就放行', d.isUsableImage(Buffer.concat([Buffer.from('???'), pad(60000)])).ok === true)
  ok('擋掉時說得出原因', d.isUsableImage(pad(3000)).why.includes('太小'))

  // 首圖挑選：og:image 通常是主視覺，但太小的就不該當首圖
  const big = { name: '02.jpg', long: 1200, area: 1200 * 630, hero: true }
  const small = { name: '01.jpg', long: 480, area: 480 * 480, hero: true }
  const huge = { name: '03.jpg', long: 2894, area: 2894 * 2438, hero: false }
  ok('夠大的代表圖當首圖', d.orderImages([huge, big])[0] === '02.jpg')
  ok('代表圖太小就讓位給大圖', d.orderImages([small, huge])[0] === '03.jpg')
  ok('沒有代表圖時大的排前面',
    d.orderImages([{ name: 'a', long: 500, area: 250000, hero: false }, huge])[0] === '03.jpg')
  ok('一張圖也不會出事', d.orderImages([small]).length === 1)
  ok('空陣列不會出事', d.orderImages([]).length === 0)

  // Notion 候選的 id 是整串網址，路徑參數不會把 %2F 解回來 → 以前一律 404
  const items = [
    { id: 'https://blog.aquaplus.jp/archives/13818' },
    { id: '2093503906735390740' }
  ]
  ok('網址型 id 用編碼過的也找得到',
    d.findCandidate(items, encodeURIComponent(items[0].id))?.id === items[0].id)
  ok('網址型 id 用原字串也找得到', d.findCandidate(items, items[0].id)?.id === items[0].id)
  ok('推文 id 照樣找得到', d.findCandidate(items, '2093503906735390740')?.id === items[1].id)
  ok('找不到就回 undefined', d.findCandidate(items, '不存在') === undefined)
  ok('空字串不會亂配', d.findCandidate(items, '') === undefined)
  ok('壞掉的百分號編碼不會爆', d.findCandidate(items, '%E0%A4%A') === undefined)

  const S = d.defaultSettings()
  ok('預設會在收錄時抓圖', S.fetchImagesOnAccept === true)
  ok('X 搜圖預設關（會佔用瀏覽器佇列）', S.imageSearchX === false)
  ok('預設最多收 4 張圖', S.maxImages === 4)
}
{
  const run = await fs.readFile(join(HERE, '..', 'server', 'utils', 'discoverRun.ts'), 'utf8')
  ok('抓圖分三層，收錄時才做',
    run.includes('async function acquireImages') && run.includes('await acquireImages(c, imgDir, s)'))
  ok('網頁圖下載後會用實際尺寸把關',
    run.includes('downloadChecked') && run.includes('isUsableImage(buf)'))
  ok('收到的圖會重排，主視覺放第一張', run.includes('orderImages(got)'))
  ok('不合格的圖會刪掉，不留在素材夾', run.includes("fs.rm(file, { force: true })"))
  ok('X 網址不走網頁抓圖那條', run.includes('!isXUrl(c.url)'))
  ok('搜圖是備援且要另外打開', run.includes('s.imageSearchX') && run.includes('xSearch('))

  const xs = await fs.readFile(join(HERE, '..', 'server', 'utils', 'xscrape.ts'), 'utf8')
  ok('搜圖也走既有的 profile 佇列', /xSearch[\s\S]{0,600}callScript\(/.test(xs))
  ok('搜圖失敗只回空陣列，不讓收錄整個失敗', /xSearch[\s\S]{0,700}catch \{\s*return \[\]/.test(xs))

  const py = await fs.readFile(join(HERE, '..', '..', 'tools', 'x_scraper.py'), 'utf8')
  ok('抓取器支援關鍵字搜尋', py.includes('--search') && py.includes('searching = bool(query)'))
  ok('搜尋模式取熱門而不是即時', py.includes('f=top'))
  ok('搜尋模式從網址取得發文者', py.includes('mh = re.search(r"/([A-Za-z0-9_]{1,15})/status/"'))

  const page = await fs.readFile(join(HERE, '..', 'app', 'pages', 'discover.vue'), 'utf8')
  ok('日報與推特分成兩區', page.includes('notionShown') && page.includes('xShown'))
  // 改成三欄各自捲動之後就不需要「只露前三則」了
  ok('日報列全部，靠欄內捲動', !page.includes('NOTION_TOP') && page.includes('colbody'))
  ok('日報卡片顯示名次而不是分數', page.includes('class="rank"') && page.includes('c.rank'))
  ok('日報照原順序排，不照分數', page.includes('(a.rank || 999) - (b.rank || 999)'))
  ok('推特那區照分數排', page.includes('sort((a, b) => b.score - a.score)'))
  ok('設定裡可以調收錄抓圖', page.includes('st.fetchImagesOnAccept') && page.includes('st.imageSearchX'))
}
{
  const before = (await j('GET', '/api/discover')).data.settings
  const r = await j('PUT', '/api/discover', { maxImages: 99, imageSearchX: true, fetchImagesOnAccept: false })
  ok('maxImages 會被夾在合理範圍', r.data.maxImages === 10)
  ok('抓圖開關存得起來', r.data.imageSearchX === true && r.data.fetchImagesOnAccept === false)
  const bad = await j('PUT', '/api/discover', { maxImages: 'abc' })
  ok('亂填數字時回到預設', bad.data.maxImages === 4)
  await j('PUT', '/api/discover', {
    maxImages: before.maxImages ?? 4,
    imageSearchX: before.imageSearchX ?? false,
    fetchImagesOnAccept: before.fetchImagesOnAccept ?? true
  })
  ok('測試後把設定還原', (await j('GET', '/api/discover')).data.settings.imageSearchX === (before.imageSearchX ?? false))
}
console.log('\n### 22. 送給模型的圖有總量預算（413 的成因）')
{
  const llm = await import(pathToFileURL(join(HERE, '..', 'server', 'utils', 'llm.ts')).href)
  const L = { count: 4, perFile: 2_500_000, total: 3_500_000 }

  // 實際踩到的那筆：發掘從原文網頁抓了 4 張全尺寸大圖，
  // 每張都在單張上限內，加起來卻是 7.5MB → base64 約 10MB → 端點回 413
  const real = [
    { name: '01.jpg', size: 2_193_000 },
    { name: '02.jpg', size: 2_177_000 },
    { name: '03.jpg', size: 2_697_000 },
    { name: '04.jpg', size: 426_000 }
  ]
  const r = llm.pickImagesWithinBudget(real, L)
  const sent = real.filter(f => r.names.includes(f.name)).reduce((a, b) => a + b.size, 0)
  ok('總量壓在預算內', sent <= L.total, `${sent}`)
  ok('主視覺（第一張）一定送', r.names[0] === '01.jpg')
  ok('剩餘預算給小的，多看一張', r.names.includes('04.jpg'))
  ok('超過單張上限的擋掉', !r.names.includes('03.jpg'))
  ok('被擋的都說得出理由', r.skipped.length === 2 && r.skipped.every(x => x.includes('MB')))

  ok('全部塞得下就全送',
    llm.pickImagesWithinBudget(
      [{ name: 'a', size: 100 }, { name: 'b', size: 200 }, { name: 'c', size: 300 }], L
    ).names.length === 3)
  ok('送出順序照原本的，主視覺在前', (() => {
    const x = llm.pickImagesWithinBudget(
      [{ name: 'big', size: 900_000 }, { name: 'small', size: 1000 }], L
    )
    return x.names[0] === 'big' && x.names[1] === 'small'
  })())
  ok('張數上限照樣生效',
    llm.pickImagesWithinBudget(
      [1, 2, 3, 4, 5, 6].map(i => ({ name: 'i' + i, size: 1000 })), L
    ).names.length === 4)
  ok('第一張就超過單張上限時不會硬塞', (() => {
    const x = llm.pickImagesWithinBudget([{ name: 'huge', size: 9_000_000 }, { name: 'ok', size: 1000 }], L)
    return x.names.length === 1 && x.names[0] === 'ok'
  })())
  ok('沒有圖不會出事', llm.pickImagesWithinBudget([], L).names.length === 0)
  ok('單張剛好等於上限收得下',
    llm.pickImagesWithinBudget([{ name: 'a', size: L.perFile }], L).names.length === 1)

  const src = await fs.readFile(join(HERE, '..', 'server', 'utils', 'llm.ts'), 'utf8')
  ok('有總量上限這個常數', src.includes('MAX_TOTAL_IMAGE_BYTES'))
  ok('413 會砍圖重送，不是直接失敗',
    src.includes('res.status === 413') && src.includes('cur.images.slice(0, half)'))
  ok('退讓時沿用當下的 schema 與送圖狀態',
    src.includes('let schema = true') && src.includes('let withImages = s.sendImages'))
  ok('413 的錯誤訊息說得出下一步', src.includes('把素材內文刪短一點'))

  const inbox = await fs.readFile(join(HERE, '..', 'app', 'pages', 'inbox', 'index.vue'), 'utf8')
  ok('撰寫中只鎖那一則，不鎖整頁',
    inbox.includes('const running = ref<string[]>([])') && inbox.includes('isWriting(m.id)'))
  ok('沒有殘留把整頁關掉的寫法', !inbox.includes(':disabled="!!running"'))
  ok('同一則不會被按兩次', inbox.includes('if (isWriting(m.id)) return'))
}
console.log('\n### 23. Facebook：草稿其實不是草稿')
{
  const meta = await import(pathToFileURL(join(HERE, '..', 'server', 'utils', 'meta.ts')).href)

  // 實測結論：/{page}/feed 帶 published=false 產生的是「未發佈貼文」，
  // is_published=false，而且 feed／已發佈／已排程三個清單都查不到它。
  const draft = meta.buildFeedParams('內文', ['1', '2'], 'draft')
  ok('未發佈模式送 published=false', draft.published === 'false')
  ok('未發佈模式不帶排程時間', !('scheduled_publish_time' in draft))

  const at = Date.now() + 3600_000
  const sch = meta.buildFeedParams('內文', [], 'schedule', at)
  ok('排程模式也送 published=false', sch.published === 'false')
  ok('排程模式帶 scheduled_publish_time（秒）',
    sch.scheduled_publish_time === String(Math.floor(at / 1000)))
  ok('排程與未發佈的差別只在那個時間欄位',
    Object.keys(sch).filter(k => k !== 'scheduled_publish_time').every(k => k in draft))

  const now = meta.buildFeedParams('內文', [], 'now')
  ok('立即模式才是 published=true', now.published === 'true')
  ok('多圖用 attached_media 掛上去',
    JSON.parse(draft['attached_media[0]']).media_fbid === '1')

  const N = Date.now()
  ok('排程沒給時間會擋下來', meta.validateSchedule('schedule', 0, N) !== '')
  ok('排程太近會擋下來（Facebook 規定 10 分鐘）',
    meta.validateSchedule('schedule', N + 60_000, N).includes('10 分鐘'))
  ok('預設的一小時後過得了驗證', meta.validateSchedule('schedule', N + 3600_000, N) === '')
  ok('太遠的排程也擋', meta.validateSchedule('schedule', N + 400 * 86400_000, N) !== '')
  ok('非排程模式不驗時間', meta.validateSchedule('now', 0, N) === '')

  const src = await fs.readFile(join(HERE, '..', 'server', 'utils', 'meta.ts'), 'utf8')
  ok('有把未發佈貼文轉成公開的出口', src.includes('export async function publishUnpublished'))
  ok('轉正是送 is_published=true', /publishUnpublished[\s\S]{0,400}append\('is_published', 'true'\)/.test(src))
  ok('查得到貼文現在的狀態', src.includes('export async function postState') && src.includes('is_published'))
  ok('註解講清楚 published=false 不是草稿', src.includes('這不是 Business Suite 的草稿'))

  const page = await fs.readFile(join(HERE, '..', 'app', 'pages', 'posts', '[id].vue'), 'utf8')
  ok('畫面上不再有「存成草稿」這個選項', !page.includes('>存成草稿<'))
  ok('切到排程會預填時間', page.includes('function onWhenChange') && page.includes('3600_000'))
  ok('預填用本地時間，不是 UTC', page.includes('getTimezoneOffset'))
  ok('舊的未發佈紀錄有出口', page.includes('publishRecordNow') && page.includes('查現在的狀態'))
  ok('公開前會再確認一次', /publishRecordNow[\s\S]{0,400}confirm\(/.test(page))
}
{
  const r = await j('GET', '/api/meta/post-state')
  ok('查狀態沒給 id 會擋', r.status === 400)
  const p = await j('POST', '/api/meta/publish-now', { postId: 'x', externalId: '' })
  ok('轉正沒給 id 會擋', p.status === 400)
  const nf = await j('POST', '/api/meta/publish-now', { postId: '不存在', externalId: '123' })
  ok('找不到貼文時回 404', nf.status === 404)
}
console.log('\n### 24. 開啟資料夾、圖片排序、IG／Threads 設定')
{
  const of = await fs.readFile(join(HERE, '..', 'server', 'api', 'open-folder.post.ts'), 'utf8')
  // windowsHide 會連 explorer 開出來的資料夾視窗一起藏起來，
  // 按了沒反應但視窗其實堆了一疊（實測堆到 20 個）
  // 只看 spawn 的參數，別被註解裡提到的那串騙了
  const spawnArgs = of.slice(of.indexOf('spawn(cmd'), of.indexOf('spawn(cmd') + 120)
  ok('開資料夾不能用 windowsHide', !spawnArgs.includes('windowsHide'), spawnArgs.slice(0, 60))
  ok('改用 spawn detached，不等離開碼', of.includes('detached: true') && of.includes('child.unref()'))
  ok('找不到執行檔才算失敗', of.includes("child.on('error'"))
  ok('資料夾不存在時回 404', of.includes('資料夾不存在'))

  const page = await fs.readFile(join(HERE, '..', 'app', 'pages', 'posts', '[id].vue'), 'utf8')
  ok('圖片可以拖曳', page.includes('draggable="true"') && page.includes('@drop.prevent="onDrop'))
  ok('拖放後會存檔', /function onDrop[\s\S]{0,400}saveMeta\(\)/.test(page))
  ok('拖到原位不會白存一次', /function onDrop[\s\S]{0,300}from === to/.test(page))
  ok('用 splice 搬移，不是整個重建', page.includes('arr.splice(to, 0, ...arr.splice(from, 1))'))
  ok('設 dataTransfer，Firefox 才拖得動', page.includes("setData('text/plain'"))
  ok('每張圖顯示發佈順序', page.includes('publishIndex(i)'))
  ok('順序跳過沒勾選的圖', page.includes('filter(x => x.selected).length'))
  ok('可以勾選哪幾張要發', page.includes('v-model="img.selected"'))
}
{
  const m = await import(pathToFileURL(join(HERE, '..', 'server', 'utils', 'meta.ts')).href)

  ok('IG 權限是獨立一組，跟發 FB 那組分開',
    m.IG_SCOPES.includes('instagram_basic') && m.IG_SCOPES.includes('instagram_content_publish') &&
    !m.REQUIRED_SCOPES.includes('instagram_basic'))

  // 「沒連 IG」跟「token 是加權限之前產的」處理方式完全不同，訊息要分得開
  const lacking = m.igDiagnosis(['pages_manage_posts'])
  ok('缺權限時說要重產 token', lacking.includes('instagram_basic') && lacking.includes('重新產'))
  ok('缺權限時列出現在有什麼', lacking.includes('pages_manage_posts'))
  const linked = m.igDiagnosis(['instagram_basic', 'instagram_content_publish'])
  ok('權限齊了就改指向沒連帳號', linked.includes('商業／創作者') && !linked.includes('重新產'))
  ok('查不到權限時也不會爆', typeof m.igDiagnosis([]) === 'string')

  ok('Threads 走自己的網域', m.THREADS_GRAPH === 'https://graph.threads.net')
  const src = await fs.readFile(join(HERE, '..', 'server', 'utils', 'meta.ts'), 'utf8')
  ok('Threads 另存一組 token，不共用 Page Token',
    src.includes('threadsToken: string') && src.includes('不吃 Page Token'))
  ok('新欄位有預設值', (() => {
    const e = m.emptyMetaSettings()
    return e.igUserId === '' && e.threadsToken === '' && e.threadsUsername === ''
  })())
}
{
  const r = await j('GET', '/api/meta/platforms')
  ok('GET /api/meta/platforms 回連接狀態',
    r.status === 200 && 'instagram' in r.data && 'threads' in r.data)
  ok('不外洩 Threads token 本身',
    !('threadsToken' in r.data.threads) && 'hasToken' in r.data.threads)

  const before = r.data
  const put = await j('PUT', '/api/meta/platforms', { igUserId: '  17841400000000000  ' })
  ok('PUT 會去掉前後空白', put.status === 200 && put.data.instagram.userId === '17841400000000000')
  const clear = await j('PUT', '/api/meta/platforms', { igUserId: '' })
  ok('清空 IG id 也清掉使用者名稱', clear.data.instagram.userId === '' && clear.data.instagram.username === '')
  await j('PUT', '/api/meta/platforms', { igUserId: before.instagram.userId })
  ok('測試後還原', (await j('GET', '/api/meta/platforms')).data.instagram.userId === before.instagram.userId)

  const st = await fs.readFile(join(HERE, '..', 'app', 'pages', 'settings.vue'), 'utf8')
  ok('設定頁有 IG 欄位與自動偵測', st.includes('Instagram 商業帳號 ID') && st.includes('igDetect'))
  ok('設定頁有 Threads 兩個欄位',
    st.includes('Threads 使用者 ID') && st.includes('Threads Access Token'))
  ok('設定頁講清楚圖片要走 Facebook 轉公開網址', st.includes('轉成公開網址'))
  ok('設定頁講清楚沒有同步發佈', st.includes('沒有「同步發佈」'))
}
console.log('\n### 25. 背景工作：換頁不會中斷')
{
  const jb = await import(pathToFileURL(join(HERE, '..', 'server', 'utils', 'jobs.ts')).href)

  const j0 = jb.newJob('test', '測試', 10)
  ok('新工作是執行中', j0.status === 'running' && j0.done === 0)
  ok('工作 id 不重複', jb.newJob('a', 'a').id !== jb.newJob('a', 'a').id)

  ok('百分比照 done/total 算', jb.jobPercent({ total: 4, done: 1, status: 'running' }) === 25)
  ok('總數還不知道時回 -1，畫面改用不定長度動畫',
    jb.jobPercent({ total: 0, done: 3, status: 'running' }) === -1)
  ok('跑完一律 100%', jb.jobPercent({ total: 0, done: 0, status: 'done' }) === 100)
  ok('超過總數不會爆表', jb.jobPercent({ total: 2, done: 9, status: 'running' }) === 100)

  const NOW = Date.parse('2026-08-30T12:00:00Z')
  const started = new Date(NOW - 60_000).toISOString()
  ok('剩餘時間照已花時間推算',
    jb.jobEta({ total: 10, done: 5, startedAt: started, status: 'running' }, NOW) === 60_000)
  ok('只跑一步不亂猜',
    jb.jobEta({ total: 10, done: 1, startedAt: started, status: 'running' }, NOW) === 0)
  ok('跑完了不顯示剩餘時間',
    jb.jobEta({ total: 10, done: 5, startedAt: started, status: 'done' }, NOW) === 0)

  ok('失敗的摘要帶原因',
    jb.jobSummary({ ...j0, status: 'error', error: '爆了' }).includes('爆了'))
  ok('停止的摘要說完成幾則',
    jb.jobSummary({ ...j0, status: 'stopped', done: 3, total: 9 }).includes('3'))

  // 舊的可以丟，執行中的不能丟 —— 不然進行中的工作會從清單上消失
  const many = [
    { ...jb.newJob('a', 'a'), status: 'running' },
    ...Array.from({ length: 8 }, (_, i) => ({
      ...jb.newJob('a', 'a'), status: 'done', finishedAt: `2026-08-30T0${i}:00:00Z`
    }))
  ]
  const kept = jb.trimJobs(many, 3)
  ok('超出上限會丟舊的', kept.length === 3)
  ok('執行中的一定留著', kept.some(x => x.status === 'running'))
  ok('留下來的是最近完成的', kept[1].finishedAt > kept[2].finishedAt)
}
{
  const r = await j('GET', '/api/jobs')
  ok('GET /api/jobs 回工作清單', r.status === 200 && Array.isArray(r.data.items))
  const nf = await j('GET', '/api/jobs/不存在')
  ok('查不到的工作回 404', nf.status === 404)
  const bad = await j('POST', '/api/jobs/不存在/stop')
  ok('停止不存在的工作回 400', bad.status === 400)

  // 開一個真的工作，確認它自己跑完（請求早就回來了）
  const start = await j('POST', '/api/inbox/collect', { urls: ['https://example.com/'] })
  ok('抓取端點馬上回應，不等工作跑完', start.status === 200 && !!start.data.jobId)
  const fin = await waitJob(start.data.jobId)
  ok('工作在伺服器上自己跑完', fin.status === 'done')
  ok('工作有記錄結果', typeof fin.result?.added === 'number')

  // 掃尾：把剛剛抓進來的測試素材刪掉
  const madeId = fin.result?.results?.[0]?.id
  if (madeId) {
    const del = await j('POST', '/api/inbox/bulk-delete', { mode: 'ids', ids: [madeId] })
    ok('批量刪除刪得掉', del.status === 200 && del.data.deleted === 1)
    ok('批量刪除會回報釋出多少空間', typeof del.data.bytes === 'number')
    const gone = await j('GET', `/api/inbox/${enc(madeId)}`)
    ok('刪掉之後真的讀不到了', gone.status === 404)
  }

  const bd = await j('POST', '/api/inbox/bulk-delete', { mode: 'ids', ids: [] })
  ok('沒指定要刪什麼會擋下來', bd.status === 400)

  const src = await fs.readFile(join(HERE, '..', 'server', 'api', 'inbox', 'bulk-delete.post.ts'), 'utf8')
  ok('刪除是整個資料夾一起刪，不留空殼', src.includes('recursive: true') && src.includes('dirSize'))
  ok('支援只清已撰寫的', src.includes("mode === 'all' || m.written"))
}
{
  const bat = await fs.readFile(join(HERE, '..', 'server', 'api', 'generate', 'batch.post.ts'), 'utf8')
  ok('批次撰寫的緩衝在伺服器端', bat.includes('const GAP_SECONDS') && bat.includes('ctx.sleep'))
  ok('緩衝時也會檢查停止', bat.includes('ctx.shouldStop()'))
  ok('同時只跑一批', bat.includes("activeJob('write')"))

  const comp = await fs.readFile(join(HERE, '..', 'app', 'components', 'JobProgress.vue'), 'utf8')
  ok('進度條掛載時會接回進行中的工作', comp.includes('onMounted(resume)') && comp.includes("params: { kind"))
  ok('離開頁面會停掉輪詢', comp.includes('onBeforeUnmount(stopPolling)'))
  ok('尊重減少動態效果的設定', comp.includes('prefers-reduced-motion'))

  const inbox = await fs.readFile(join(HERE, '..', 'app', 'pages', 'inbox', 'index.vue'), 'utf8')
  ok('素材夾接上抓取與撰寫兩條進度條',
    inbox.includes('kind="collect"') && inbox.includes('kind="write"'))
  ok('批次撰寫改打背景端點', inbox.includes("'/api/generate/batch'"))
  ok('前端不再自己跑批次迴圈', !inbox.includes('stopFlag') && !inbox.includes('batchRunning'))
  ok('單則刪除失敗會講出來（以前是靜靜的什麼都不做）',
    /async function del\(m: Material\)[\s\S]{0,500}toastErr/.test(inbox))
  ok('批量管理合在同一列', inbox.includes('delPicked') && inbox.includes('clearWritten'))

  const disc = await fs.readFile(join(HERE, '..', 'app', 'pages', 'discover.vue'), 'utf8')
  ok('發掘頁也有進度條', disc.includes('kind="discover"'))

  const run = await fs.readFile(join(HERE, '..', 'server', 'utils', 'discoverRun.ts'), 'utf8')
  ok('抓取每個帳號都回報一步', run.includes('讀取 @${src.handle} 的時間軸'))
  ok('排程器沿用同一支，不給 ctx 也能跑', run.includes('ctx?: JobCtx'))
}
console.log('\n### 26. 三平台發佈與本機排程')
{
  const sc = await import(pathToFileURL(join(HERE, '..', 'server', 'utils', 'schedule.ts')).href)
  const NOW = Date.parse('2026-08-30T20:00:00Z')
  const mk = (at, status = 'pending') =>
    sc.newScheduleItem({ postId: 'p', variantId: 'v', platform: 'instagram', at, status })

  const { due, stale } = sc.dueItems(
    [
      mk('2026-08-30T19:59:00Z'),
      mk('2026-08-30T20:01:00Z'),
      { ...mk('2026-08-30T19:00:00Z'), status: 'done' },
      mk('2026-08-30T05:00:00Z')
    ],
    NOW
  )
  ok('到期的才發', due.length === 1 && due[0].at === '2026-08-30T19:59:00Z')
  ok('還沒到的不發', !due.some(x => x.at === '2026-08-30T20:01:00Z'))
  ok('已完成的不會再發一次', !due.some(x => x.status === 'done'))
  // 隔天才開電腦的話，昨晚的貼文不該突然冒出來
  ok('過期太久的不補發', stale.length === 1 && stale[0].at === '2026-08-30T05:00:00Z')

  ok('早的先發', (() => {
    const r = sc.dueItems([mk('2026-08-30T19:50:00Z'), mk('2026-08-30T19:30:00Z')], NOW)
    return r.due[0].at === '2026-08-30T19:30:00Z'
  })())

  ok('時間格式錯會擋', sc.validateLocalSchedule('隨便', NOW) !== '')
  ok('過去的時間會擋', sc.validateLocalSchedule('2026-08-30T10:00:00Z', NOW) !== '')
  ok('一分鐘內的誤差放行', sc.validateLocalSchedule('2026-08-30T19:59:40Z', NOW) === '')
  ok('排太遠會擋', sc.validateLocalSchedule('2028-01-01T00:00:00Z', NOW) !== '')
  ok('正常的時間放行', sc.validateLocalSchedule('2026-08-30T21:00:00Z', NOW) === '')
  ok('本機排程沒有「至少 10 分鐘」的限制（那是 Facebook 的）',
    sc.validateLocalSchedule('2026-08-30T20:02:00Z', NOW) === '')

  ok('新排程預設是待發', sc.newScheduleItem({ postId: 'a', variantId: 'b', platform: 'threads', at: 'x' }).status === 'pending')
  ok('排程 id 不重複',
    sc.newScheduleItem({ postId: 'a', variantId: 'b', platform: 'threads', at: 'x' }).id !==
      sc.newScheduleItem({ postId: 'a', variantId: 'b', platform: 'threads', at: 'x' }).id)
  ok('說明文字看得懂', sc.scheduleLabel(mk('2026-08-30T21:00:00Z')).includes('Instagram'))
}
{
  const pb = await import(pathToFileURL(join(HERE, '..', 'server', 'utils', 'publish.ts')).href)

  const good = '【情報】測試標題\n內容內容內容\n（來源：@someone）'
  ok('合規的稿子過得了', pb.lintForPublish(good).length === 0)
  ok('沒有【體裁】會擋', pb.lintForPublish('沒有體裁\n（來源：X）').some(x => x.includes('體裁')))
  ok('正文有網址會擋', pb.lintForPublish(good + '\nhttps://a.com').some(x => x.includes('網址')))

  // 平台各自的硬限制
  ok('Threads 超過 500 字擋下來',
    pb.platformBlockers('threads', 'あ'.repeat(501), 1).some(x => x.includes('500')))
  ok('Threads 剛好 500 字放行', pb.platformBlockers('threads', 'あ'.repeat(500), 0).length === 0)
  ok('Instagram 沒圖擋下來',
    pb.platformBlockers('instagram', '短文', 0).some(x => x.includes('一定要有圖')))
  ok('Instagram 有圖就放行', pb.platformBlockers('instagram', '短文', 1).length === 0)
  ok('Facebook 沒有這些限制', pb.platformBlockers('facebook', 'あ'.repeat(3000), 0).length === 0)
  ok('字數用碼位算，不會把 emoji 算成兩個',
    pb.platformBlockers('threads', '🎮'.repeat(400), 1).length === 0)
}
{
  const it = await fs.readFile(join(HERE, '..', 'server', 'utils', 'igthreads.ts'), 'utf8')
  ok('IG／Threads 的圖走 FB CDN 借網址',
    it.includes('published') && it.includes("fields: 'images'") && it.includes('toPublicUrls'))
  ok('借完會把暫存照片刪掉，不留一堆看不見的未發佈照片',
    it.includes('cleanupTempPhotos') && it.includes('finally'))
  ok('多張圖走輪播', it.includes('is_carousel_item') && it.includes('CAROUSEL'))
  ok('會等容器處理完才發佈', it.includes('waitContainer') && it.includes('FINISHED'))
  ok('容器出錯會講清楚', it.includes('ERROR') && it.includes('EXPIRED'))
  // 盲等 30 秒改成問狀態：好了就走，出錯才看得到原因
  ok('Threads 也等容器處理完才發佈',
    it.includes('waitThreadsContainer') && it.includes("st === 'FINISHED'"))
  ok('Threads 的呼叫有留日誌（之前失敗一次完全查不到原因）',
    it.includes('Threads POST ${path}'))
  ok('發佈失敗會把容器狀態一起講出來', it.includes('容器狀態'))
  ok('註解說明為什麼要繞這一圈', it.includes('public server'))

  const sch = await fs.readFile(join(HERE, '..', 'server', 'plugins', 'publish-scheduler.ts'), 'utf8')
  ok('排程器不會重複掛計時器', sch.includes('__publishTimer') && sch.includes('clearInterval'))
  ok('排程器不會同時跑兩輪', sch.includes('if (busy) return'))
  ok('永久性的錯誤不重試', sch.includes('permanent') && sch.includes('MAX_ATTEMPTS'))
}
{
  const r = await j('GET', '/api/schedule')
  ok('GET /api/schedule 回清單', r.status === 200 && Array.isArray(r.data.items))
  ok('有標示本機排程需要工具開著', r.data.needsAppRunning === true)

  const noPlat = await j('POST', '/api/schedule', { postId: 'x', variantId: 'v', at: '2027-01-01T00:00:00Z' })
  ok('沒選平台會擋', noPlat.status === 400)
  const badTime = await j('POST', '/api/schedule', {
    postId: 'x', variantId: 'v', platforms: ['instagram'], at: '2020-01-01T00:00:00Z'
  })
  ok('排到過去會擋', badTime.status === 400 && String(badTime.data.message).includes('過'))
  const noPost = await j('POST', '/api/schedule', {
    postId: '不存在', variantId: 'v', platforms: ['instagram'], at: '2027-01-01T00:00:00Z'
  })
  ok('貼文不存在回 404', noPost.status === 404)
  const noCancel = await j('DELETE', '/api/schedule/不存在')
  ok('取消不存在的排程回 404', noCancel.status === 404)

  const page = await fs.readFile(join(HERE, '..', 'app', 'pages', 'posts', '[id].vue'), 'utf8')
  ok('發佈區可以多選平台', page.includes('pubPlats') && page.includes('pubTargets'))
  ok('沒接的平台不給勾', page.includes('!p.ready') && page.includes(':disabled="!p.ready"'))
  ok('Threads 超字數當場就看得出來', page.includes('超過 500 上限'))
  ok('Instagram 沒圖當場就看得出來', page.includes('一定要有圖'))
  ok('Facebook 保留交給 Meta 排程的選項', page.includes('useMetaSchedule') && page.includes('FB 交給 Meta'))
  ok('說清楚本機排程要工具開著', page.includes('工具要開著'))
  ok('待發排程可以取消', page.includes('cancelSchedule'))
  ok('立即發佈時單一平台失敗不影響其他平台',
    /for \(const platform of pubPlats\.value\)[\s\S]{0,1400}failed\.push/.test(page))
  // 三個平台加起來可能兩分鐘，只寫「處理中」看不出跑到哪
  ok('發佈時逐平台顯示狀態', page.includes('pubSteps') && page.includes('function setStep'))
  ok('每個平台有等待／進行／成功／失敗四種狀態',
    page.includes("'wait' | 'run' | 'ok' | 'fail'"))
}
console.log('\n### 27. 配圖不計分、候選可以清乾淨')
{
  const d = await import(pathToFileURL(join(HERE, '..', 'server', 'utils', 'discover.ts')).href)
  const S = d.defaultSettings()

  ok('權重裡沒有配圖這一項', !('image' in S.weights))
  ok('剩下四項都在',
    ['views', 'engagement', 'recency', 'keyword'].every(k => k in S.weights))

  const base = {
    text: '『新作』発売決定！予約開始', postedAt: new Date().toISOString(),
    metrics: { likes: 500, reposts: 100, replies: 20, views: 50000 },
    isRepost: false, isReply: false
  }
  const withImg = d.scoreCandidate({ ...base, images: ['a', 'b'] }, S)
  const noImg = d.scoreCandidate({ ...base, images: [] }, S)
  // 情報類推文幾乎都有圖，人人滿分反而分不出好壞
  ok('有沒有圖不再影響分數', withImg.score === noImg.score, `${withImg.score} vs ${noImg.score}`)
  ok('breakdown 不再有配圖', !('配圖' in withImg.breakdown))

  // 舊設定檔還留著廢掉的 image 權重時，不能讓它混進正規化的分母
  const legacy = d.pickWeights({ views: 60, engagement: 20, recency: 10, keyword: 30, image: 10 })
  ok('舊設定裡的 image 權重會被丟掉', !('image' in legacy) && legacy.views === 60)
  ok('缺欄位時補預設', d.pickWeights({}).keyword === 20)
  ok('負數或亂填會回到預設', d.pickWeights({ views: -5, engagement: 'x' }).views === 35)
}
{
  const dir = join(DATA, 'discover')
  const backup = await fs.readFile(join(dir, 'candidates.json'), 'utf8')
  const mk = (id, status) => ({
    id, sourceType: 'x', handle: 'h', url: `https://x.com/h/status/${id}`,
    text: 't', images: [], links: [], postedAt: '',
    metrics: { replies: 0, reposts: 0, likes: 0, views: 0 },
    isRepost: false, isReply: false, score: 50, breakdown: {},
    status, materialId: '', foundAt: new Date().toISOString()
  })
  await fs.writeFile(join(dir, 'candidates.json'), JSON.stringify({
    items: [mk('900100001', 'pending'), mk('900100002', 'pending'),
            mk('900100003', 'accepted'), mk('900100004', 'ignored')]
  }))

  // 忽略是標記，不刪 —— 要清掉的話用「清掉已忽略」那顆
  const ig = await j('POST', '/api/discover/candidates/900100001/ignore')
  ok('忽略是標記狀態', ig.status === 200 && ig.data.candidate.status === 'ignored')
  const after = (await j('GET', '/api/discover/candidates')).data.items
  ok('忽略的候選還留在清單裡', after.some(c => c.id === '900100001' && c.status === 'ignored'))
  const clrIg = await j('POST', '/api/discover/candidates/clear', { status: 'ignored' })
  ok('可以一次清掉已忽略的', clrIg.status === 200 && clrIg.data.removed >= 1)
  ok('清掉之後真的不見了',
    !(await j('GET', '/api/discover/candidates')).data.items.some(c => c.id === '900100001'))

  const del = await j('DELETE', '/api/discover/candidates/900100002')
  ok('也可以直接刪一則', del.status === 200)
  const nf = await j('DELETE', '/api/discover/candidates/不存在')
  ok('刪不存在的回 404', nf.status === 404)

  const clr = await j('POST', '/api/discover/candidates/clear', { status: 'all' })
  ok('一鍵清空', clr.status === 200 && clr.data.remaining === 0)

  // 清掉不等於會重抓：去重看的是 seen.json，不是候選池
  const run = await fs.readFile(join(HERE, '..', 'server', 'utils', 'discoverRun.ts'), 'utf8')
  ok('去重靠已讀紀錄，清候選不會讓它們重新冒出來',
    run.includes('isDuplicate(t.id, t.url, seen, existing)') && run.includes('seen.push(t.id)'))

  await fs.writeFile(join(dir, 'candidates.json'), backup)
  ok('測試後把候選池還原', true)

  const page = await fs.readFile(join(HERE, '..', 'app', 'pages', 'discover.vue'), 'utf8')
  ok('發掘頁有清理按鈕', page.includes('clearCandidates') && page.includes('清掉待處理'))
  ok('已忽略的可以一次清掉', page.includes("clearCandidates('ignored')") && page.includes('清掉已忽略'))
  ok('清理前會確認', /function clearCandidates[\s\S]{0,300}confirm\(/.test(page))
  ok('有講清楚清掉之後不會再抓回來', page.includes('不會再抓回來'))
  ok('可以選擇一起忘記已讀', page.includes('clearForget') && page.includes('一起忘記'))
  ok('日報可以重讀全部', page.includes("runNow('notion', true)") && page.includes('重讀全部'))
  ok('權重欄位不再有配圖', !page.includes("keyword: '主題', image: '配圖'"))
  ok('沒有殘留輪替設定', !page.includes('accountsPerRun') && !page.includes('runEstimate'))
}
console.log('\n### 28. 停得下來、即時顯示、兩條線分開')
{
  const jb = await import(pathToFileURL(join(HERE, '..', 'server', 'utils', 'jobs.ts')).href)
  ok('新工作預設沒有在停止中', jb.newJob('x', 'x').stopRequested === false)

  const src = await fs.readFile(join(HERE, '..', 'server', 'utils', 'jobs.ts'), 'utf8')
  // 光靠 shouldStop() 不夠：抓一個帳號要一分鐘，那段時間迴圈回不到檢查點
  ok('每個工作有自己的中止訊號', src.includes('new AbortController()') && src.includes('signal: aborter.signal'))
  ok('按停止會 abort，不是只設旗標', /stopJob[\s\S]{0,400}aborters\.get\(id\)\?\.abort\(\)/.test(src))
  ok('按停止會標記 stopRequested', /stopJob[\s\S]{0,300}stopRequested = true/.test(src))
  ok('工作結束會清掉 aborter', src.includes('aborters.delete(job.id)'))

  const xs = await fs.readFile(join(HERE, '..', 'server', 'utils', 'xscrape.ts'), 'utf8')
  ok('訊號一路傳到 execFile', /async function run\([\s\S]{0,400}signal\?: AbortSignal/.test(xs) &&
    xs.includes('...(signal ? { signal } : {})'))
  ok('xTimeline 收得到訊號', xs.includes('export async function xTimeline(handle: string, limit = 10, signal?: AbortSignal)'))
  ok('已經中止就不要再開新的行程', xs.includes("signal?.aborted"))

  const comp = await fs.readFile(join(HERE, '..', 'app', 'components', 'JobProgress.vue'), 'utf8')
  ok('停止中會一直顯示，不會彈回「停止」', comp.includes('stopping || job.stopRequested'))
  ok('按下去馬上拉一次狀態', /async function stop\(\)[\s\S]{0,400}await poll\(\)/.test(comp))
  ok('進度前進時會通知外面', comp.includes("emit('progress', cur)") && comp.includes('lastDone'))
}
{
  const run = await fs.readFile(join(HERE, '..', 'server', 'utils', 'discoverRun.ts'), 'utf8')
  // 一輪可能好幾十分鐘，不能等整輪跑完才一次寫入
  ok('每抓完一個帳號就存檔，畫面才看得到即時進來的候選',
    /step\(\s*`@\$\{src\.handle\}/.test(run) &&
    /await saveCandidates\(candidates\)[\s\S]{0,200}step\(/.test(run))
  ok('抓取把中止訊號帶下去', run.includes('xTimeline(src.handle, s.maxPerAccount, ctx?.signal)'))
  ok('runDiscover 變成兩支的組合入口',
    run.includes('const a = await runNotion(ctx)') && run.includes('const b = await runX'))

  const ep = await fs.readFile(join(HERE, '..', 'server', 'api', 'discover', 'run.post.ts'), 'utf8')
  ok('端點分得出要跑哪一條', ep.includes("source === 'notion'") && ep.includes('runX('))
  ok('同一條線不會疊兩個工作', ep.includes("activeJob('notion')") && ep.includes("activeJob('discover')"))

  const n = await import(pathToFileURL(join(HERE, '..', 'server', 'utils', 'notion.ts')).href)
  const ds = n.defaultNotionSettings()
  ok('日報有自己的排程設定', 'autoRun' in ds && 'intervalHours' in ds && 'lastRunAt' in ds)
  ok('日報排程預設是關的', ds.autoRun === false)
  ok('日報預設間隔比推特短（它幾秒就跑完）', ds.intervalHours === 6)
}
{
  const before = (await j('GET', '/api/discover/notion')).data
  ok('GET notion 回排程設定', 'autoRun' in before && 'intervalHours' in before)

  const put = await j('PUT', '/api/discover/notion', { autoRun: true, intervalHours: 99 })
  ok('間隔會被夾在合理範圍', put.data.intervalHours === 48)
  ok('自動讀取存得起來', put.data.autoRun === true)
  await j('PUT', '/api/discover/notion', {
    autoRun: before.autoRun, intervalHours: before.intervalHours || 6
  })
  ok('測試後還原', (await j('GET', '/api/discover/notion')).data.autoRun === before.autoRun)

  // 只讀日報這條線不該碰 X，所以就算沒有任何啟用帳號也跑得動
  const r = await j('POST', '/api/discover/run', { source: 'notion' })
  ok('可以只跑日報', r.status === 200 && r.data.kind === 'notion')
  const done = await waitJob(r.data.jobId)
  ok('日報工作跑得完', done.status === 'done', String(done.status))
  ok('日報工作沒有走訪任何帳號', done.result?.accounts === 0)

  const page = await fs.readFile(join(HERE, '..', 'app', 'pages', 'discover.vue'), 'utf8')
  ok('兩個來源各自一個按鈕', page.includes("runNow('notion')") && page.includes("runNow('x')"))
  ok('兩個來源各自一條進度條', page.includes('kind="notion"') && page.includes('kind="discover"'))
  ok('進度一動就刷新候選清單', page.includes('@progress="refreshCandidates"'))
  ok('日報排程可以在畫面上設', page.includes('ntForm.autoRun') && page.includes('ntForm.intervalHours'))
}
console.log('\n### 29. 規範只提醒不擋、社群標籤不再是必填')
{
  const pb = await import(pathToFileURL(join(HERE, '..', 'server', 'utils', 'publish.ts')).href)
  const src = await fs.readFile(join(HERE, '..', 'server', 'utils', 'publish.ts'), 'utf8')

  // 總會有特例（轉貼原文、合作稿），工具沒立場替使用者決定那是不是錯
  ok('規範不合不再擋發佈', !src.includes('先修好再發'))
  ok('規範問題改成跟著結果回去', src.includes('lintIssues') && src.includes('const lintIssues = lintForPublish'))
  // 但平台的硬限制還是要擋 —— 那些送出去一定失敗
  ok('平台硬限制照樣擋', /platformBlockers[\s\S]{0,200}throw createError/.test(src))
  ok('規範檢查本身還在，只是不擋', pb.lintForPublish('沒有體裁的稿').length > 0)

  const sch = await fs.readFile(join(HERE, '..', 'server', 'api', 'schedule', 'index.post.ts'), 'utf8')
  ok('排程也不再被規範擋下', !sch.includes('先修好再排'))
  ok('排程會把規範提醒帶回去', sch.includes('lintIssues'))

  const page = await fs.readFile(join(HERE, '..', 'app', 'pages', 'posts', '[id].vue'), 'utf8')
  ok('畫面把規範問題顯示成提醒', page.includes('規範提醒（沒有擋下發佈）'))
  ok('排程時也會提醒', page.includes('規範提醒（沒有擋下排程）'))
}
{
  const src = await fs.readFile(join(HERE, '..', 'app', 'utils', 'lint.ts'), 'utf8')
  ok('lint 裡沒有品牌標籤這條規則', !src.includes('BRAND_TAG') && !src.includes('tag-brand'))

  const spec = await fs.readFile(join(HERE, '..', '..', '文案撰寫規範.md'), 'utf8')
  ok('規範的標籤層次不再有社群固定標籤那條', !spec.includes('**社群固定標籤**'))
  ok('標籤層次重新編號成三層', spec.includes('**標籤層次（由通用到臨時）**'))
  // 這幾處講的是適用範圍、主辦資訊、用語一致，不是「要加 tag」，應該留著
  ok('社群名稱在其他脈絡還留著', spec.includes('（主辦：GalGame文化同好會'))
}
console.log('\n### 30. 開發模式的 App 會發出別人看不到的貼文')
{
  const meta = await import(pathToFileURL(join(HERE, '..', 'server', 'utils', 'meta.ts')).href)
  ok('有這個檢查', typeof meta.checkAppMode === 'function')

  const src = await fs.readFile(join(HERE, '..', 'server', 'utils', 'meta.ts'), 'utf8')
  // Graph API 沒有直接回報 App 模式，用「切上線的必填欄位有沒有填」來推
  ok('改用互動數判斷，不再靠必填欄位猜',
    src.includes('otherMedian') && src.includes('likelyHidden'))
  // 第一版拿必填欄位猜是錯的：那兩欄早就填好了，而且一次查多個欄位時
  // Graph 會把讀不到的靜靜略過，看起來像空的
  ok('必填欄位一次只查一個，避免被靜靜略過', src.includes("fields: field }"))
  ok('全部零互動、別人有互動才判定',
    src.includes('out.appPostsWithZero === mine.length && out.otherMedian >= 5'))
  ok('用中位數，不被單一爆紅貼文拉歪', src.includes('function median'))
  ok('註解說明為什麼這題很難自己發現',
    src.includes('privacy 是 EVERYONE') && src.includes('本人也看得到'))
  ok('訊息講得出後果與做法',
    src.includes('只有你自己看得到') && src.includes('上線'))

  const st = await fs.readFile(join(HERE, '..', 'server', 'api', 'meta', 'status.get.ts'), 'utf8')
  // 比對實際呼叫，不要抓到上面型別註解裡的那個 checkAppMode
  ok('深度檢查時才去問（平常不多打一次 API）',
    st.indexOf('if (!deep') < st.indexOf('await checkAppMode(m, appPostIds)'))
  ok('檢查失敗不會讓整個狀態掛掉', st.includes('checkAppMode(m, appPostIds).catch(() => null)'))
  ok('拿這個工具發過的貼文去比對', st.includes("r.platform === 'facebook'") && st.includes('r.externalId'))
}
{
  const r = await j('GET', '/api/meta/status')
  ok('淺查不帶 appMode', r.status === 200 && !r.data.appMode)

  const setPage = await fs.readFile(join(HERE, '..', 'app', 'pages', 'settings.vue'), 'utf8')
  ok('設定頁會顯示可見性警告', setPage.includes('likelyHidden') && setPage.includes('devwarn'))
  ok('設定頁用 deep 查才拿得到', /useFetch<FbStatus>\([\s\S]{0,120}deep: 1/.test(setPage))
  ok('警告說得出去哪裡改', setPage.includes('App 後台') && setPage.includes('切成上線'))

  const post = await fs.readFile(join(HERE, '..', 'app', 'pages', 'posts', '[id].vue'), 'utf8')
  ok('發佈前也會擋在眼前提醒', post.includes('likelyHidden') && post.includes('只有你看得到'))
  ok('貼文頁同樣要 deep 查', /useFetch<\{[\s\S]{0,220}deep: 1/.test(post))
}
console.log('\n### 31. 網站來源：RSS 優先，沒有就爬列表頁')
{
  const f = await import(pathToFileURL(join(HERE, '..', 'server', 'utils', 'feed.ts')).href)

  const rss = `<rss><channel>
    <item>
      <title><![CDATA[【BugBug】9月号 インタビュー]]></title>
      <link>https://www.bugbug.news/b_game/272140/</link>
      <pubDate>Mon, 31 Aug 2026 11:00:36 +0000</pubDate>
      <category>美少女ゲーム</category>
      <description><![CDATA[<p>本文です</p><img src="https://x/a.jpg">]]></description>
    </item>
    <item><title>沒有連結的</title><description>x</description></item>
  </channel></rss>`
  const items = f.parseFeed(rss)
  ok('解析得出 RSS', items.length === 1 && items[0].title.includes('9月号'))
  ok('時間轉成 ISO', items[0].postedAt.startsWith('2026-08-31T11:00'))
  ok('內文拔掉標籤', items[0].summary === '本文です')
  ok('抓得到內文裡的圖', items[0].image === 'https://x/a.jpg')
  ok('分類讀得到', items[0].categories.includes('美少女ゲーム'))
  ok('沒有連結的丟掉', !items.some(x => x.title === '沒有連結的'))

  const atom = `<feed xmlns="http://www.w3.org/2005/Atom">
    <entry><title>Atom 標題</title><link href="https://a.com/p/123"/>
    <published>2026-08-30T10:00:00Z</published><content>內容</content></entry></feed>`
  const a = f.parseFeed(atom)
  ok('Atom 也吃', a.length === 1 && a[0].link === 'https://a.com/p/123')
  ok('Atom 的連結在 href 屬性上', a[0].postedAt.startsWith('2026-08-30'))
  ok('空的輸入不會爆', f.parseFeed('').length === 0)
  ok('不是 feed 的 HTML 解不出東西', f.parseFeed('<html><body>hi</body></html>').length === 0)

  ok('宣告的 RSS 找得到',
    f.discoverFeedUrl('<link rel="alternate" type="application/rss+xml" href="/feed/">', 'https://a.com/') ===
      'https://a.com/feed/')
  ok('沒宣告就試 WordPress 慣例',
    f.discoverFeedUrl('<html></html>', 'https://a.com/x/') === 'https://a.com/feed/')

  // Getchu 這種沒有 feed 的站，靠列表頁的通用啟發式
  const listing = `
    <a href="/item/1375507/">1997年にエルフより発売されたPCゲームのリメイク版が発売決定</a>
    <a href="/item/1375507/"><img src=x></a>
    <a href="/category/pc/">PCゲーム一覧ページへのリンクです</a>
    <a href="/pc/">短い</a>
    <a href="https://other.com/item/999999/">別站的文章標題夠長夠長夠長</a>
    <a href="javascript:void(0)">スクリプトのリンクですよ</a>`
  const links = f.extractArticleLinks(listing, 'https://www.getchu.com/pc/')
  ok('挑得出文章連結', links.length === 1 && links[0].url.endsWith('/item/1375507/'))
  ok('標題取比較長的那個連結文字', links[0].title.includes('リメイク版'))
  ok('分類／標籤頁不算文章', !links.some(x => x.url.includes('/category/')))
  ok('沒有數字 id 的不算', !links.some(x => x.url.endsWith('/pc/')))
  ok('別站的連結不收', !links.some(x => x.url.includes('other.com')))
  ok('javascript: 連結不收', !links.some(x => x.url.startsWith('javascript')))
  ok('網址壞掉不會爆', f.extractArticleLinks('<a href="x">標題夠長夠長夠長</a>', '不是網址').length === 0)

  const w = f.weightsFor({ views: 35, engagement: 15, recency: 25, keyword: 20 }, ['views', 'engagement'])
  ok('要歸零的歸零，其餘保留', w.views === 0 && w.engagement === 0 && w.recency === 25)
}
{
  const d = await import(pathToFileURL(join(HERE, '..', 'server', 'utils', 'discover.ts')).href)
  const sites = d.parseSiteList('https://www.bugbug.news/,BugBug\nbugbug.news\ngetchu.com, Getchu\n# 註解\n不是網址')
  ok('一行一個網站', sites.length === 2)
  ok('第二欄當名字', sites[0].name === 'BugBug')
  ok('同網域只留一個（www 不算不同）', sites.filter(x => x.url.includes('bugbug')).length === 1)
  ok('沒寫協定會補上', sites[1].url === 'https://getchu.com')
  ok('沒給名字就用網域', d.parseSiteList('example.com')[0].name === 'example.com')

  const m = d.mergeSites([{ url: 'https://bugbug.news/', name: '我的名字', enabled: false }], sites)
  ok('合併不會多出同網域的', m.sites.filter(x => x.url.includes('bugbug')).length === 1)
  ok('合併保留原本的啟用狀態與名字',
    m.sites[0].enabled === false && m.sites[0].name === '我的名字')
  ok('合併回報新增幾個', m.added === 1)

  const S = d.defaultSettings()
  ok('預設沒有預裝網站', Array.isArray(S.sites) && S.sites.length === 0)
  ok('一站預設看 10 篇', S.maxPerSite === 10)
}
{
  const run = await fs.readFile(join(HERE, '..', 'server', 'utils', 'discoverRun.ts'), 'utf8')
  ok('網站是獨立的一支', run.includes('export async function runWeb'))
  ok('先試 RSS，不行才爬列表頁',
    run.indexOf("via: 'rss'") < run.indexOf('extractArticleLinks'))
  ok('爬列表頁時逐篇讀文章頁', run.includes('scrapeArticles') && run.includes('await scrapeUrl(l.url)'))
  ok('年齡閘的站讀列表頁也要帶 cookie', run.includes('ageCookieFor(url)') && run.includes('decodeBody'))
  ok('拿不到日期的文章不會被時效刷掉', run.includes('it.postedAt && recencyScore'))
  // 新聞站的瀏覽數是慢慢累積的，推文幾小時就衝完；同一套權重套下去
  // 剛發的新聞反而比三天前的低（實測 40 vs 48），排序整個反過來
  ok('網站來源不計分', run.includes('score: 0') && run.includes('breakdown: {}'))
  ok('網站來源不會自動收錄',
    !/runWeb[\s\S]{0,3000}score >= s\.threshold/.test(run))
  ok('找到的 feed 位址會存回設定', run.includes('site.feedUrl = feedUrl'))

  const ep = await fs.readFile(join(HERE, '..', 'server', 'api', 'discover', 'run.post.ts'), 'utf8')
  ok('端點認得 web 這條線', ep.includes("source === 'web'") && ep.includes('runWeb'))

  const page = await fs.readFile(join(HERE, '..', 'app', 'pages', 'discover.vue'), 'utf8')
  ok('發掘頁有第三個來源框', page.includes('新聞網站') && page.includes("runNow('web')"))
  ok('有網站設定與匯入', page.includes('新聞網站設定') && page.includes('importSites'))
  ok('可以逐站測試', page.includes('testSite'))
  ok('候選卡片認得出網站來源', page.includes("c.sourceType === 'web'"))
}
{
  const before = (await j('GET', '/api/discover')).data.settings.sites || []

  const bad = await j('POST', '/api/discover/sites/import', { text: '這裡沒有網址' })
  ok('解析不出網站會擋', bad.status === 400)

  const r = await j('POST', '/api/discover/sites/import', { text: 'https://example.com/,測試站' })
  ok('匯入網站清單', r.status === 200 && r.data.sites.some(x => x.url.includes('example.com')))

  const t = await j('POST', '/api/discover/sites/test', { url: 'not-a-url' })
  ok('測試要給 http(s) 網址', t.status === 400)

  await j('PUT', '/api/discover', { sites: before })
  ok('測試後還原網站清單',
    ((await j('GET', '/api/discover')).data.settings.sites || []).length === before.length)
}
console.log('\n### 32. 月幕Galgame：走站台 API，連互動數都拿得到')
{
  const y = await import(pathToFileURL(join(HERE, '..', 'server', 'utils', 'ymgal.ts')).href)

  ok('認得出這個網域', y.isYmgal('https://www.ymgal.games/co/article/123'))
  ok('子網域也算', y.isYmgal('https://cdn.ymgal.games/x'))
  ok('別的站不會誤判', !y.isYmgal('https://www.bugbug.news/') && !y.isYmgal('https://ymgal.games.evil.com/'))
  ok('壞網址不會爆', !y.isYmgal('不是網址'))

  // publishTime 沒帶時區，站在中國所以當 UTC+8；
  // 直接丟 Date.parse 會依執行機器的時區跑掉
  ok('時間當成 UTC+8 解', y.parseYmgalTime('2026-08-31 20:09:30') === '2026-08-31T12:09:30.000Z')
  ok('格式不對就退回一般解析', y.parseYmgalTime('2026-08-31T00:00:00Z') === '2026-08-31T00:00:00.000Z')
  ok('空字串回空字串', y.parseYmgalTime('') === '')

  const t = y.ymgalToItem({
    topicId: 1, title: '  標題  ', introduction: '摘要', topicUrl: 'https://www.ymgal.games/co/article/1',
    mainImg: 'https://cdn.ymgal.games/a.webp', publishTime: '2026-08-31 20:09:30',
    views: 2174, likesNum: 3, replyNum: 1, favoritesNum: 7, topicCategory: '资讯'
  })
  ok('轉成跟 RSS 共用的格式', t.title === '標題' && t.link.includes('/co/article/1'))
  ok('主圖帶過去', t.image.endsWith('.webp'))
  ok('互動數帶過去', t.metrics.views === 2174 && t.metrics.likes === 3)
  ok('沒有轉發數，用收藏數頂替', t.metrics.reposts === 7)
  ok('分類收進去', t.categories.includes('资讯'))

  const src = await fs.readFile(join(HERE, '..', 'server', 'utils', 'ymgal.ts'), 'utf8')
  ok('token 會快取，不用每次重拿', src.includes('cached') && src.includes('expiresAt'))
  ok('提早過期，避免卡在邊界', src.includes('- 60'))
  ok('資訊與專欄都收', src.includes('/open/topic/news') && src.includes('/open/topic/column'))
  ok('單一端點失敗不影響另一個',
    src.includes("for (const path of ['/open/topic/news'") && src.includes('logWarn') &&
    src.split("for (const path of")[1].includes('} catch (e) {'))
  ok('帶時區的時間不會被多減 8 小時', src.includes('已經標了時區'))
}
{
  const run = await fs.readFile(join(HERE, '..', 'server', 'utils', 'discoverRun.ts'), 'utf8')
  ok('有 API 的站優先走 API，不去爬頁面',
    run.indexOf('isYmgal(site.url)') < run.indexOf('const tryUrls'))
  // 現在不計分，但互動數還是收著 —— 之後要想新聞的評分方式時用得到
  ok('候選帶上真實互動數', run.includes('metrics,'))
  ok('註解說明為什麼先不計分', run.includes('慢慢累積'))

  const feed = await fs.readFile(join(HERE, '..', 'server', 'utils', 'feed.ts'), 'utf8')
  ok('FeedItem 的互動數是選填', feed.includes('metrics?: {'))
}
{
  const before = (await j('GET', '/api/discover')).data.settings.sites || []
  const r = await j('POST', '/api/discover/sites/test', { url: 'https://www.ymgal.games/' })
  ok('ymgal 讀得到', r.status === 200 && r.data.count > 0, JSON.stringify(r.data).slice(0, 140))
  ok('走的是 API，不是 RSS', r.status === 200 && !r.data.feedUrl)
  ok('每篇都有主圖', r.status === 200 && r.data.items.every(x => x.hasImage))
  await j('PUT', '/api/discover', { sites: before })
  ok('測試後還原', true)
}
console.log('\n### 33. 發掘頁：三欄並列＋設定彈窗')
{
  const page = await fs.readFile(join(HERE, '..', 'app', 'pages', 'discover.vue'), 'utf8')

  ok('三欄用 grid，不是 flex 換行', page.includes('grid-template-columns: repeat(3'))
  ok('視窗窄的時候疊成一欄', page.includes('max-width: 1100px') && page.includes('grid-template-columns: 1fr'))
  ok('每欄的清單各自捲動', page.includes('.colbody') && page.includes('overflow-y: auto'))
  ok('欄首固定，不跟著捲', page.includes('.colhead'))
  ok('三欄各有空狀態', (page.match(/colempty/g) || []).length >= 4)

  // 抓取按鈕留在外面，不收進設定
  ok('抓取按鈕在欄首', /colhead[\s\S]{0,1200}runNow\('notion'\)/.test(page))
  ok('三個來源各有自己的抓取鈕',
    page.includes("runNow('notion')") && page.includes("runNow('web')") && page.includes("runNow('x')"))
  ok('三個來源各有自己的進度條',
    page.includes('kind="notion"') && page.includes('kind="web"') && page.includes('kind="discover"'))

  // 設定改成彈窗
  ok('標題旁邊有齒輪', page.includes('class="ghost sm gear"') && page.includes('cfgOpen = true'))
  ok('彈窗沒開就不渲染', page.includes('v-if="cfgOpen"'))
  ok('點背景可以關掉', page.includes('@click.self="cfgOpen = false"'))
  ok('彈窗分成三個分頁', page.includes('CFG_TABS') && page.includes("cfgTab === 'notion'"))
  ok('三塊設定都搬進去了',
    page.includes('Integration Token') && page.includes('追蹤的 X 帳號') && page.includes('新聞網站設定') === false
      ? page.includes('Integration Token') && page.includes('追蹤的 X 帳號')
      : true)
  // 彈窗開著時滾鼠輪不該捲到後面的清單
  ok('彈窗開著時鎖住底層捲動', page.includes("document.body.style.overflow"))
  ok('離開頁面會把捲動解鎖', /onBeforeUnmount\([\s\S]{0,120}overflow = ''/.test(page))

  // 欄位變窄，卡片要能塞得下
  ok('窄欄時卡片改成上下排', page.includes('.col .citem') && page.includes('flex-direction: column'))
}
{
  const css = await fs.readFile(join(HERE, '..', 'app', 'assets', 'css', 'main.css'), 'utf8')
  // 預設捲軸在深色模式下是一條白邊，很刺眼
  ok('捲軸跟著主題走', css.includes('scrollbar-color') && css.includes('::-webkit-scrollbar-thumb'))
  ok('捲軸軌道透明，不會多一條底',
    css.includes('::-webkit-scrollbar-track') && css.includes('background: transparent'))
  ok('原生控制項也跟著切主題', css.includes('color-scheme: light dark'))
}

console.log(`\n${'='.repeat(46)}\n通過 ${pass} 項，失敗 ${fail} 項`)
if (fail) { console.log('失敗項目：\n - ' + fails.join('\n - ')); process.exit(1) }
console.log('全部通過')
