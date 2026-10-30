/** 照目前的設定立刻清一次（不管有沒有開啟定期清理） */
export default defineEventHandler(async () => {
  return await runCleanup('manual')
})
