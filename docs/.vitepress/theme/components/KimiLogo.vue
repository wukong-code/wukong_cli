<script setup lang="ts">
import logoUrl from '../Kimi.png'

withDefaults(defineProps<{ size?: number }>(), { size: 56 })
</script>

<template>
  <img
    class="WukongLogo"
    :src="logoUrl"
    :width="size"
    :height="size"
    alt="Wukong"
  />
</template>

<style scoped>
.WukongLogo {
  display: block;
  object-fit: contain;
}
</style>
