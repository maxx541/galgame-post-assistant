export interface ToastItem { id: number; text: string; kind: 'ok' | 'err' }

export function useToast() {
  const items = useState<ToastItem[]>('toasts', () => [])
  const seq = useState<number>('toastSeq', () => 1)

  function push(text: string, kind: 'ok' | 'err' = 'ok') {
    const id = seq.value++
    items.value = [...items.value, { id, text, kind }]
    if (import.meta.client) {
      setTimeout(() => {
        items.value = items.value.filter(i => i.id !== id)
      }, kind === 'err' ? 5200 : 2400)
    }
  }

  return {
    items,
    toast: (t: string) => push(t, 'ok'),
    toastErr: (t: string) => push(t, 'err')
  }
}
