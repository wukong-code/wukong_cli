<!-- apps/wukong-web/src/components/settings/Onboarding.vue -->
<!-- First-run onboarding overlay: a short welcome + the two preferences
     (language, theme). Both apply live. Re-openable from the settings popover.
     Preferences can be changed any time later, so there's nothing to "lose". -->
<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { availableLocales, setLocale, type LocaleCode } from '../../i18n';
import type { Theme } from '../../composables/useWukongWebClient';
import { useDialogFocus } from '../../composables/useDialogFocus';

const props = defineProps<{ theme: Theme }>();
const emit = defineEmits<{ setTheme: [theme: Theme]; complete: []; skip: [] }>();

const { t, locale } = useI18n();

function chooseLocale(code: LocaleCode): void {
  if (locale.value !== code) setLocale(code);
}

// Theme is chosen locally and only applied on "Get started".
const selectedTheme = ref<Theme>(props.theme);
const dialogRef = ref<HTMLElement | null>(null);

useDialogFocus(dialogRef);

function finish(): void {
  if (selectedTheme.value !== props.theme) emit('setTheme', selectedTheme.value);
  emit('complete');
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopImmediatePropagation();
  emit('skip');
}

onMounted(() => document.addEventListener('keydown', onKeydown));
onUnmounted(() => document.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="ob-backdrop">
    <div ref="dialogRef" class="ob-card" role="dialog" aria-modal="true" tabindex="-1" :aria-label="t('onboarding.title')">
      <button
        type="button"
        class="ob-close"
        :aria-label="t('onboarding.skip')"
        @click="emit('skip')"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8"/>
        </svg>
      </button>
      <div class="ob-brand">
        <img class="ob-logo" src="/wukong-logo.svg" alt="Wukong" />
        <div>
          <div class="ob-title">{{ t('onboarding.title') }}</div>
          <div class="ob-sub">{{ t('onboarding.subtitle') }}</div>
        </div>
      </div>

      <!-- Language -->
      <section class="ob-sec">
        <div class="ob-label">{{ t('onboarding.languageLabel') }}</div>
        <div class="ob-seg" role="group">
          <button
            v-for="opt in availableLocales"
            :key="opt.code"
            type="button"
            class="ob-seg-btn"
            :class="{ on: locale === opt.code }"
            :aria-pressed="locale === opt.code"
            @click="chooseLocale(opt.code)"
          >{{ opt.label }}</button>
        </div>
      </section>

      <!-- Theme -->
      <section class="ob-sec">
        <div class="ob-label">{{ t('onboarding.themeLabel') }}</div>
        <div class="ob-themes">
          <button
            type="button"
            class="ob-theme"
            :class="{ on: selectedTheme === 'modern' }"
            :aria-pressed="selectedTheme === 'modern'"
            @click="selectedTheme = 'modern'"
          >
            <span class="ob-theme-prev modern" aria-hidden="true">
              <span class="bub u"></span><span class="bub a"></span>
            </span>
            <span class="ob-theme-name">{{ t('theme.modern') }}</span>
            <span class="ob-theme-desc">{{ t('onboarding.modernDesc') }}</span>
          </button>
          <button
            type="button"
            class="ob-theme"
            :class="{ on: selectedTheme === 'wukong' }"
            :aria-pressed="selectedTheme === 'wukong'"
            @click="selectedTheme = 'wukong'"
          >
            <span class="ob-theme-prev wukong" aria-hidden="true">
              <span class="kb u"></span><span class="kb a"></span>
            </span>
            <span class="ob-theme-name">{{ t('theme.wukong') }}</span>
            <span class="ob-theme-desc">{{ t('onboarding.wukongDesc') }}</span>
          </button>
        </div>
      </section>

      <button type="button" class="ob-start" @click="finish">{{ t('onboarding.start') }}</button>
    </div>
  </div>
</template>

<style scoped>
.ob-backdrop {
  position: fixed;
  inset: 0;
  z-index: 500;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(20, 23, 28, 0.42);
  backdrop-filter: blur(3px);
}
.ob-card {
  position: relative;
  width: 100%;
  max-width: 440px;
  max-height: 92vh;
  overflow-y: auto;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 16px;
  box-shadow: 0 18px 50px rgba(20, 23, 28, 0.28);
  padding: 22px 22px 20px;
}
.ob-brand { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
.ob-logo {
  width: 52px; height: 52px; flex: none;
  object-fit: contain;
  image-rendering: pixelated;
}
.ob-title { color: var(--ink); font-size: var(--ui-font-size-xl); font-weight: 700; }
.ob-sub { color: var(--muted); font-size: var(--ui-font-size); margin-top: 1px; }

.ob-sec { margin-bottom: 16px; }
.ob-label { color: var(--dim); font-size: calc(var(--ui-font-size) - 2.5px); font-weight: 600; margin-bottom: 7px; }

/* segmented (language) */
.ob-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.ob-seg-btn {
  border: none; background: var(--bg); color: var(--muted);
  font-family: var(--mono); font-size: var(--ui-font-size-xs); padding: 6px 16px; cursor: pointer;
}
.ob-seg-btn + .ob-seg-btn { border-left: 1px solid var(--line); }
.ob-seg-btn.on { background: var(--soft); color: var(--blue2); font-weight: 600; }

/* theme cards */
.ob-themes { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.ob-theme {
  display: flex; flex-direction: column; gap: 4px; align-items: flex-start;
  border: 1px solid var(--line); border-radius: 12px; padding: 10px; cursor: pointer;
  background: var(--bg); text-align: left;
}
.ob-theme.on { border-color: var(--blue); box-shadow: inset 0 0 0 1px var(--blue); }
.ob-theme-prev {
  width: 100%; height: 52px; border-radius: 8px; overflow: hidden;
  display: flex; flex-direction: column; gap: 4px; padding: 8px; margin-bottom: 2px;
}
.ob-theme-prev.modern { background: var(--panel2); align-items: stretch; }
.ob-theme-prev.modern .bub { height: 14px; border-radius: 7px; }
.ob-theme-prev.modern .bub.u { width: 60%; align-self: flex-end; background: var(--bluebg); border: 1px solid var(--blueln); }
.ob-theme-prev.modern .bub.a { width: 80%; background: var(--bg); border: 1px solid var(--line); }
/* Wukong: flat white canvas, quiet gray bubbles, no blue. color-mix keeps the
   sketch readable in both color schemes without theme-specific values. */
.ob-theme-prev.wukong { background: var(--bg); border: 1px solid var(--line); box-sizing: border-box; align-items: stretch; }
.ob-theme-prev.wukong .kb { height: 14px; border-radius: 7px; }
.ob-theme-prev.wukong .kb.u { width: 60%; align-self: flex-end; background: color-mix(in srgb, var(--ink) 8%, var(--bg)); }
.ob-theme-prev.wukong .kb.a { width: 80%; background: color-mix(in srgb, var(--ink) 4%, var(--bg)); }
.ob-theme-name { color: var(--ink); font-size: calc(var(--ui-font-size) - 1.5px); font-weight: 600; }
.ob-theme-desc { color: var(--muted); font-size: max(9px, calc(var(--ui-font-size) - 3.5px)); line-height: 1.4; }

.ob-start {
  width: 100%; margin-top: 6px;
  background: var(--blue); color: var(--bg); border: none; border-radius: 10px;
  font-size: calc(var(--ui-font-size) - 0.5px); font-weight: 600; padding: 11px; cursor: pointer;
}
.ob-start:hover { background: var(--blue2); }

.ob-close {
  position: absolute; top: 14px; right: 14px;
  display: flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; border-radius: 8px;
  background: transparent; color: var(--muted); border: none;
  cursor: pointer;
}
.ob-close:hover { background: var(--soft); color: var(--ink); }

@media (max-width: 480px) {
  .ob-themes { grid-template-columns: 1fr; }
}
</style>
