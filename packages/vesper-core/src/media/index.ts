// @vesper/core — media helpers (dependency-free QR encoding + terminal rendering).

export {
  type EncodeQrOptions,
  encodeQr,
  type QrEcc,
  type QrMatrix,
  readModule,
} from "./qr.ts";
export { renderQrTerminal } from "./qr-terminal.ts";
