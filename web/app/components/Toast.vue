<template>
  <div class="toasts">
    <div v-for="i in items" :key="i.id" class="toast" :class="i.kind">{{ i.text }}</div>
  </div>
</template>

<script setup lang="ts">
const { items } = useToast()
</script>

<style scoped>
.toasts {
  position: fixed;
  right: 18px;
  bottom: 18px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 200;
  pointer-events: none;
}
.toast {
  background: var(--text);
  color: var(--bg);
  padding: 9px 15px;
  border-radius: 8px;
  font-size: 14px;
  box-shadow: var(--shadow);
  max-width: 380px;
}
.toast.err { background: var(--err); color: #fff; }
</style>
