import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/**
 * 依《文案撰寫規範.md》撰寫貼文。三種模式：
 *   { materialId }    → 從素材撰寫，順便讓 AI 判斷體裁／子型／待補，然後建立貼文
 *   { materialIds }   → 多則素材合併成一篇，第一則是主素材
 *   { postId }        → 對既有貼文重新撰寫（鎖定的版本不動）
 */
const MAX_MERGE = 6

export default defineEventHandler(async event => {
  const body = await readBody<{
    materialId?: string
    materialIds?: string[]
    postId?: string
    extra?: string
    perPlatform?: number
    platforms?: string[]
  }>(event)

  const sp = await ensureSpec()
  if (await specIsEmpty()) {
    throw createError({
      statusCode: 400,
      message: '還沒有撰寫規範。到「撰寫規範」頁把你自己的規範文件丟進去，AI 才知道要照什麼寫。'
    })
  }
  const spec = await fs.readFile(sp, 'utf8')
  const perPlatform = Math.min(Math.max(Number(body?.perPlatform) || 2, 1), 3)
  const settings = await loadSettings()
  // 反饋優化累積的個人偏好，接在規範後面一起送出
  const memory = buildMemoryBlock(await loadRules(), await loadHistory())

  // ── 從素材撰寫（多則就是合併成一篇）──────────────────────────
  const materialIds = [
    ...new Set((body?.materialIds?.length ? body.materialIds : body?.materialId ? [body.materialId] : []).map(x =>
      safeSegment(String(x))
    ))
  ]
  if (materialIds.length) {
    const merged = materialIds.length > 1
    if (materialIds.length > MAX_MERGE) {
      throw createError({ statusCode: 400, message: `一次最多合併 ${MAX_MERGE} 則素材` })
    }
    const ms: Material[] = []
    for (const id of materialIds) {
      const m = await loadMaterial(id)
      if (!m) throw createError({ statusCode: 404, message: merged ? `找不到素材「${id}」` : '找不到這則素材' })
      // 一則素材只屬於一篇貼文；單則重寫是刻意另開新貼文，合併時就不收已撰寫的
      if (merged && m.written) {
        throw createError({ statusCode: 409, message: `「${m.title || id}」已經撰寫過了，不能再合併進別篇` })
      }
      ms.push(m)
    }
    const main = ms[0]!

    const platforms = body.platforms?.length
      ? body.platforms
      : merged
        ? [...new Set(ms.flatMap(m => m.platforms))]
        : main.platforms
    const extra = body.extra ?? (merged ? [...new Set(ms.map(m => m.extra.trim()).filter(Boolean))].join('\n') : main.extra)

    // 合併時每則只送會帶進貼文的那幾張，各自的第一張當主視覺優先送
    const imageFiles = ms.flatMap((m, i) =>
      (merged ? m.images.slice(0, MERGE_IMAGES_PER_MATERIAL) : m.images).map((f, k) => ({
        path: join(inboxDir(), m.id, 'images', f),
        name: merged ? `素材${i + 1}/${f}` : f,
        lead: merged ? k === 0 : undefined
      }))
    )
    const { images, skipped } = settings.sendImages
      ? await loadImagesFrom(imageFiles)
      : { images: [], skipped: [] as string[] }

    const sources = ms.map(materialToSource)
    const { draft, usage, model, note } = await generateDrafts({
      spec,
      text: joinSourceTexts(sources),
      title: main.title,
      platforms,
      sourceName: main.sourceGuess,
      sourceUrl: main.finalUrl || main.url,
      links: sources
        .filter(s => s.url)
        .map((s, i) => ({ label: merged ? `素材來源 ${i + 1}` : '素材來源', url: s.url })),
      artists: [],
      extra,
      memory,
      perPlatform,
      images,
      sources: merged ? sources : undefined
    })

    const what = merged ? `合併 ${ms.length} 則素材「${main.title || main.id}」等` : `撰寫素材「${main.title || main.id}」`
    logInfo('post', `${what} → ${platforms.join('、')} 各 ${perPlatform} 版`)
    const postId = await createPostFromMaterials(ms, draft, platforms)
    await writeVariants(postId, draft.variants, [])
    logOk('post', `產出貼文「${draft.title}」【${draft.category}】${draft.postType}｜${draft.variants.length} 版本｜待補 ${draft.missing.length}`)

    for (const m of ms) {
      m.written = true
      m.postId = postId
      if (!merged) {
        m.platforms = platforms
        m.extra = extra
      }
      await saveMaterial(m)
    }

    return { postId, post: await loadPost(postId), created: draft.variants.length, skipped, usage, model, note }
  }

  // ── 對既有貼文重新撰寫 ────────────────────────────────────────
  const id = safeSegment(body?.postId || '')
  const post = await loadPost(id)
  if (!post) throw createError({ statusCode: 404, message: '找不到這則貼文' })

  const selected = post.images.filter(i => i.selected)
  const { images, skipped } = settings.sendImages
    ? await loadImages(join(postsDir(), id, 'images'), selected.map(i => i.file))
    : { images: [], skipped: [] as string[] }

  const platforms = body?.platforms?.length ? body.platforms : post.platforms
  const { draft, usage, model, note } = await generateDrafts({
    spec,
    text: post.note,
    title: post.title,
    platforms,
    sourceName: post.sourceName,
    sourceUrl: post.sourceUrl,
    links: post.links,
    artists: [...new Set(selected.map(i => i.artist.trim()).filter(Boolean))],
    extra: body?.extra || '',
    memory,
    perPlatform,
    images,
    // 合併撰寫的貼文重寫時，照樣逐則送，不然模型只看得到串在一起的一大段
    sources: post.sources.length > 1 ? post.sources : undefined
  })

  const locked = post.variants.filter(v => v.locked)
  const vdir = join(postsDir(), id, 'variants')
  for (const v of post.variants) {
    if (!v.locked) await fs.rm(join(vdir, v.id + '.md'), { force: true })
  }
  const created = await writeVariants(id, draft.variants, locked)
  logOk('post', `重寫「${post.title}」｜${created.length} 版本｜保留鎖定 ${locked.length} 版`)

  const { variants, ...meta } = post
  meta.category = draft.category
  meta.postType = draft.postType
  meta.missing = draft.missing
  if (!meta.sourceName && draft.sourceName) meta.sourceName = draft.sourceName
  meta.status = draft.missing.length ? 'needs-info' : meta.status === 'needs-info' ? 'draft' : meta.status
  await savePostMeta(meta)

  return { postId: id, post: await loadPost(id), created: created.length, skipped, usage, model, note }
})

/**
 * 寫入版本檔，id 從 v1 開始遞增並跳過已鎖定的。
 * 同時把 AI 原稿另存一份到 origin/，之後「反饋優化」要拿它跟使用者終稿比對。
 */
async function writeVariants(postId: string, variants: DraftVariant[], keep: Variant[]) {
  const vdir = join(postsDir(), postId, 'variants')
  const odir = join(postsDir(), postId, 'origin')
  await ensureDir(vdir)
  await ensureDir(odir)
  const used = new Set(keep.map(v => v.id))
  let n = 1
  const created: string[] = []
  for (const nv of variants) {
    while (used.has('v' + n)) n++
    const vid = 'v' + n
    used.add(vid)
    await fs.writeFile(
      join(vdir, vid + '.md'),
      serializeVariant({
        id: vid,
        label: nv.label,
        platform: nv.platform,
        locked: false,
        note: nv.note,
        body: nv.body
      }),
      'utf8'
    )
    await fs.writeFile(join(odir, vid + '.md'), nv.body, 'utf8')
    created.push(vid)
  }
  return created
}
