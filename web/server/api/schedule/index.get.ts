/** 排程清單。postId 可以只看某一則貼文的 */
export default defineEventHandler(async event => {
  const postId = String(getQuery(event).postId || '')
  const items = await loadSchedule()
  return {
    items: postId ? items.filter(x => x.postId === postId) : items,
    /** 本機排程要工具開著才會發，畫面上要講清楚 */
    needsAppRunning: true
  }
})
