declare module 'qrcode-svg' {
  interface QRCodeOptions {
    content: string
    padding?: number
    width?: number
    height?: number
  }
  export default class QRCode {
    constructor(options: QRCodeOptions)
    svg(): string
  }
}
