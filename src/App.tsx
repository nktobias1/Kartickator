import {
  BookOpen,
  Download,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  WifiOff,
} from 'lucide-react'
import './App.css'

const cardSections = [
  'Faction rules',
  'Strategic ploys',
  'Firefight ploys',
  'Operatives',
  'Equipment',
]

function App() {
  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand-lockup" aria-label="Kartickator">
          <div className="brand-mark" aria-hidden="true">
            <ShieldCheck size={24} strokeWidth={2.2} />
          </div>
          <div>
            <p className="eyebrow">Kartickator</p>
            <h1>Kill Team cards</h1>
          </div>
        </div>

        <div className="sync-state">
          <WifiOff size={18} aria-hidden="true" />
          <span>Offline-ready</span>
        </div>
      </header>

      <section className="toolbar" aria-label="Library actions">
        <button type="button" className="primary-action" disabled>
          <RefreshCw size={18} aria-hidden="true" />
          <span>Check updates</span>
        </button>

        <a
          className="secondary-action"
          href="https://www.warhammer-community.com/en-gb/downloads/kill-team/"
          rel="noreferrer"
          target="_blank"
        >
          <ExternalLink size={18} aria-hidden="true" />
          <span>Official downloads</span>
        </a>
      </section>

      <section className="library" aria-labelledby="library-title">
        <div className="section-heading">
          <h2 id="library-title">Kill teams</h2>
          <span>0 stored locally</span>
        </div>

        <div className="team-row">
          <div className="team-icon" aria-hidden="true">
            <BookOpen size={22} />
          </div>
          <div className="team-copy">
            <strong>No local teams</strong>
            <span>Downloads will be processed on this device.</span>
          </div>
          <button type="button" className="icon-action" disabled aria-label="Download">
            <Download size={18} aria-hidden="true" />
          </button>
        </div>
      </section>

      <nav className="card-sections" aria-label="Card sections">
        {cardSections.map((section) => (
          <button type="button" key={section} disabled>
            {section}
          </button>
        ))}
      </nav>

      <footer className="notice">
        Unofficial fan-made tool. No PDFs, extracted cards, rule text, or
        official artwork are bundled with this app.
      </footer>
    </main>
  )
}

export default App
