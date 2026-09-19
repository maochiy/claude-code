/** 开发态 Vite 地址。默认 5173，可用 VITE_DEV_PORT 避开被占用的端口。 */

const DEFAULT_VITE_DEV_PORT = 5173

export function getViteDevPort(): number {
  const raw = process.env.VITE_DEV_PORT
  if (!raw) return DEFAULT_VITE_DEV_PORT
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return DEFAULT_VITE_DEV_PORT
  }
  return parsed
}

export function getViteDevOrigin(): string {
  return `http://127.0.0.1:${getViteDevPort()}`
}

export function isViteDevOrigin(url: string): boolean {
  try {
    return new URL(url).origin === getViteDevOrigin()
  } catch {
    return false
  }
}
