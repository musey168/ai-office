/**
 * The upstream main-process modules import assets with electron-vite's
 * `?asset` suffix and a couple of untyped packages. The worker build resolves
 * both; these declarations keep the type check honest about it.
 */
declare module '*?asset' {
  const path: string
  export default path
}

declare module 'bidi-js' {
  /** The package's default export is the factory the upstream code calls. */
  const bidi: (...args: unknown[]) => {
    getEmbeddingLevels(
      text: string,
      direction?: string,
    ): { levels: number[]; paragraphs: { start: number; end: number }[] }
    getReorderSegments(
      embeddingLevels: number[],
      paragraphs: { start: number; end: number }[],
      start: number,
      end: number,
    ): number[][]
  }
  export default bidi
}

declare namespace NodeJS {
  interface Process {
    /** The Electron resources directory; the worker points it at its own. */
    resourcesPath: string
  }
}
