import { promises as fs } from 'node:fs'
import { join, dirname, basename } from 'node:path'

/**
 * 列表用的縮圖。原圖都是原尺寸存的，一張動輒幾 MB，列表一次載十幾張就很慢。
 *
 * 縮圖存在「貼文／素材資料夾/thumbs/」底下，跟原圖放在同一個資料夾裡，
 * 刪資料夾（手動或定期清理）時會一起消失，不用另外管。
 * 原圖被換掉就重做。
 *
 * sharp 是原生套件，舊的安裝可能還沒裝到 —— 載不到就直接回原圖，功能不壞只是慢。
 */

/** 只允許這幾種寬度，避免任意 ?w= 把硬碟塞滿各種尺寸 */
export const THUMB_WIDTHS = [240, 480, 800] as const

type Sharp = typeof import('sharp')
let sharpMod: Sharp | null | undefined

async function loadSharp(): Promise<Sharp | null> {
  if (sharpMod !== undefined) return sharpMod
  try {
    const m = await import('sharp')
    sharpMod = ((m as { default?: Sharp }).default || m) as Sharp
  } catch (e) {
    sharpMod = null
    logWarn('system', `縮圖套件 sharp 載入失敗，列表會直接用原圖：${(e as Error).message}`)
  }
  return sharpMod
}

/** 把要求的寬度換成最接近、且不小於它的允許寬度 */
export function pickThumbWidth(w: number): number {
  return THUMB_WIDTHS.find(x => x >= w) ?? THUMB_WIDTHS[THUMB_WIDTHS.length - 1]!
}

/** 做一張（或拿快取的）縮圖，回傳檔案路徑；做不出來回 null，由呼叫端改送原圖 */
export async function ensureThumb(src: string, width: number): Promise<string | null> {
  // src = <item>/images/<file>，縮圖放 <item>/thumbs/<file>.<w>.<原圖大小與時間>.webp
  // 用原圖的大小＋修改時間當檔名的一部分：圖被換掉就對不上，自然會重做。
  // 只比時間不夠 —— Windows 的 copyFile 會保留原檔的時間，換進來的圖可能比舊縮圖還「舊」
  const dir = join(dirname(dirname(src)), 'thumbs')
  const st = await fs.stat(src)
  const prefix = `${basename(src)}.${width}.`
  const out = join(dir, `${prefix}${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}.webp`)
  if (await exists(out)) return out

  const sharp = await loadSharp()
  if (!sharp) return null
  // 先寫暫存檔再改名，同時兩個請求做同一張也不會讀到寫一半的檔
  const tmp = `${out}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await ensureDir(dir)
    await sharp(src, { animated: false })
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 78 })
      .toFile(tmp)
    await fs.rename(tmp, out)
    // 同一張圖同尺寸的舊版縮圖清掉
    for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
      if (f.startsWith(prefix) && f.endsWith('.webp') && join(dir, f) !== out) await fs.rm(join(dir, f), { force: true }).catch(() => {})
    }
    return out
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    logWarn('system', `縮圖失敗，改用原圖：${basename(src)}：${(e as Error).message}`)
    return null
  }
}
