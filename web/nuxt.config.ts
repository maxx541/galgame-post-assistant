export default defineNuxtConfig({
  compatibilityDate: '2026-08-29',
  devtools: { enabled: false },
  telemetry: false,
  ssr: true,
  css: ['~/assets/css/main.css'],
  devServer: { port: 4321 },
  runtimeConfig: {
    // 資料根目錄：預設為專案上一層的 data/，即 自動化貼文/data
    dataDir: process.env.POST_DATA_DIR || '',
    specFile: process.env.POST_SPEC_FILE || '',
    // LLM 端點設定：環境變數優先，否則讀 data/settings.json（設定頁可直接填）
    llmBaseUrl: process.env.LLM_BASE_URL || '',
    llmApiKey: process.env.LLM_API_KEY || '',
    llmModel: process.env.LLM_MODEL || ''
  },
  app: {
    head: {
      title: '貼文工作台',
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
      htmlAttrs: { lang: 'zh-Hant' }
    }
  },
  nitro: {
    // 允許上傳較大的圖片
    routeRules: {}
  }
})
