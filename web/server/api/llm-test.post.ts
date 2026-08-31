/** 連線測試：列出端點提供的模型，順便驗金鑰與 Base URL 是否正確 */
export default defineEventHandler(async () => {
  const s = await loadSettings()
  if (!s.apiKey) throw createError({ statusCode: 400, message: '還沒填 API 金鑰' })
  const models = await listModels(s)
  return {
    ok: true,
    endpoint: endpointFor(s.baseUrl, 'models'),
    count: models.length,
    models: models.slice(0, 200),
    currentModelFound: models.includes(s.model)
  }
})
