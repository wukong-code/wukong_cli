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
  description: 'Wukong Code documentation, user guide, and release notes',
  ignoreDeadLinks: true,

  head: [
    ['link', { rel: 'icon', type: 'image/x-icon', href: `${base}favicon.ico` }],
    ['meta', { name: 'theme-color', content: '#0a7aff' }],
  ],

  srcExclude: ['AGENTS.md', 'superpowers/**'],

  locales: {
    root: {
      label: 'English',
      lang: 'en-US',
      themeConfig: {
        nav: [
          { text: 'User Guide', link: '/user-guide' },
          { text: 'Releases', link: 'https://github.com/wukong-code/wukong-code/releases' },
          { text: 'Updates & Announcements', link: '/operations/updates-and-announcements' },
          { text: '中文文档', link: '/zh/' },
        ],
        sidebar: [
          {
            text: 'Getting Started',
            items: [
              { text: 'Documentation Index', link: '/' },
              { text: 'User Guide', link: '/user-guide' },
              { text: 'CLI Use and Risk Notice', link: '/CLI-USE-AND-RISK' },
              { text: 'Architecture', link: '/tech/architecture' },
              { text: 'Cross-Agent Session Resume', link: '/design/cross-agent-resume' },
            ],
          },
          {
            text: 'Releases & Operations',
            items: [
              { text: '0.1.2 Open-Source Edition (Current)', link: '/releases/0.1.2' },
              { text: 'GitHub Releases', link: 'https://github.com/wukong-code/wukong-code/releases' },
              { text: 'Updates and Announcements Contract', link: '/operations/updates-and-announcements' },
              { text: 'CLI Telemetry Contract', link: '/operations/cli-telemetry' },
            ],
          },
          {
            text: 'Version Plans & Internal Records (Chinese)',
            items: [
              { text: '0.1.2 First Success Plan', link: '/design/0.1.2-first-success-and-surface-simplification' },
              { text: '0.1.0 Trusted Local Loop (Released)', link: '/design/0.1.0-trusted-local-loop' },
              { text: '0.0.21 Loop Evidence Integrity (Released)', link: '/design/0.0.21-loop-evidence-integrity' },
              { text: 'Verification CLI Test Plan', link: '/test/verification-cli-test-plan' },
              { text: 'Archived design and research notes', link: '/design/design' },
            ],
          },
        ],
      },
    },
    zh: {
      label: '简体中文',
      lang: 'zh-CN',
      link: '/zh/',
      themeConfig: {
        nav: [
          { text: '用户指南', link: '/zh/user-guide' },
          { text: '更新与公告', link: '/zh/operations/updates-and-announcements' },
          { text: 'English Docs', link: '/' },
        ],
        sidebar: [
          {
            text: '开始使用',
            items: [
              { text: '文档首页', link: '/zh/' },
              { text: '用户指南', link: '/zh/user-guide' },
              { text: '技术架构', link: '/tech/architecture' },
              { text: 'Cross-Agent Resume', link: '/design/cross-agent-resume' },
              { text: '自动化测试计划', link: '/test/verification-cli-test-plan' },
            ],
          },
          {
            text: '版本发布说明',
            items: [
              { text: '0.1.2 开源发布版', link: '/zh/releases/0.1.2' },
              { text: '0.1.1 Reliability And Trust Boundary', link: '/zh/releases/0.1.1' },
              { text: '0.1.0 Trusted Local Loop', link: '/zh/releases/0.1.0' },
              { text: '全部历史版本', link: '/zh/releases/0.0.22' },
            ],
          },
          {
            text: '运维契约',
            items: [
              { text: 'CLI 更新与公告契约', link: '/zh/operations/updates-and-announcements' },
              { text: 'CLI telemetry 契约', link: '/zh/operations/cli-telemetry' },
            ],
          },
          {
            text: '版本设计与历史研究',
            items: [
              { text: '0.1.2 首次成功与表面收敛', link: '/design/0.1.2-first-success-and-surface-simplification' },
              { text: '0.1.0 Trusted Local Loop 设计', link: '/design/0.1.0-trusted-local-loop' },
              { text: '历史设计索引', link: '/design/design' },
            ],
          },
        ],
      },
    },
  },

  themeConfig: {
    outline: [2, 3],
    search: { provider: 'local' },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/wukong-code/wukong_cli' },
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
