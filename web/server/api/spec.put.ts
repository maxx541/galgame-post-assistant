import { promises as fs } from 'node:fs'

/** 規範可以直接在前端改。存檔前先備份一份 .bak，改壞救得回來 */
export default defineEventHandler(async event => {
  const body = await readBody<{ content?: string }>(event)
  const content = String(body?.content ?? '')
  if (!content.trim()) throw createError({ statusCode: 400, message: '規範內容不能是空的' })
  const p = specPath()
  if (await exists(p)) {
    await fs.copyFile(p, p + '.bak')
  }
  await fs.writeFile(p, content.replace(/\r\n/g, '\n'), 'utf8')
  return { ok: true, path: p, bytes: Buffer.byteLength(content, 'utf8') }
})
