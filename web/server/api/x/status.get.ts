export default defineEventHandler(async event => {
  // 預設讀快取檔（快、不開瀏覽器）；?deep=1 才真的啟動 Chromium 驗證
  const deep = getQuery(event).deep === '1'
  return await xStatus(deep)
})
