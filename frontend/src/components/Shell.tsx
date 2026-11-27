import { Link } from 'react-router-dom'
import { useAuth } from '../auth'
import { Menu } from '../ui'

export function Shell({ children, help }: { children: React.ReactNode; help?: React.ReactNode }) {
  const { email, logout } = useAuth()
  return (
    <div className="app-shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="mark" aria-hidden="true" />
          <span className="brand-text">CodeMap</span>
        </Link>
        <div className="topbar-side">
        {help}
        {email ? (
          <Menu
            label="Account"
            items={[{ kind: 'label', label: email }, { kind: 'divider' }, { label: 'Log out', icon: 'logout', onSelect: logout }]}
            trigger={({ open, toggle }) => (
              <button type="button" className="account-btn" aria-label="Account menu" aria-expanded={open} aria-haspopup="menu" onClick={toggle}>
                <span className="avatar light" aria-hidden="true">
                  {email.slice(0, 1).toUpperCase()}
                </span>
                <span className="who">{email}</span>
              </button>
            )}
          />
        ) : null}
        </div>
      </header>
      <div className="shell-body">{children}</div>
    </div>
  )
}
