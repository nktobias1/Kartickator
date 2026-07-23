import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Download,
  ExternalLink,
  FileUp,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react'
import './App.css'
import { db, getCardsForTeam, getTeams } from './lib/db'
import { sha256Hex, slugify } from './lib/hash'
import {
  OFFICIAL_DOWNLOADS_URL,
  applyManifest,
  fetchDownloadManifest,
} from './lib/manifest'
import {
  CARD_SECTIONS,
  type CardSection,
  type ProgressState,
  type StoredCard,
  type StoredTeam,
} from './lib/types'

function App() {
  const [teams, setTeams] = useState<StoredTeam[]>([])
  const [cards, setCards] = useState<StoredCard[]>([])
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null)
  const [activeSection, setActiveSection] = useState<CardSection>('faction-rules')
  const [searchQuery, setSearchQuery] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [progress, setProgress] = useState<ProgressState | null>(null)
  const [openCard, setOpenCard] = useState<StoredCard | null>(null)
  const [online, setOnline] = useState(navigator.onLine)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const importTargetRef = useRef<string | null>(null)

  const selectedTeam = teams.find((team) => team.id === selectedTeamId) ?? null

  const filteredTeams = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return teams
    return teams.filter((team) => team.name.toLowerCase().includes(query))
  }, [searchQuery, teams])

  const sectionCounts = useMemo(() => {
    return CARD_SECTIONS.reduce(
      (counts, section) => ({
        ...counts,
        [section.id]: cards.filter((card) => card.section === section.id).length,
      }),
      {} as Record<CardSection, number>,
    )
  }, [cards])

  const activeCards = cards.filter((card) => card.section === activeSection)
  const operativeGroups = groupOperatives(activeCards)

  useEffect(() => {
    const handleOnline = () => setOnline(navigator.onLine)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOnline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOnline)
    }
  }, [])

  useEffect(() => {
    async function initialize() {
      const localTeams = await getTeams()
      setTeams(localTeams)
      setSelectedTeamId((current) => current ?? localTeams[0]?.id ?? null)

      try {
        const manifest = await fetchDownloadManifest()
        await applyManifest(manifest)
        const refreshedTeams = await getTeams()
        setTeams(refreshedTeams)
        setSelectedTeamId((current) => current ?? refreshedTeams[0]?.id ?? null)
      } catch {
        setNotice('Using the local library. Update check is unavailable right now.')
      }
    }

    void initialize()
  }, [])

  useEffect(() => {
    if (!selectedTeamId) {
      setCards([])
      return
    }
    void loadCards(selectedTeamId)
  }, [selectedTeamId])

  async function loadTeams() {
    const localTeams = await getTeams()
    setTeams(localTeams)
    setSelectedTeamId((current) => current ?? localTeams[0]?.id ?? null)
  }

  async function loadCards(teamId: string) {
    setCards(await getCardsForTeam(teamId))
  }

  async function refreshManifest(showSuccess = true) {
    setProgress({ label: 'Checking updates', detail: 'Reading team list' })
    try {
      const manifest = await fetchDownloadManifest()
      await applyManifest(manifest)
      await loadTeams()
      if (showSuccess) {
        setNotice(`Checked ${manifest.teams.length} team rule downloads.`)
      }
    } finally {
      setProgress(null)
    }
  }

  async function processAndStore(team: StoredTeam, bytes: ArrayBuffer) {
    const hash = await sha256Hex(bytes.slice(0))
    const { processPdfCards } = await import('./lib/pdfProcessor')
    const processedCards = await processPdfCards(bytes, {
      teamName: team.name,
      onProgress: setProgress,
    })

    if (processedCards.length === 0) {
      throw new Error('No card crop marks were detected in this PDF')
    }

    const now = new Date().toISOString()
    const storedRevision = team.remoteRevision ?? `manual-${hash}`
    const records = processedCards.map<StoredCard>((card, index) => ({
      ...card,
      id: `${team.id}-${hash.slice(0, 12)}-${String(index + 1).padStart(3, '0')}`,
      teamId: team.id,
      createdAt: now,
    }))

    await db.transaction('rw', db.teams, db.cards, async () => {
      await db.cards.where('teamId').equals(team.id).delete()
      await db.cards.bulkAdd(records)
      await db.teams.put({
        ...team,
        storedRevision,
        sourceHash: hash,
        cardCount: records.length,
        processedAt: now,
        error: null,
      })
    })

    await loadTeams()
    setSelectedTeamId(team.id)
    await loadCards(team.id)
    setNotice(`${team.name}: stored ${records.length} cards locally.`)
  }

  function promptImport(teamId: string | null) {
    importTargetRef.current = teamId
    fileInputRef.current?.click()
  }

  async function handleFileImport(file: File) {
    try {
      const bytes = await file.arrayBuffer()
      const targetTeam = importTargetRef.current
        ? teams.find((team) => team.id === importTargetRef.current)
        : null
      const team = targetTeam ?? (await createManualTeam(file, bytes))
      await processAndStore(team, bytes)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Import failed'
      setNotice(message)
    } finally {
      importTargetRef.current = null
      setProgress(null)
    }
  }

  async function createManualTeam(file: File, bytes: ArrayBuffer): Promise<StoredTeam> {
    const hash = await sha256Hex(bytes.slice(0))
    const name = file.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim()
    const now = new Date().toISOString()
    const team: StoredTeam = {
      id: `manual-${hash.slice(0, 12)}`,
      slug: slugify(name || file.name),
      name: name || 'Imported PDF',
      pdfUrl: null,
      fileName: file.name,
      fileSize: formatBytes(file.size),
      lastUpdated: null,
      lastUpdatedLabel: null,
      remoteRevision: null,
      storedRevision: null,
      sourceHash: null,
      cardCount: 0,
      processedAt: null,
      lastCheckedAt: now,
      manifestGeneratedAt: null,
      error: null,
      manual: true,
    }
    await db.teams.put(team)
    await loadTeams()
    return team
  }

  async function clearStoredCards(team: StoredTeam) {
    if (!window.confirm(`Remove locally stored cards for ${team.name}?`)) return
    await db.transaction('rw', db.teams, db.cards, async () => {
      await db.cards.where('teamId').equals(team.id).delete()
      await db.teams.update(team.id, {
        cardCount: 0,
        processedAt: null,
        storedRevision: null,
        sourceHash: null,
      })
    })
    await loadTeams()
    if (selectedTeamId === team.id) await loadCards(team.id)
  }

  return (
    <main className="app-shell">
      <input
        ref={fileInputRef}
        className="hidden-file-input"
        type="file"
        accept="application/pdf,.pdf"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (file) void handleFileImport(file)
        }}
      />

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
          {online ? <Wifi size={18} /> : <WifiOff size={18} />}
          <span>{online ? 'Online' : 'Offline'}</span>
        </div>
      </header>

      <section className="toolbar" aria-label="Library actions">
        <button
          type="button"
          className="primary-action"
          onClick={() => void refreshManifest()}
          disabled={Boolean(progress)}
        >
          <RefreshCw size={18} aria-hidden="true" />
          <span>Check updates</span>
        </button>

        <button
          type="button"
          className="secondary-action"
          onClick={() => promptImport(null)}
          disabled={Boolean(progress)}
        >
          <FileUp size={18} aria-hidden="true" />
          <span>Import PDF</span>
        </button>

        <a
          className="secondary-action"
          href={OFFICIAL_DOWNLOADS_URL}
          rel="noreferrer"
          target="_blank"
        >
          <ExternalLink size={18} aria-hidden="true" />
          <span>Official downloads</span>
        </a>
      </section>

      {progress && <ProgressBanner progress={progress} />}
      {notice && <NoticeBanner message={notice} onClose={() => setNotice(null)} />}

      <div className="workspace">
        <section className="team-panel" aria-labelledby="library-title">
          <div className="section-heading">
            <h2 id="library-title">Kill teams</h2>
            <span>{teams.filter((team) => team.cardCount > 0).length} stored</span>
          </div>

          <label className="search-box">
            <Search size={18} aria-hidden="true" />
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search teams"
            />
          </label>

          <div className="team-list">
            {filteredTeams.map((team) => (
              <TeamRow
                key={team.id}
                team={team}
                selected={team.id === selectedTeamId}
                busy={Boolean(progress)}
                onSelect={() => setSelectedTeamId(team.id)}
                onImport={() => promptImport(team.id)}
                onClear={() => void clearStoredCards(team)}
              />
            ))}
          </div>
        </section>

        <section className="card-panel" aria-labelledby="cards-title">
          {selectedTeam ? (
            <>
              <div className="selected-team-header">
                <div>
                  <p className="eyebrow">Selected team</p>
                  <h2 id="cards-title">{selectedTeam.name}</h2>
                  <p>{teamStatusLabel(selectedTeam)}</p>
                </div>
                <div className="selected-team-actions">
                  {selectedTeam.pdfUrl && (
                    <a
                      className="secondary-action compact"
                      href={selectedTeam.pdfUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      <ExternalLink size={17} aria-hidden="true" />
                      <span>Open PDF</span>
                    </a>
                  )}
                  <button
                    type="button"
                    className="primary-action compact"
                    onClick={() => promptImport(selectedTeam.id)}
                    disabled={Boolean(progress)}
                  >
                    <FileUp size={17} aria-hidden="true" />
                    <span>
                      {selectedTeam.cardCount > 0 ? 'Update cards' : 'Import PDF'}
                    </span>
                  </button>
                </div>
              </div>

              <nav className="card-sections" aria-label="Card sections">
                {CARD_SECTIONS.map((section) => (
                  <button
                    type="button"
                    key={section.id}
                    className={section.id === activeSection ? 'active' : ''}
                    onClick={() => setActiveSection(section.id)}
                  >
                    <span>{section.label}</span>
                    <strong>{sectionCounts[section.id]}</strong>
                  </button>
                ))}
              </nav>

              {activeCards.length > 0 ? (
                activeSection === 'operatives' ? (
                  <div className="operative-groups">
                    {operativeGroups.map((group) => (
                      <article className="operative-group" key={group.key}>
                        <header>
                          <h3>{group.title}</h3>
                          <span>{group.cards.length} card{group.cards.length === 1 ? '' : 's'}</span>
                        </header>
                        <div className="card-grid">
                          {group.cards.map((card) => (
                            <CardTile
                              card={card}
                              key={card.id}
                              onOpen={() => setOpenCard(card)}
                            />
                          ))}
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="card-grid">
                    {activeCards.map((card) => (
                      <CardTile
                        card={card}
                        key={card.id}
                        onOpen={() => setOpenCard(card)}
                      />
                    ))}
                  </div>
                )
              ) : (
                <div className="empty-state">
                  <AlertCircle size={22} aria-hidden="true" />
                  <p>No locally stored cards in this section.</p>
                </div>
              )}
            </>
          ) : (
            <div className="empty-state">
              <AlertCircle size={22} aria-hidden="true" />
              <p>No teams loaded.</p>
            </div>
          )}
        </section>
      </div>

      <footer className="notice">
        Unofficial fan-made tool. PDFs and generated card images stay on this
        device.
      </footer>

      {openCard && (
        <CardModal card={openCard} onClose={() => setOpenCard(null)} />
      )}
    </main>
  )
}

type TeamRowProps = {
  team: StoredTeam
  selected: boolean
  busy: boolean
  onSelect: () => void
  onImport: () => void
  onClear: () => void
}

function TeamRow({
  team,
  selected,
  busy,
  onSelect,
  onImport,
  onClear,
}: TeamRowProps) {
  const updateAvailable =
    team.cardCount > 0 &&
    Boolean(team.remoteRevision) &&
    team.remoteRevision !== team.storedRevision

  return (
    <article className={`team-row ${selected ? 'selected' : ''}`}>
      <button type="button" className="team-main" onClick={onSelect}>
        <div className="team-icon" aria-hidden="true">
          {team.cardCount > 0 ? <CheckCircle2 size={22} /> : <Download size={21} />}
        </div>
        <div className="team-copy">
          <strong>{team.name}</strong>
          <span>{teamRowMeta(team, updateAvailable)}</span>
        </div>
      </button>
      <div className="team-actions">
        {team.pdfUrl && (
          <a
            className={updateAvailable ? 'icon-action urgent' : 'icon-action'}
            href={team.pdfUrl}
            rel="noreferrer"
            target="_blank"
            aria-label={`Open official PDF for ${team.name}`}
            title="Open PDF"
          >
            <ExternalLink size={17} aria-hidden="true" />
          </a>
        )}
        <button
          type="button"
          className="icon-action"
          onClick={onImport}
          disabled={busy}
          aria-label={`Import PDF for ${team.name}`}
          title="Import PDF"
        >
          <FileUp size={17} aria-hidden="true" />
        </button>
        {team.cardCount > 0 && (
          <button
            type="button"
            className="icon-action danger"
            onClick={onClear}
            disabled={busy}
            aria-label={`Clear stored cards for ${team.name}`}
            title="Clear stored cards"
          >
            <Trash2 size={17} aria-hidden="true" />
          </button>
        )}
      </div>
    </article>
  )
}

function ProgressBanner({ progress }: { progress: ProgressState }) {
  const percent =
    progress.current && progress.total
      ? Math.min(100, Math.round((progress.current / progress.total) * 100))
      : null

  return (
    <section className="progress-banner" aria-live="polite">
      <Loader2 size={18} aria-hidden="true" />
      <div>
        <strong>{progress.label}</strong>
        {progress.detail && <span>{progress.detail}</span>}
      </div>
      {percent !== null && <meter min="0" max="100" value={percent} />}
    </section>
  )
}

function NoticeBanner({
  message,
  onClose,
}: {
  message: string
  onClose: () => void
}) {
  return (
    <section className="notice-banner" aria-live="polite">
      <AlertCircle size={18} aria-hidden="true" />
      <span>{message}</span>
      <button type="button" onClick={onClose} aria-label="Dismiss notice">
        <X size={16} aria-hidden="true" />
      </button>
    </section>
  )
}

function CardTile({ card, onOpen }: { card: StoredCard; onOpen: () => void }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    const objectUrl = URL.createObjectURL(card.image)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [card.image])

  return (
    <button type="button" className="card-tile" onClick={onOpen}>
      {url && <img src={url} alt={card.title} loading="lazy" />}
      <span>{card.title}</span>
    </button>
  )
}

function CardModal({ card, onClose }: { card: StoredCard; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    const objectUrl = URL.createObjectURL(card.image)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [card.image])

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal-toolbar">
        <strong>{card.title}</strong>
        <button type="button" onClick={onClose} aria-label="Close card">
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      {url && <img src={url} alt={card.title} />}
    </div>
  )
}

function groupOperatives(cards: StoredCard[]) {
  const groups = new Map<string, { key: string; title: string; cards: StoredCard[] }>()
  for (const card of cards) {
    const existing = groups.get(card.groupKey)
    if (existing) {
      existing.cards.push(card)
    } else {
      groups.set(card.groupKey, {
        key: card.groupKey,
        title: card.groupTitle,
        cards: [card],
      })
    }
  }
  return [...groups.values()]
}

function teamRowMeta(team: StoredTeam, updateAvailable: boolean) {
  if (team.error) return team.error
  if (updateAvailable) return 'New official PDF available'
  if (team.cardCount > 0) return `${team.cardCount} cards stored`
  return team.lastUpdatedLabel ? `Updated ${team.lastUpdatedLabel}` : 'Not downloaded'
}

function teamStatusLabel(team: StoredTeam) {
  if (team.cardCount === 0) return 'Not stored locally'
  const date = team.processedAt ? new Date(team.processedAt).toLocaleDateString() : null
  return `${team.cardCount} cards stored${date ? ` on ${date}` : ''}`
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default App
