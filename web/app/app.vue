<template>
  <div class="app">
    <header class="topbar">
      <span class="brand">貼文工作台</span>
      <nav>
        <NuxtLink to="/">貼文</NuxtLink>
        <NuxtLink to="/discover">發掘</NuxtLink>
        <NuxtLink to="/inbox">素材夾</NuxtLink>
        <NuxtLink to="/spec">撰寫規範</NuxtLink>
        <NuxtLink to="/logs">記錄</NuxtLink>
        <NuxtLink to="/settings">設定</NuxtLink>
      </nav>
      <span class="spacer" />
      <span class="tiny faint">GalGame文化同好會</span>
    </header>
    <NuxtPage />
    <Toast />
  </div>
</template>

<script setup lang="ts">
useHead({ title: '貼文工作台' })
</script>
