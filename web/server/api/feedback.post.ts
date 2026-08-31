import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/**
 * 反饋優化：比對這個版本的 AI 原稿與你改完的終稿，
 * 提煉出個人風格偏好寫進記憶庫，之後每次撰寫都會帶上。
 */
export default defineEventHandler(async event => {
  const body = await readBody<{ postId?: string; variantId?: string }>(event)
  const id = safeSegment(body?.postId || '')
  const vid = safeSegment(body?.variantId || '')

  const post = await loadPost(id)
  if (!post) throw createError({ statusCode: 404, message: '找不到這則貼文' })
  const variant = post.variants.find(v => v.id === vid)
  if (!variant) throw createError({ statusCode: 404, message: '找不到這個版本' })

  const originPath = join(postsDir(), id, 'origin', vid + '.md')
  if (!(await exists(originPath))) {
    throw createError({
      statusCode: 400,
      message: '找不到這個版本的 AI 原稿（可能是舊資料或手動新增的版本），沒有東西可以比對'
    })
  }
  const aiDraft = await fs.readFile(originPath, 'utf8')
  const userFinal = variant.body

  if (aiDraft.trim() === userFinal.trim()) {
    return { changed: false, rules: [], added: [], bumped: [], summary: '這個版本你還沒改過，沒有東西可以學。' }
  }

  const existing = await loadRules()
  const { data, usage, model } = await chatJson(
    buildReflectMessages(aiDraft, userFinal, PLATFORM_RULES[variant.platform]?.label || variant.platform, existing),
    REFLECT_SCHEMA,
    'style_rules',
    3000
  )
  const r = normalizeReflection(data)

  logInfo('feedback', `反饋優化「${post.title}」${vid}｜原稿 ${[...aiDraft].length} 字 → 終稿 ${[...userFinal].length} 字`)
  const { rules, added, bumped } = mergeRules(existing, r.rules)
  logOk('feedback', `學到 ${added.length} 條新規則、加權 ${bumped.length} 條${r.dropped.length ? `、擋下 ${r.dropped.length} 條衝突規則` : ''}`, { 新增: added.map(x => x.rule), 擋下: r.dropped })
  await saveRules(rules)

  const history = await loadHistory()
  history.unshift({
    postId: id,
    variantId: vid,
    platform: variant.platform,
    aiDraft,
    userFinal,
    at: new Date().toISOString()
  })
  await saveHistory(history)

  return {
    changed: true,
    summary: r.summary,
    rules: r.rules,
    added: added.map(x => x.rule),
    bumped: bumped.map(x => ({ rule: x.rule, weight: x.weight })),
    dropped: r.dropped,
    total: rules.length,
    model,
    usage
  }
})
