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
  description: 'Current Wukong CLI documentation and commercial refactor plan',
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
      { text: 'Commercial Plan', link: '/business/COMMERCIAL_REFACTOR_PLAN' },
      { text: 'Architecture', link: '/tech/architecture' },
      { text: 'Technical Plan', link: '/tech/commercial-refactor-implementation' },
      { text: 'Design', link: '/design/design' },
      { text: 'Test Plan', link: '/test/verification-cli-test-plan' },
    ],
    sidebar: [
      {
        text: 'Current',
        items: [
          { text: 'Documentation Index', link: '/' },
          { text: 'User Guide', link: '/user-guide' },
        ],
      },
      {
        text: 'Commercial Refactor',
        items: [
          { text: 'Commercial Plan', link: '/business/COMMERCIAL_REFACTOR_PLAN' },
          { text: 'Architecture', link: '/tech/architecture' },
          { text: 'Technical Plan', link: '/tech/commercial-refactor-implementation' },
          { text: 'Product Design', link: '/design/design' },
          { text: 'Verification CLI Test Plan', link: '/test/verification-cli-test-plan' },
          { text: 'Login and Sync Test Plan', link: '/test/test-login-sync' },
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
