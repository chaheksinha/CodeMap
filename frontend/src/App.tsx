import { Link, Route, Routes } from 'react-router-dom'
import { useAuth } from './auth'
import { LoginPage } from './pages/LoginPage'
import { ProjectPage } from './pages/ProjectPage'
import { ProjectsPage } from './pages/ProjectsPage'
import { Spinner } from './ui'

export function App() {
  const { ready } = useAuth()
  if (!ready) {
    return (
      <div className="boot">
        <span className="mark big" aria-hidden="true" />
        <Spinner label="Opening CodeMap…" />
      </div>
    )
  }
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<ProjectsPage />} />
      <Route path="/projects/:id" element={<ProjectPage />} />
      <Route
        path="*"
        element={
          <main className="page-message">
            <h1>That page is not on the map.</h1>
            <p>The link may be old, or the project may have been deleted.</p>
            <Link to="/" className="btn primary">
              Back to projects
            </Link>
          </main>
        }
      />
    </Routes>
  )
}
