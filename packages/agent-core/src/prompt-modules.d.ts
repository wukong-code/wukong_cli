// Raw-string imports for prompt sources. Vite/Vitest handles `?raw` natively;
// tsdown resolves the query through the shared build-support adapter and then
// uses Rolldown's built-in text module type for the same import shape.

declare module '*?raw' {
  const content: string;
  export default content;
}
