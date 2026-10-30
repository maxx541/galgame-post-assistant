import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/**
 * 批量刪除素材。整個資料夾一起刪掉（圖片也在裡面），不留空殼佔硬碟。
 *
 * mode:
 *   ids     只刪指定的幾則
 *   written 已經撰寫過的都刪（貼文已經生出來了，素材留著只是佔空間）
 *   all     全部清掉
 */
export default defineEventHandler(async event => {
  const body = await readBody<{ mode?: string; ids?: string[] }>(event)
  const mode = body?.mode === 'written' || body?.mode === 'all' ? body.mode : 'ids'

  let targets: string[]
  if (mode === 'ids') {
    targets = (body?.ids || []).map(x => safeSegment(String(x))).filter(Boolean)
    if (!targets.length) throw createError({ statusCode: 400, message: '沒有指定要刪除的素材' })
  } else {
    const all = await listMaterials()
    targets = all.filter(m => mode === 'all' || m.written).map(m => m.id)
  }

  let deleted = 0
  let bytes = 0
  const failed: { id: string; message: string }[] = []

  for (const id of targets) {
    const dir = join(inboxDir(), id)
    try {
      if (!(await exists(dir))) continue
      bytes += await dirSize(dir)
      await fs.rm(dir, { recursive: true, force: true })
      deleted++
    } catch (e) {
      failed.push({ id, message: (e as Error).message })
    }
  }

  logOk('material', `批量刪除素材 ${deleted} 則，釋出 ${(bytes / 1048576).toFixed(1)}MB`)
  return { deleted, bytes, failed, requested: targets.length }
})

