declare module 'qrcode-svg' {
  interface QRCodeOptions {
    content: string
    padding?: number
    width?: number
    height?: number
    /** `svg-viewbox`: sized by its viewBox alone, so CSS can scale it. */
    container?: 'svg' | 'svg-viewbox' | 'g'
    /** One path for every module rather than a rect each. */
    join?: boolean
    xmlDeclaration?: boolean
  }
  export default class QRCode {
    constructor(options: QRCodeOptions)
    /** The code itself: its size in modules, which its version sets, and each module. */
    readonly qrcode: { getModuleCount(): number; isDark(row: number, col: number): boolean }
    svg(): string
  }
}
