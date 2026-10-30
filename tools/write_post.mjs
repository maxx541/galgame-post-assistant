#!/usr/bin/env node
/**
 * 不經過 AI API，直接把「已經寫好的文案」寫進貼文工作台的資料夾。
 * 給 API 掛掉時由 Claude Code（或任何人）代寫用，產出的檔案跟網頁的「撰寫」按鈕完全一樣：
 *   data/posts/<id>/{post.json, variants/vN.md, origin/vN.md, images/}
 * 並把素材標成已撰寫。邏輯對應 web/server/utils/material.ts 的 createPostFromMaterials。
 *
 * 用法（純 Node，不用 npm install）：
 *   node tools/write_post.mjs add <x_scraper輸出.json> <圖片資料夾>   網址抓下來後存成素材
 *   node tools/write_post.mjs list                      列出還沒撰寫的素材
 *   node tools/write_post.mjs show <素材id> [...]        印出素材全文、連結、圖片清單
 *   node tools/write_post.mjs check <draft.json>         只檢查規範，不寫入
 *   node tools/write_post.mjs write <draft.json> <素材id> [素材id ...]   寫入（第一個是主素材）
 *
 * draft.json 格式見 docs/代寫貼文.md。
 */
import { promises as fs } from 'node:fs'
import { join, resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = process.env.POST_DATA_DIR ? resolve(process.env.POST_DATA_DIR) : join(ROOT, 'data')
const INBOX = join(DATA, 'inbox')
const POSTS = join(DATA, 'posts')

const MERGE_IMAGES_PER_MATERIAL = 3
const MAX_SELECTED_IMAGES = 10
const CATEGORIES = ['情報', '心得', '分享', '成果', '社課', '企劃', '投票', '台詞', '音樂']
const POST_TYPES = ['活動招募', '講座・讀書會預告', '里程碑・成果公告', '賽事・投票／展覽合作', '推坑・安利', '發售・銷量／特賣公告']
const PLATFORMS = {
  facebook: { body: [null, null], tags: [1, 3] },
  threads: { body: [100, 200], tags: [2, 4] },
  instagram: { body: [138, 150], tags: [3, 5] },
  x: { body: [71, 100], tags: [1, 3] }
}

const chars = s => [...String(s ?? '')]
const cut = (s, n) => chars(s).slice(0, n).join('')
const exists = p => fs.access(p).then(() => true, () => false)
const readJson = async (p, fb) => { try { return JSON.parse(await fs.readFile(p, 'utf8')) } catch { return fb } }
const writeJson = (p, d) => fs.writeFile(p, JSON.stringify(d, null, 2) + '\n', 'utf8')
const die = m => { console.error('錯誤：' + m); process.exit(1) }

function slugify(input) {
  const s = String(input || '').trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '-').replace(/[.]+$/, '')
  return cut(s, 48) || 'post'
}
function todayStamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}
async function uniqueId(dir, base) {
  let id = base, i = 2
  while (await exists(join(dir, id))) id = `${base}-${i++}`
  return id
}

// ── 檢查 ──────────────────────────────────────────────────────────
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{2190}-\u{21FF}\u{2300}-\u{23FF}]/u

