<script setup lang="ts">
import { useData, withBase } from 'vitepress'
import { computed } from 'vue'

const { lang } = useData()
const isZh = computed(() => lang.value.startsWith('zh'))

interface Highlight {
  icon: string
  title: string
  desc: string
}

interface Feature {
  icon: string
  title: string
  desc: string
  href: string
}

const highlights = computed<Highlight[]>(() => isZh.value
  ? [
      {
        icon: '⚡',
        title: '当前 CLI 底座',
        desc: '交互式 TUI、prompt mode、provider、ACP、server/web、doctor 等能力已经在新 base 中存在。',
      },
      {
        icon: '🔍',
        title: '验证工具方向',
        desc: 'verify、scan、guard 已作为 P0 命令实现，agent tool 和云端能力继续作为后续计划。',
      },
      {
        icon: '🧭',
        title: '单一技术方案',
        desc: '旧 tech 文档已删除，当前只保留商业化重构技术实现方案。',
      },
    ]
  : [
      {
        icon: '⚡',
        title: 'Current CLI base',
        desc: 'The new base already includes TUI, prompt mode, provider, ACP, server/web, and doctor commands.',
      },
      {
        icon: '🔍',
        title: 'Verification direction',
        desc: 'verify, scan, and guard are implemented P0 commands; agent tools and cloud features remain planned.',
      },
      {
        icon: '🧭',
        title: 'Single technical plan',
        desc: 'Old tech docs were removed; the commercial refactor implementation plan is now the active tech doc.',
      },
    ])

const features = computed<Feature[]>(() => isZh.value
  ? [
      {
        icon: '🧩',
        title: '用户指南',
        desc: '当前可执行命令、源码运行方式、本地数据位置和常见误区。',
        href: '/user-guide',
      },
      {
        icon: '📐',
        title: '商业方案',
        desc: '产品定位、目标命令结构、商业模型和优先级。',
        href: '/business/COMMERCIAL_REFACTOR_PLAN',
      },
      {
        icon: '🛠️',
        title: '技术方案',
        desc: 'verification package、CLI 命令、guard 和 agent tool 的落地方案。',
        href: '/tech/commercial-refactor-implementation',
      },
      {
        icon: '✅',
        title: '验收计划',
        desc: '登录与同步进入实现阶段前的测试边界。',
        href: '/test/test-login-sync',
      }
    ]
  : [
      {
        icon: '🧩',
        title: 'User Guide',
        desc: 'Current executable commands, source workflow, local data paths, and common pitfalls.',
        href: '/user-guide',
      },
      {
        icon: '📐',
        title: 'Commercial Plan',
        desc: 'Product positioning, target command structure, business model, and priorities.',
        href: '/business/COMMERCIAL_REFACTOR_PLAN',
      },
      {
        icon: '🛠️',
        title: 'Technical Plan',
        desc: 'Implementation plan for the verification package, CLI commands, guard, and agent tool.',
        href: '/tech/commercial-refactor-implementation',
      },
      {
        icon: '✅',
        title: 'Acceptance Plan',
        desc: 'Login and sync test boundaries before those features enter implementation.',
        href: '/test/test-login-sync',
      }
    ])

const highlightsTitle = computed(() => isZh.value ? '开箱即得' : 'Ready out of the box')
const highlightsLede = computed(() => isZh.value
  ? '装好就能用，关键能力默认就绪。'
  : 'Install once. The essentials are already there.')

const featuresTitle = computed(() => isZh.value ? '按需扩展' : 'Extend it your way')
const featuresLede = computed(() => isZh.value
  ? '内置可编程的扩展点，按自己的方式塑造工作流。'
  : 'Programmable extension points to shape the workflow around you.')

const ctaText = computed(() => isZh.value ? '了解' : 'Learn more')
</script>

<template>
  <section class="WukongHome__section WukongHighlights">
    <h2 class="WukongHome__sectionTitle">{{ highlightsTitle }}</h2>
    <p class="WukongHome__sectionLede">{{ highlightsLede }}</p>
    <div class="WukongHighlights__grid">
      <div
        v-for="h in highlights"
        :key="h.title"
        class="WukongHighlights__card"
      >
        <div class="WukongHighlights__icon" aria-hidden="true">{{ h.icon }}</div>
        <h3 class="WukongHighlights__title">{{ h.title }}</h3>
        <p class="WukongHighlights__desc">{{ h.desc }}</p>
      </div>
    </div>
  </section>

  <section class="WukongHome__section WukongFeatures">
    <h2 class="WukongHome__sectionTitle">{{ featuresTitle }}</h2>
    <p class="WukongHome__sectionLede">{{ featuresLede }}</p>
    <div class="WukongFeatures__grid">
      <a
        v-for="f in features"
        :key="f.title"
        class="WukongFeatures__card"
        :href="withBase(f.href)"
      >
        <div class="WukongFeatures__icon" aria-hidden="true">{{ f.icon }}</div>
        <h3 class="WukongFeatures__title">{{ f.title }}</h3>
        <p class="WukongFeatures__desc">{{ f.desc }}</p>
        <span class="WukongFeatures__cta">
          {{ ctaText }}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
      </a>
    </div>
  </section>
</template>

<style scoped>
/* === Highlights (top section: non-clickable product attributes) === */
.WukongHighlights__grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}

@media (max-width: 720px) {
  .WukongHighlights__grid {
    grid-template-columns: 1fr;
  }
}

.WukongHighlights__card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding: 22px 22px 24px;
  border-radius: var(--wukong-radius-card);
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
}

.WukongHighlights__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: var(--wukong-brand-soft);
  font-size: 18px;
  margin-bottom: 14px;
}

.WukongHighlights__title {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.01em;
  margin: 0 0 6px;
  color: var(--vp-c-text-1);
}

.WukongHighlights__desc {
  font-size: 14px;
  line-height: 1.55;
  color: var(--vp-c-text-2);
  margin: 0;
}

/* === Features (bottom section: clickable extension points) === */
.WukongFeatures__grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 20px;
}

@media (max-width: 1024px) {
  .WukongFeatures__grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 640px) {
  .WukongFeatures__grid {
    grid-template-columns: 1fr;
  }
}

.WukongFeatures__card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding: 28px 24px 26px;
  border-radius: var(--wukong-radius-card);
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  text-decoration: none;
  transition: transform var(--wukong-transition), border-color var(--wukong-transition),
              box-shadow var(--wukong-transition), background var(--wukong-transition);
  overflow: hidden;
}

.WukongFeatures__card::before {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--wukong-brand-gradient-soft);
  opacity: 0;
  transition: opacity var(--wukong-transition);
  pointer-events: none;
  border-radius: inherit;
}

.WukongFeatures__card:hover {
  transform: translateY(-3px);
  border-color: var(--vp-c-brand-1);
  box-shadow: var(--vp-shadow-3);
}
.WukongFeatures__card:hover::before {
  opacity: 1;
}

.WukongFeatures__icon {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: var(--wukong-brand-soft);
  font-size: 22px;
  margin-bottom: 18px;
}

.WukongFeatures__title {
  position: relative;
  z-index: 1;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.015em;
  margin: 0 0 8px;
  color: var(--vp-c-text-1);
}

.WukongFeatures__desc {
  position: relative;
  z-index: 1;
  font-size: 14.5px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
  margin: 0 0 20px;
}

.WukongFeatures__cta {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--vp-c-brand-1);
  margin-top: auto;
  transition: transform var(--wukong-transition);
}

.WukongFeatures__card:hover .WukongFeatures__cta {
  transform: translateX(3px);
}
</style>
