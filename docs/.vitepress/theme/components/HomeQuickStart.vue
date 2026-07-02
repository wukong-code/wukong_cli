<script setup lang="ts">
import { useData, withBase } from 'vitepress'
import { computed, ref } from 'vue'

const { lang } = useData()
const isZh = computed(() => lang.value.startsWith('zh'))

const installMacCommand = 'pnpm install'
const installWinCommand = 'pnpm install'
const runCommand = 'pnpm dev:cli'

const copy = computed(() => isZh.value
  ? {
      title: '一行命令开始',
      lede: '当前仓库使用源码方式运行，verify / scan / guard 已作为 P0 命令可用。',
      macLabel: '安装依赖',
      winLabel: 'Windows 安装依赖',
      runLabel: '启动开发 CLI',
      copyHint: '复制',
      copiedHint: '已复制',
      ctaText: '查看当前用户指南',
      ctaHref: '/user-guide',
    }
  : {
      title: 'Run from source',
      lede: 'The current repository runs from source; verify / scan / guard are available as P0 commands.',
      macLabel: 'Install dependencies',
      winLabel: 'Install dependencies on Windows',
      runLabel: 'Start the dev CLI',
      copyHint: 'Copy',
      copiedHint: 'Copied',
      ctaText: 'Read the current user guide',
      ctaHref: '/user-guide',
    })

const copiedKey = ref<string | null>(null)
let copiedTimer: ReturnType<typeof setTimeout> | null = null

function copyText(value: string, key: string) {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return
  navigator.clipboard.writeText(value).then(() => {
    copiedKey.value = key
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copiedKey.value = null }, 1600)
  })
}
</script>

<template>
  <section class="WukongHome__section WukongQuick">
    <h2 class="WukongHome__sectionTitle">{{ copy.title }}</h2>
    <p class="WukongHome__sectionLede">{{ copy.lede }}</p>

    <div class="WukongQuick__installs">
      <div class="WukongQuick__block">
        <div class="WukongQuick__label">{{ copy.macLabel }}</div>
        <div class="WukongQuick__cmd">
          <code><span class="WukongQuick__prompt">$</span> {{ installMacCommand }}</code>
          <button
            type="button"
            class="WukongQuick__copy"
            @click="copyText(installMacCommand, 'mac')"
            :aria-label="copy.copyHint"
          >
            <template v-if="copiedKey === 'mac'">{{ copy.copiedHint }}</template>
            <template v-else>{{ copy.copyHint }}</template>
          </button>
        </div>
      </div>

      <div class="WukongQuick__block">
        <div class="WukongQuick__label">{{ copy.winLabel }}</div>
        <div class="WukongQuick__cmd">
          <code><span class="WukongQuick__prompt">PS&gt;</span> {{ installWinCommand }}</code>
          <button
            type="button"
            class="WukongQuick__copy"
            @click="copyText(installWinCommand, 'win')"
            :aria-label="copy.copyHint"
          >
            <template v-if="copiedKey === 'win'">{{ copy.copiedHint }}</template>
            <template v-else>{{ copy.copyHint }}</template>
          </button>
        </div>
      </div>
    </div>

    <div class="WukongQuick__block WukongQuick__block--run">
      <div class="WukongQuick__label">{{ copy.runLabel }}</div>
      <div class="WukongQuick__cmd">
        <code><span class="WukongQuick__prompt">$</span> {{ runCommand }}</code>
        <button
          type="button"
          class="WukongQuick__copy"
          @click="copyText(runCommand, 'run')"
          :aria-label="copy.copyHint"
        >
          <template v-if="copiedKey === 'run'">{{ copy.copiedHint }}</template>
          <template v-else>{{ copy.copyHint }}</template>
        </button>
      </div>
    </div>

    <a class="WukongQuick__more" :href="withBase(copy.ctaHref)">
      {{ copy.ctaText }}
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </a>
  </section>
</template>

<style scoped>
.WukongQuick__installs {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-bottom: 16px;
}

.WukongQuick__block {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.WukongQuick__block--run {
  margin-bottom: 28px;
}

.WukongQuick__label {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--vp-c-text-3);
}

.WukongQuick__cmd {
  position: relative;
  display: flex;
  align-items: center;
  padding: 18px 22px;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--wukong-radius-code);
  font-family: var(--vp-font-family-mono);
  font-size: 14.5px;
  line-height: 1.4;
  color: var(--vp-c-text-1);
  overflow: hidden;
  transition: border-color var(--wukong-transition), box-shadow var(--wukong-transition);
}
.WukongQuick__cmd:hover {
  border-color: var(--vp-c-brand-1);
  box-shadow: var(--vp-shadow-2);
}
.WukongQuick__cmd code {
  flex: 1;
  white-space: pre;
  overflow-x: auto;
  background: transparent !important;
  color: inherit;
  padding: 0;
  font-size: inherit;
  font-family: inherit;
  border-radius: 0;
}
.WukongQuick__prompt {
  color: var(--vp-c-brand-1);
  margin-right: 8px;
  user-select: none;
  font-weight: 600;
}

.WukongQuick__copy {
  flex: none;
  margin-left: 12px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  font-family: var(--vp-font-family-base);
  letter-spacing: 0.01em;
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  cursor: pointer;
  transition: color var(--wukong-transition), border-color var(--wukong-transition), background var(--wukong-transition);
}
.WukongQuick__copy:hover {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
}

.WukongQuick__more {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 15px;
  font-weight: 600;
  color: var(--vp-c-brand-1);
  text-decoration: none;
  transition: transform var(--wukong-transition), color var(--wukong-transition);
}
.WukongQuick__more:hover {
  color: var(--vp-c-brand-2);
  transform: translateX(3px);
}
</style>
