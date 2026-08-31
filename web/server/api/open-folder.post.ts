import { spawn } from 'node:child_process'
import { join } from 'node:path'

/**
 * 在檔案總管開啟貼文或素材的圖片資料夾。
 *
 * 這裡有兩個 Windows 的坑，都踩過：
 *
 * 1. `windowsHide: true` 會讓 explorer 開出來的**資料夾視窗本身也被隱藏** ——
 *    按了沒反應，但視窗其實已經產生了，連按幾次就堆一疊看不見的視窗
 *    （實測用 Shell.Application 列出來，堆了 20 個）。所以絕對不能加。
 * 2. explorer 把工作交給既有的 explorer.exe 之後就結束，**成功也回 exit code 1**，
 *    不能拿離開碼判斷成敗。
 *
 * 因為離開碼不可信，改用 spawn + detached 把它丟出去就好，不等它。
 * 真正會失敗的情況（資料夾不存在、找不到執行檔）在下面各自處理。
 */
export default defineEventHandler(async event => {
  const body = await readBody<{ kind?: 'post' | 'inbox'; id?: string; sub?: string }>(event)
  const id = safeSegment(body?.id || '')
  const base = body?.kind === 'inbox' ? inboxDir() : postsDir()
  const sub = body?.sub === '' ? '' : 'images'
  const dir = sub ? join(base, id, sub) : join(base, id)
  if (!(await exists(dir))) throw createError({ statusCode: 404, message: '資料夾不存在：' + dir })

  const cmd =
    process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'

  try {
    const child = spawn(cmd, [dir], { detached: true, stdio: 'ignore' })
    // 找不到執行檔這種真正的錯誤走 error 事件，不走離開碼
    child.on('error', e => logWarn('app', `開啟資料夾失敗：${(e as Error).message}`))
    child.unref()
  } catch (e) {
    throw createError({ statusCode: 500, message: '開不起檔案總管：' + (e as Error).message })
  }

  logInfo('app', '開啟資料夾 ' + dir)
  return { ok: true, dir }
})
