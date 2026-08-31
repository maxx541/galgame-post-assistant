/** 連線測試：看得到哪些日報頁、最新一頁能解析出幾則 */
export default defineEventHandler(async () => {
  const n = await loadNotionSettings()
  if (!n.token) throw createError({ statusCode: 400, message: '還沒填 Notion token' })
  return await testNotion(n)
})
