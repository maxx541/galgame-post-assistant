/** 清理設定 + 如果現在清會刪掉哪些（預覽） */
export default defineEventHandler(async () => {
  const s = await loadCleanupSettings()
  const targets = await findCleanupTargets(s)
  return {
    ...s,
    nextAt: nextCleanupAt(s),
    preview: {
      posts: targets.filter(t => t.kind === 'posts'),
      inbox: targets.filter(t => t.kind === 'inbox')
    },
    usage: { posts: await dirSize(postsDir()), inbox: await dirSize(inboxDir()) }
  }
})
