<!-- apps/wukong-web/src/components/GlobalLoading.vue -->
<!-- Full-screen splash shown on first load until the client has talked to the
     daemon, so a page refresh doesn't flash a half-rendered, not-yet-connected
     app. Hidden once useWukongWebClient.initialized flips true. -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
const { t } = useI18n();
</script>

<template>
  <div class="gload" role="status" :aria-label="t('app.connecting')">
    <div class="gload-box">
      <img class="gload-logo" src="/wukong-logo.svg" alt="" aria-hidden="true" />
      <div class="gload-bar" aria-hidden="true"><span class="gload-bar-fill"></span></div>
      <div class="gload-text">{{ t('app.connecting') }}</div>
    </div>
  </div>
</template>

<style scoped>
.gload {
  position: fixed;
  top: 0;
  left: 0;
  /* Viewport units for size + position so the splash always fills the screen,
     even if a transformed/collapsed <html> would otherwise shrink a fixed box. */
  width: 100vw;
  height: 100vh;
  height: 100dvh;
  min-width: 100vw;
  min-height: 100dvh;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg);
}
.gload-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 22px;
  /* nudge slightly above center — feels more intentional than dead-center */
  transform: translateY(-6%);
}
.gload-logo {
  width: 64px;
  height: 64px;
  object-fit: contain;
  image-rendering: pixelated;
  animation: gload-pop 0.55s cubic-bezier(0.22, 1, 0.36, 1) both;
}
/* slim indeterminate progress bar */
.gload-bar {
  width: 150px;
  height: 3px;
  border-radius: 3px;
  background: var(--line);
  overflow: hidden;
  position: relative;
}
.gload-bar-fill {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  width: 40%;
  border-radius: 3px;
  background: var(--blue);
  animation: gload-slide 1.1s ease-in-out infinite;
}
.gload-text {
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 2.5px);
  color: var(--muted);
  letter-spacing: 0.04em;
}
@keyframes gload-pop {
  from { opacity: 0; transform: translateY(6px) scale(0.96); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes gload-slide {
  0% { left: -42%; }
  100% { left: 102%; }
}
@media (prefers-reduced-motion: reduce) {
  .gload-logo { animation: none; }
  .gload-bar-fill { animation-duration: 2.4s; }
}
</style>
