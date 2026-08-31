import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/**
 * 依《文案撰寫規範.md》撰寫貼文。兩種模式：
 *   { materialId } → 從素材撰寫，順便讓 AI 判斷體裁／子型／待補，然後建立貼文
 *   { postId }     → 對既有貼文重新撰寫（鎖定的版本不動）
 */
export default defineEventHandler(async event => {
  const body = await readBody<{
    materialId?: string
    postId?: string
    extra?: string
    perPlatform?: number
    platforms?: string[]
  }>(event)

  const sp = specPath()
  if (!(await exists(sp))) throw createError({ statusCode: 500, message: '找不到 文案撰寫規範.md：' + sp })
  const spec = await fs.readFile(sp, 'utf8')
  const perPlatform = Math.min(Math.max(Number(body?.perPlatform) || 2, 1), 3)
  const settings = await loadSettings()
  // 反饋優化累積的個人偏好，接在規範後面一起送出
  const memory = buildMemoryBlock(await loadRules(), await loadHistory())

  // ── 從素材撰寫 ────────────────────────────────────────────────
  if (body?.materialId) {
    const id = safeSegment(body.materialId)
    const m = await loadMaterial(id)
    if (!m) throw createError({ statusCode: 404, message: '找不到這則素材' })

    const platforms = body.platforms?.length ? body.platforms : m.platforms
    const extra = body.extra ?? m.extra
    const { images, skipped } = settings.sendImages
      ? await loadImages(join(inboxDir(), id, 'images'), m.images)
      : { images: [], skipped: [] as string[] }

    const { draft, usage, model, note } = await generateDrafts({
      spec,
      text: m.text,
      title: m.title,
      platforms,
      sourceName: m.sourceGuess,
      sourceUrl: m.finalUrl || m.url,
      links: m.finalUrl || m.url ? [{ label: '素材來源', url: m.finalUrl || m.url }] : [],
      artists: [],
      extra,
      memory,
      perPlatform,
      images
    })

    logInfo('post', `撰寫素材「${m.title || id}」→ ${platforms.join('、')} 各 ${perPlatform} 版`)
    const postId = await createPostFromMaterial({ ...m, platforms }, draft)
    await writeVariants(postId, draft.variants, [])
    logOk('post', `產出貼文「${draft.title}」【${draft.category}】${draft.postType}｜${draft.variants.length} 版本｜待補 ${draft.missing.length}`)

    m.written = true
    m.postId = postId
    m.platforms = platforms
    m.extra = extra
    await saveMaterial(m)

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
    images
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
