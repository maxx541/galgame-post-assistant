export default defineEventHandler(async () => {
  const s = await loadSettings()
  // 永遠不回傳金鑰本身
  return {
    baseUrl: s.baseUrl,
    model: s.model,
    sendImages: s.sendImages,
    hasKey: !!s.apiKey,
    source: s.source,
    defaults: { baseUrl: DEFAULT_BASE_URL, model: DEFAULT_MODEL },
    endpoint: endpointFor(s.baseUrl, 'chat/completions')
  }
})
