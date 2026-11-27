import type { Snapshot } from './types'

const TOKEN_KEY = 'codemap.token'
export const UNAUTHORIZED_EVENT = 'codemap:unauthorized'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

type Options = {
  method?: string
  json?: unknown
  body?: FormData
}

export async function api<T>(path: string, options: Options = {}): Promise<T> {
  const headers = new Headers()
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  let body: BodyInit | undefined
  if (options.json !== undefined) {
    headers.set('Content-Type', 'application/json')
    body = JSON.stringify(options.json)
  } else if (options.body) {
    body = options.body
  }
  let response: Response
  try {
    response = await fetch(`/api${path}`, {
      method: options.method ?? 'GET',
      headers,
      body,
    })
  } catch {
    throw new ApiError('The API is not running. Start it, then reload this page.', 0)
  }
  if (response.status === 401 && token && !path.startsWith('/auth/')) {
    setToken(null)
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
    throw new ApiError('Your session ended. Sign in again.', 401)
  }
  if (response.status === 204) return null as T
  const text = await response.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text) as unknown
    } catch {
      data = null
    }
  }
  if (!response.ok) {
    let message = 'Something went wrong.'
    if (data && typeof data === 'object' && 'detail' in data) {
      const detail = (data as { detail: unknown }).detail
      if (typeof detail === 'string') message = detail
      else message = 'Check the form and try again.'
    }
    throw new ApiError(message, response.status)
  }
  return data as T
}

export function projectIdOf(value: Snapshot | { id: number }): number {
  if ('project' in value) return value.project.id
  return value.id
}
