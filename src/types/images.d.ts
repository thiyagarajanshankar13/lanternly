// Image imports (Next resolves them at build time). Declared here because
// next-env.d.ts is generated and not committed, so CI type checks before it exists.
declare module '*.png' {
  const content: { src: string; height: number; width: number; blurDataURL?: string }
  export default content
}
