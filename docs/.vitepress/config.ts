import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import llmstxt from 'vitepress-plugin-llms'

const rawBase = process.env.VITEPRESS_BASE
const base = rawBase
  ? rawBase.startsWith('/')
    ? rawBase.endsWith('/') ? rawBase : `${rawBase}/`
    : `/${rawBase}/`
  : '/'

const mermaidOptimizeDeps = [
  '@braintree/sanitize-url',
  'dayjs',
  'debug',
  'cytoscape-cose-bilkent',
  'cytoscape',
]

const config = withMermaid(defineConfig({
  base,
  title: 'Wukong CLI Docs',
  description: 'Current Wukong Code documentation, version plans, and historical research',
  ignoreDeadLinks: true,

  head: [
    ['link', { rel: 'icon', type: 'image/x-icon', href: `${base}favicon.ico` }],
    ['meta', { name: 'theme-color', content: '#0a7aff' }],
  ],

  srcExclude: ['AGENTS.md', 'superpowers/**'],

  themeConfig: {
    outline: [2, 3],
    search: { provider: 'local' },
    nav: [
      { text: 'User Guide', link: '/user-guide' },
      { text: '0.0.21 RC', link: '/design/0.0.21-loop-evidence-integrity' },
      { text: 'Architecture', link: '/tech/architecture' },
      { text: 'Updates & Announcements', link: '/operations/updates-and-announcements' },
      { text: 'Test Plan', link: '/test/verification-cli-test-plan' },
    ],
    sidebar: [
      {
        text: 'Current',
        items: [
          { text: 'Documentation Index', link: '/' },
          { text: 'User Guide', link: '/user-guide' },
          { text: 'Architecture', link: '/tech/architecture' },
          { text: 'Cross-Agent Session Resume', link: '/design/cross-agent-resume' },
          { text: 'Verification CLI Test Plan', link: '/test/verification-cli-test-plan' },
          { text: 'CLI 更新与公告', link: '/operations/updates-and-announcements' },
        ],
      },
      {
        text: 'Version Plans',
        items: [
          { text: '0.0.19 Explicit Finish Line (Released)', link: '/design/0.0.19-explicit-finish-line' },
          { text: '0.0.20 Reusable Verification Criteria (Released)', link: '/design/0.0.20-reusable-verification-skills' },
          { text: '0.0.21 Loop Evidence Integrity (Released)', link: '/design/0.0.21-loop-evidence-integrity' },
          { text: '0.1.0 Trusted Local Loop (In Development)', link: '/design/0.1.0-trusted-local-loop' },
          { text: '0.2.0 Reliable Autonomy (Needs Replan)', link: '/design/0.2.0-pro-reliable-autonomy' },
        ],
      },
      {
        text: 'Historical Product & Commercial Research',
        items: [
          { text: 'Canceled 0.0.21 Isolated Loop Worktrees', link: '/design/0.0.21-isolated-loop-worktrees' },
          { text: 'Old Bounded Parallel Loop', link: '/design/0.2.0-bounded-parallel-loop' },
          { text: 'Old Local Loop Supervisor', link: '/design/0.2.0-local-loop-supervisor' },
          { text: 'Archived Pro PR Gate + Billing', link: '/design/historical-pro-pr-gate-billing' },
          { text: 'Commercial Plan (Historical)', link: '/business/COMMERCIAL_REFACTOR_PLAN' },
          { text: 'Wukong Capability Model (Historical)', link: '/business/WUKONG_CAPABILITY_MODEL' },
          { text: 'Technical Plan (Historical)', link: '/tech/commercial-refactor-implementation' },
          { text: 'Product Design (Historical)', link: '/design/design' },
          { text: 'Login and Sync Test Plan (Historical)', link: '/test/test-login-sync' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/mutnpc/wukong_cli' },
    ],
  },

  vite: {
    optimizeDeps: {
      include: mermaidOptimizeDeps.map((dep) => `mermaid > ${dep}`),
    },
    plugins: [llmstxt()],
  },
}))

if (config.vite?.optimizeDeps?.include) {
  config.vite.optimizeDeps.include = config.vite.optimizeDeps.include.filter(
    (dep) => !mermaidOptimizeDeps.includes(dep),
  )
}

export default config
