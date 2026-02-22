import dotenv from 'dotenv'
import path from 'node:path'

// 依序嘗試載入：
// 1) 當前工作目錄 .env（npm workspace 執行時通常是 apps/api）
// 2) 上一層 .env（專案根目錄）
// 3) 上兩層 .env（保險）
dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: false })
dotenv.config({ path: path.resolve(process.cwd(), '../.env'), override: false })
dotenv.config({ path: path.resolve(process.cwd(), '../../.env'), override: false })

/** AP 端設定，從環境變數讀取 */
const tlsVerify = process.env.TLS_VERIFY !== 'false'

// 開發模式下若使用自簽憑證，可關閉 TLS 驗證（影響全域 Node.js fetch）
// WS 連線的 TLS 驗證另透過 rejectUnauthorized 選項單獨控制
if (!tlsVerify) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
}

export const config = {
  // ── Gateway WebSocket/RPC 設定（主要串接方式） ────────────────────────────
  /** Gateway WebSocket 位址，例：ws://127.0.0.1:18789 或 wss://gw.example.com */
  gatewayWsUrl: process.env.GATEWAY_WS_URL ?? 'ws://127.0.0.1:18789',

  /** Gateway WS 握手逾時（毫秒） */
  gatewayConnectTimeoutMs: parseInt(process.env.GATEWAY_CONNECT_TIMEOUT_MS ?? '5000', 10),

  /** Gateway RPC 單次請求逾時（毫秒） */
  gatewayRequestTimeoutMs: parseInt(process.env.GATEWAY_REQUEST_TIMEOUT_MS ?? '30000', 10),

  /**
   * WS 連線 Origin header（修正 origin not allowed 錯誤）。
   * 部分 Gateway 實作會校驗 Origin，需設為 Gateway 允許的來源。
   * 空字串 = 不帶 Origin header（使用 ws 程式庫預設行為）
   */
  gatewayWsOrigin: process.env.GATEWAY_WS_ORIGIN ?? '',

  /** Heartbeat 間隔（毫秒）；0 = 停用；預設 30 秒（防止防火牆閒置斷線） */
  gatewayHeartbeatIntervalMs: parseInt(process.env.GATEWAY_HEARTBEAT_INTERVAL_MS ?? '30000', 10),

  /** 連線中斷後最大重連次數；0 = 不重連 */
  gatewayReconnectMaxRetries: parseInt(process.env.GATEWAY_RECONNECT_MAX_RETRIES ?? '3', 10),

  /** 重連基礎等待時間（毫秒，依次數線性增長） */
  gatewayReconnectDelayMs: parseInt(process.env.GATEWAY_RECONNECT_DELAY_MS ?? '1000', 10),

  // ── AP 端基本設定 ─────────────────────────────────────────────────────────
  /** AP 監聽 Port */
  port: parseInt(process.env.API_PORT ?? '3000', 10),

  /** TLS 驗證（false = 接受自簽憑證，僅用於開發） */
  tlsVerify,

  /** CORS 允許來源 */
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map((s) => s.trim()),

  /**
   * 是否啟用 SSE 串流端點（POST /messages/stream）。
   * true（預設）= 啟用，前端可使用串流模式接收 AI 回覆；
   * false = 停用，前端自動降級為 REST + polling。
   * 環境變數：STREAMING_ENABLED=false
   */
  streamingEnabled: process.env.STREAMING_ENABLED !== 'false',

  // ── Gateway 客戶端識別（connect 握手用） ──────────────────────────────────
  /** 客戶端 ID（Gateway schema 校驗用，需為 Gateway 白名單中的值） */
  clientId: process.env.GATEWAY_CLIENT_ID ?? 'openclaw-control-ui',

  /** 客戶端實例 ID（區分同類型不同部署） */
  clientInstanceId: process.env.GATEWAY_CLIENT_INSTANCE_ID ?? 'gicoi-openclaw-webchat-client',

  /** 客戶端版本號 */
  clientVersion: process.env.GATEWAY_CLIENT_VERSION ?? '0.1.0',
} as const
