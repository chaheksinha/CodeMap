import { FormEvent, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { ApiError } from '../api'
import { useAuth } from '../auth'
import { COLORS } from '../legend'
import { Icon, Spinner } from '../ui'

export function LoginPage() {
  const { email, ready, signIn } = useAuth()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [address, setAddress] = useState('')
  const [password, setPassword] = useState('')
  const [reveal, setReveal] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  if (ready && email) return <Navigate to="/" replace />

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await signIn(address, password, mode)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in.')
    } finally {
      setBusy(false)
    }
  }

  function switchMode(next: 'login' | 'register') {
    setMode(next)
    setError('')
  }

  const short = mode === 'register' && password.length > 0 && password.length < 8

  return (
    <main className="login">
      <section className="login-story" aria-label="About CodeMap">
        <div className="brand light">
          <span className="mark" aria-hidden="true" />
          <span className="brand-text">CodeMap</span>
        </div>
        <div className="login-pitch">
          <h1>See what the code says. See what actually ran.</h1>
          <p className="lede">Source, runtime traces and your intended design on one map. Drift is flagged wherever they disagree.</p>
          <ul className="drift-list">
            <li>
              <LineSample color={COLORS.agree} thick />
              <span>
                <strong>Code and runtime agree</strong> the call is in the source and in the trace
              </span>
            </li>
            <li>
              <LineSample color={COLORS.source} dash="2 5" />
              <span>
                <strong>Only in code</strong> the trace never saw it run
              </span>
            </li>
            <li>
              <LineSample color={COLORS.drift} dash="6 4" thick />
              <span>
                <strong>Only at runtime</strong> it ran, but no code makes the call
              </span>
            </li>
          </ul>
        </div>
        <p className="fine">
          <Icon name="check" size={13} /> Uploaded code is parsed for structure. It is never executed.
        </p>
      </section>

      <section className="login-side">
        <div className="login-card">
          <div className="mode-switch" role="tablist" aria-label="Account">
            <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'on' : undefined} onClick={() => switchMode('login')}>
              Sign in
            </button>
            <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'on' : undefined} onClick={() => switchMode('register')}>
              Create account
            </button>
          </div>
          <h2>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h2>
          <p className="muted">{mode === 'login' ? 'Sign in to open your maps.' : 'Projects stay private to your account.'}</p>
          <form className="form" onSubmit={onSubmit} noValidate={false}>
            <label>
              <span>Email</span>
              <input type="email" autoComplete="email" value={address} placeholder="you@company.com" onChange={(event) => setAddress(event.target.value)} required />
            </label>
            <label>
              <span>Password</span>
              <span className="pw-field">
                <input
                  type={reveal ? 'text' : 'password'}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  minLength={8}
                  value={password}
                  aria-describedby="pw-hint"
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
                <button type="button" className="pw-toggle" aria-label={reveal ? 'Hide password' : 'Show password'} aria-pressed={reveal} onClick={() => setReveal((value) => !value)}>
                  <Icon name={reveal ? 'eyeOff' : 'eye'} />
                </button>
              </span>
              <small id="pw-hint" className={short ? 'hint warn' : 'hint'}>
                {mode === 'register' ? (short ? `${8 - password.length} more characters needed` : 'At least 8 characters') : ' '}
              </small>
            </label>
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
            <button type="submit" className="btn primary large full" disabled={busy || !ready}>
              {busy ? <Spinner label={mode === 'login' ? 'Signing in…' : 'Creating account…'} /> : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
          </form>
        </div>
      </section>
    </main>
  )
}

function LineSample({ color, dash, thick = false }: { color: string; dash?: string; thick?: boolean }) {
  return (
    <svg width="34" height="10" aria-hidden="true" className="line-sample">
      <line x1="2" y1="5" x2="32" y2="5" stroke={color} strokeWidth={thick ? 3.2 : 2.4} strokeLinecap="round" strokeDasharray={dash} />
    </svg>
  )
}