export function checkDraft(d) {
  const errs = [], warns = []
  if (!d.title) errs.push('缺 title')
  if (!CATEGORIES.includes(d.category)) errs.push(`category 必須是：${CATEGORIES.join('、')}`)
  if (!POST_TYPES.includes(d.postType)) errs.push(`postType 必須是：${POST_TYPES.join('、')}`)
  if (!Array.isArray(d.variants) || !d.variants.length) errs.push('variants 至少要有一個')
  const labels = new Set()
  for (const [i, v] of (d.variants || []).entries()) {
    const at = `variants[${i}]（${v.label || '?'}）`
    if (!v.label) errs.push(`${at} 缺 label`)
    else if (labels.has(v.label)) errs.push(`${at} label 重複`)
    labels.add(v.label)
    if (!PLATFORMS[v.platform]) { errs.push(`${at} platform 必須是 ${Object.keys(PLATFORMS).join('/')}`); continue }
    const body = String(v.body || '')
    const lines = body.trim().split('\n')
    if (!/^【[^】]+】/.test(lines[0])) errs.push(`${at} 首行必須是【體裁】標題`)
    if (EMOJI.test(body)) errs.push(`${at} 含 emoji`)
    if (/https?:\/\//i.test(body)) errs.push(`${at} 正文含網址（改寫「網址放留言」）`)
    if (!/（來源：[^）]+）/.test(body)) errs.push(`${at} 缺（來源：…）`)
    const last = lines[lines.length - 1].trim()
    if (!/^(#\S+\s*)+$/.test(last)) errs.push(`${at} 最末行必須是 hashtag`)
    else {
      const n = last.split(/\s+/).length, [lo, hi] = PLATFORMS[v.platform].tags
      if (n < lo || n > hi) errs.push(`${at} hashtag ${n} 個，${v.platform} 要 ${lo}–${hi} 個`)
    }
    if (body.search(/（來源：/) > body.trimEnd().lastIndexOf('\n')) errs.push(`${at} 來源必須在 hashtag 之前`)
    // 正文長度：去掉首行標題、來源、繪師、hashtag 行再算
    const text = lines.slice(1, -1).filter(l => !/^（(來源|繪師)：/.test(l.trim())).join('').replace(/（來源：[^）]*）/g, '')
    const [bmin, bmax] = PLATFORMS[v.platform].body
    if (bmin !== null && (chars(text).length < bmin * 0.8 || chars(text).length > bmax * 1.5))
      warns.push(`${at} 正文約 ${chars(text).length} 字，${v.platform} 建議 ${bmin}–${bmax}`)
    if (/Q版/.test(body)) warns.push(`${at} 偏好規則：Q版 → SD`)
  }
  return { errs, warns }
}

// ── 指令 ──────────────────────────────────────────────────────────
async function loadMaterial(id) {
  const m = await readJson(join(INBOX, id, 'material.json'), null)
  if (!m) die(`找不到素材「${id}」`)
  return { links: [], images: [], ...m, id }
}

async function cmdList() {
  const ids = (await fs.readdir(INBOX, { withFileTypes: true }).catch(() => [])).filter(e => e.isDirectory()).map(e => e.name)
  const rows = []
  for (const id of ids) {
    const m = await readJson(join(INBOX, id, 'material.json'), null)
    if (m && !m.written) rows.push(m)
  }
  rows.sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''))
  if (!rows.length) return console.log('沒有未撰寫的素材')
  for (const m of rows) console.log(`${m.id}\n   ${m.sourceGuess || m.handle || ''}｜${(m.images || []).length} 張圖｜${cut((m.text || '').replace(/\s+/g, ' '), 60)}`)
}

async function cmdShow(ids) {
  if (!ids.length) die('請給素材 id')
  for (const id of ids) {
    const m = await loadMaterial(id)
    console.log(`===== ${id} =====`)
    console.log(`來源：${m.sourceGuess || m.handle}｜作者：${m.author}｜發佈：${m.postedAt}｜已撰寫：${m.written}`)
    console.log(`網址：${m.finalUrl || m.url}`)
    console.log(`導流連結（留言用）：${m.links.map(l => l.url).join(' , ') || '無'}`)
    console.log(`圖片（${join(INBOX, id, 'images')}）：${m.images.join(' ')}`)
    console.log('--- 原文 ---\n' + m.text + '\n')
  }
}

async function readDraft(p) {
  if (!p) die('請給 draft.json 路徑')
  let d
  try { d = JSON.parse((await fs.readFile(resolve(p), 'utf8')).replace(/^﻿/, '')) } catch (e) { die(`讀不了 ${p}：${e.message}`) }
  return d
}

function report({ errs, warns }) {
  for (const w of warns) console.log('提醒：' + w)
  for (const e of errs) console.log('不合規：' + e)
  return !errs.length
}

async function cmdWrite(draftPath, ids) {
  const d = await readDraft(draftPath)
  if (!ids.length) die('請至少給一個素材 id（第一個是主素材）')
  if (!report(checkDraft(d))) die('文案不合規，修好再寫入')
  const ms = []
  for (const id of ids) {
    const m = await loadMaterial(id)
    if (ids.length > 1 && m.written) die(`「${id}」已經撰寫過了，不能再合併進別篇`)
    ms.push(m)
  }
  const main = ms[0], merged = ms.length > 1
  const platforms = d.platforms?.length ? d.platforms : [...new Set(d.variants.map(v => v.platform))]
  const missing = Array.isArray(d.missing) ? d.missing : []

  const sources = ms.map(m => ({
    materialId: m.id, title: m.title, url: m.finalUrl || m.url,
    sourceName: m.sourceGuess || m.handle || m.author, author: m.author, postedAt: m.postedAt, text: m.text
  }))
  const note = sources.length === 1
    ? sources[0].text
    : sources.map((s, i) => {
        const l = [`【素材 ${i + 1}${i === 0 ? '・主要' : ''}】${s.title || s.sourceName || ''}`]
        if (s.url) l.push(s.url)
        l.push('', s.text.trim())
        return l.join('\n')
      }).join('\n\n')

  await fs.mkdir(POSTS, { recursive: true })
  const postId = await uniqueId(POSTS, todayStamp() + '-' + slugify(cut(d.title, 24)))
  const dst = join(POSTS, postId)
  for (const s of ['variants', 'origin', 'images']) await fs.mkdir(join(dst, s), { recursive: true })

  const now = new Date().toISOString()
  const post = {
    id: postId, title: d.title, category: d.category, postType: d.postType,
    sourceName: d.sourceName || main.sourceGuess || '', sourceUrl: main.finalUrl || main.url,
    sources, platforms, status: missing.length ? 'needs-info' : 'draft', missing,
    links: [], note, images: [], publishRecords: [], createdAt: now, updatedAt: now
  }
  const seen = new Set()
  for (const m of ms) for (const l of m.links || []) {
    const url = (l.url || '').trim()
    if (!url || seen.has(url)) continue
    seen.add(url)
    post.links.push({ label: l.label || '', url })
  }
  for (const m of ms) {
    for (const f of merged ? m.images.slice(0, MERGE_IMAGES_PER_MATERIAL) : m.images) {
      const from = join(INBOX, m.id, 'images', f)
      if (!(await exists(from))) continue
      const used = new Set((await fs.readdir(join(dst, 'images'))).map(x => x.replace(/\.[^.]+$/, '')))
      let n = 1
      while (used.has(String(n).padStart(2, '0'))) n++
      const name = String(n).padStart(2, '0') + extname(f)
      await fs.copyFile(from, join(dst, 'images', name))
      post.images.push({ file: name, artist: '', alt: '', sourceUrl: m.finalUrl || m.url, selected: !merged || post.images.length < MAX_SELECTED_IMAGES })
    }
  }
  await writeJson(join(dst, 'post.json'), post)

  for (const [i, v] of d.variants.entries()) {
    const id = 'v' + (i + 1)
    const fm = ['---', `id: ${id}`, `label: ${v.label}`, `platform: ${v.platform}`, 'locked: false',
      `note: ${(v.note || '').replace(/[\r\n]+/g, ' ')}`, '---', ''].join('\n')
    const body = String(v.body).trim().replace(/\r\n/g, '\n')
    await fs.writeFile(join(dst, 'variants', id + '.md'), fm + body, 'utf8')
    await fs.writeFile(join(dst, 'origin', id + '.md'), body, 'utf8') // AI 原稿，反饋優化要拿來跟終稿比對
  }

  for (const m of ms) {
    m.written = true
    m.postId = postId
    if (!merged) m.platforms = platforms
    await writeJson(join(INBOX, m.id, 'material.json'), m)
  }
  console.log(`已寫入貼文：${postId}\n  ${d.variants.length} 個版本｜${post.images.length} 張圖｜待補 ${missing.length} 項｜素材 ${ms.length} 則已標為已撰寫`)
  console.log(`  位置：${dst}\n  網頁重新整理（或重開）貼文列表即可看到。`)
}

/**
 * 把 tools/x_scraper.py --url <網址> --images-dir <DIR> 的 JSON 輸出存成收件匣素材。
 * 網頁伺服器沒開、使用者只丟網址時用。格式對應 web/server/utils/material.ts 的 Material。
 */
async function cmdAdd(jsonPath, imagesDir) {
  const r = await readDraft(jsonPath)
  if (!r.text && !(r.images || []).length) die('抓取結果沒有內文也沒有圖')
  const first = (r.text || '').split('\n').map(s => s.trim()).find(Boolean) || r.handle || 'x'
  const base = todayStamp() + '-' + slugify(cut(first, 24))
  await fs.mkdir(INBOX, { recursive: true })
  const id = await uniqueId(INBOX, base)
  const dir = join(INBOX, id)
  await fs.mkdir(join(dir, 'images'), { recursive: true })
  const images = []
  for (const f of r.downloaded || []) {
    const from = resolve(imagesDir || '.', f)
    if (!(await exists(from))) continue
    await fs.copyFile(from, join(dir, 'images', f))
    images.push(f)
  }
  const m = {
    id, title: first, url: r.url, finalUrl: r.finalUrl || r.url, text: r.text || '',
    author: r.author || '', handle: r.handle || '', postedAt: r.createdAt || '',
    sourceGuess: r.handle || r.author || '', via: 'playwright', platforms: ['facebook'], extra: '',
    images, links: (r.links || []).map(u => ({ url: u.url || u, label: u.label || '' })),
    warning: r.warning || '', written: false, postId: '', addedAt: new Date().toISOString()
  }
  await writeJson(join(dir, 'material.json'), m)
  console.log(`已加入素材：${id}（${images.length} 張圖）`)
}

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'add') await cmdAdd(rest[0], rest[1])
else if (cmd === 'list') await cmdList()
else if (cmd === 'show') await cmdShow(rest)
else if (cmd === 'check') { const ok = report(checkDraft(await readDraft(rest[0]))); if (ok) console.log('規範檢查通過'); process.exit(ok ? 0 : 1) }
else if (cmd === 'write') await cmdWrite(rest[0], rest.slice(1).filter(x => !x.startsWith('--')))
else console.log('用法：node tools/write_post.mjs list | show <id..> | check <draft.json> | write <draft.json> <素材id..>')
