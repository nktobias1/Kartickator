import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
} from 'react'
import {
  AlertCircle,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Download,
  ExternalLink,
  FileUp,
  Info,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  Star,
  TriangleAlert,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react'
import './App.css'
import { db, getCardsForTeam, getTeams } from './lib/db'
import { sha256Hex, slugify } from './lib/hash'
import {
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
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(() =>
    routeTeamId(),
  )
  const [activeSection, setActiveSection] = useState<CardSection>('faction-rules')
  const [activeCardIndex, setActiveCardIndex] = useState(0)
  const [searchQuery, setSearchQuery] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [aboutOpen, setAboutOpen] = useState(false)
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

  const activeCards = useMemo(
    () => cards.filter((card) => card.section === activeSection),
    [activeSection, cards],
  )
  const safeActiveCardIndex =
    activeCards.length > 0 ? Math.min(activeCardIndex, activeCards.length - 1) : 0
  const activeCard = activeCards[safeActiveCardIndex] ?? null

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
    const handleRouteChange = () => {
      setSelectedTeamId(routeTeamId())
      setOpenCard(null)
      setAboutOpen(false)
    }

    window.addEventListener('hashchange', handleRouteChange)
    return () => window.removeEventListener('hashchange', handleRouteChange)
  }, [])

  useEffect(() => {
    async function initialize() {
      const localTeams = await getTeams()
      setTeams(localTeams)

      try {
        const manifest = await fetchDownloadManifest()
        await applyManifest(manifest)
        const refreshedTeams = await getTeams()
        setTeams(refreshedTeams)
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
    setCards([])
    void loadCards(selectedTeamId)
  }, [selectedTeamId])

  useEffect(() => {
    setActiveSection('faction-rules')
    setActiveCardIndex(0)
  }, [selectedTeamId])

  useEffect(() => {
    setActiveCardIndex((currentIndex) =>
      activeCards.length > 0
        ? Math.min(currentIndex, activeCards.length - 1)
        : 0,
    )
  }, [activeCards.length])

  useEffect(() => {
    if (!selectedTeamId) return undefined
    return lockPortraitOrientation()
  }, [selectedTeamId])

  async function loadTeams() {
    const localTeams = await getTeams()
    setTeams(localTeams)
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
    navigateToTeam(team.id)
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
      const matchedTeam = targetTeam ?? findTeamForImport(file, teams)
      const team = matchedTeam ?? (await createManualTeam(file, bytes))
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
      favorite: false,
    }
    await db.teams.put(team)
    await loadTeams()
    return team
  }

  async function toggleFavorite(team: StoredTeam) {
    await db.teams.update(team.id, { favorite: team.favorite !== true })
    await loadTeams()
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

  function navigateToTeam(teamId: string) {
    setAboutOpen(false)
    const nextHash = teamRoute(teamId)
    if (window.location.hash !== nextHash) {
      window.location.hash = nextHash
    }
    setSelectedTeamId(teamId)
  }

  function navigateToLibrary() {
    setAboutOpen(false)
    if (window.location.hash) {
      window.history.pushState(
        null,
        '',
        `${window.location.pathname}${window.location.search}`,
      )
    }
    setSelectedTeamId(null)
    setCards([])
    setOpenCard(null)
  }

  function selectSection(section: CardSection) {
    setActiveSection(section)
    setActiveCardIndex(0)
  }

  function showPreviousCard() {
    setActiveCardIndex((currentIndex) =>
      activeCards.length > 0
        ? (currentIndex - 1 + activeCards.length) % activeCards.length
        : 0,
    )
  }

  function showNextCard() {
    setActiveCardIndex((currentIndex) =>
      activeCards.length > 0 ? (currentIndex + 1) % activeCards.length : 0,
    )
  }

  return (
    <main className={`app-shell${selectedTeamId ? ' has-bottom-switcher' : ''}`}>
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
        <div
          className="brand-lockup"
          aria-label={selectedTeamId && selectedTeam ? selectedTeam.name : 'Kartickator'}
        >
          {selectedTeamId ? (
            <button
              type="button"
              className="header-back"
              onClick={navigateToLibrary}
              aria-label="Back to kill teams"
              title="Kill teams"
            >
              <ArrowLeft size={22} aria-hidden="true" />
            </button>
          ) : (
            <div className="brand-mark" aria-hidden="true">
              <ShieldCheck size={24} strokeWidth={2.2} />
            </div>
          )}
          <div>
            <p className="eyebrow">Kartickator</p>
            <h1 id={selectedTeamId ? 'cards-title' : undefined}>
              {selectedTeamId && selectedTeam ? selectedTeam.name : 'Kill Team cards'}
            </h1>
          </div>
        </div>

        <div className="header-actions">
          <div className="sync-state">
            {online ? <Wifi size={18} /> : <WifiOff size={18} />}
            <span>{online ? 'Online' : 'Offline'}</span>
          </div>
          {!selectedTeamId && (
            <>
              <button
                type="button"
                className="icon-action"
                onClick={() => void refreshManifest()}
                disabled={Boolean(progress)}
                aria-label="Check updates"
                title="Check updates"
              >
                <RefreshCw size={17} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="icon-action"
                onClick={() => setAboutOpen(true)}
                aria-label="About Kartickator"
                title="About"
              >
                <Info size={17} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      </header>

      {progress && <ProgressBanner progress={progress} />}
      {notice && <NoticeBanner message={notice} onClose={() => setNotice(null)} />}

      {selectedTeamId ? (
        <section className="card-page" aria-labelledby="cards-title">
          {selectedTeam ? (
            <>
              {activeCard ? (
                <CardViewer
                  card={activeCard}
                  sectionLabel={sectionLabel(activeSection)}
                  index={safeActiveCardIndex}
                  total={activeCards.length}
                  onOpen={() => setOpenCard(activeCard)}
                  onPrevious={showPreviousCard}
                  onNext={showNextCard}
                />
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
              <p>Team not found.</p>
            </div>
          )}
        </section>
      ) : (
        <section className="library-page" aria-labelledby="library-title">
          <div className="team-panel">
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
              {filteredTeams.length > 0 ? (
                filteredTeams.map((team) => (
                  <TeamRow
                    key={team.id}
                    team={team}
                    selected={false}
                    busy={Boolean(progress)}
                    onSelect={() => navigateToTeam(team.id)}
                    onImport={() => promptImport(team.id)}
                    onClear={() => void clearStoredCards(team)}
                    onToggleFavorite={() => void toggleFavorite(team)}
                  />
                ))
              ) : (
                <div className="empty-state">
                  <AlertCircle size={22} aria-hidden="true" />
                  <p>No teams match that search.</p>
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {selectedTeamId && selectedTeam && (
        <SectionSwitcher
          activeSection={activeSection}
          counts={sectionCounts}
          onSelect={selectSection}
        />
      )}

      {aboutOpen && <AboutModal onClose={() => setAboutOpen(false)} />}

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
  onToggleFavorite: () => void
}

function TeamRow({
  team,
  selected,
  busy,
  onSelect,
  onImport,
  onClear,
  onToggleFavorite,
}: TeamRowProps) {
  const updateAvailable = teamHasOfficialUpdate(team)

  return (
    <article className={`team-row ${selected ? 'selected' : ''}${updateAvailable ? ' stale' : ''}`}>
      <button type="button" className="team-main" onClick={onSelect}>
        <div className="team-icon" aria-hidden="true">
          {updateAvailable ? (
            <TriangleAlert size={22} />
          ) : team.cardCount > 0 ? (
            <CheckCircle2 size={22} />
          ) : (
            <Download size={21} />
          )}
        </div>
        <div className="team-copy">
          <strong>{team.name}</strong>
          <span>{teamRowMeta(team)}</span>
        </div>
      </button>
      <div className="team-actions">
        <FavoriteButton
          team={team}
          busy={busy}
          onToggle={onToggleFavorite}
        />
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

function FavoriteButton({
  team,
  busy,
  onToggle,
}: {
  team: StoredTeam
  busy: boolean
  onToggle: () => void
}) {
  const favorite = Boolean(team.favorite)

  return (
    <button
      type="button"
      className={`icon-action favorite${favorite ? ' active' : ''}`}
      onClick={onToggle}
      disabled={busy}
      aria-label={`${favorite ? 'Remove' : 'Add'} ${team.name} ${favorite ? 'from' : 'to'} favorites`}
      title={favorite ? 'Remove favorite' : 'Add favorite'}
    >
      <Star size={17} fill={favorite ? 'currentColor' : 'none'} aria-hidden="true" />
    </button>
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

function SectionSwitcher({
  activeSection,
  counts,
  onSelect,
}: {
  activeSection: CardSection
  counts: Record<CardSection, number>
  onSelect: (section: CardSection) => void
}) {
  return (
    <nav className="section-switcher" aria-label="Card sections">
      {CARD_SECTIONS.map((section) => (
        <button
          type="button"
          key={section.id}
          className={section.id === activeSection ? 'active' : ''}
          onClick={() => onSelect(section.id)}
          aria-label={`${section.label}, ${counts[section.id]} cards`}
          title={section.label}
        >
          <span>{sectionShortLabel(section.label)}</span>
          <strong>{counts[section.id]}</strong>
        </button>
      ))}
    </nav>
  )
}

function CardViewer({
  card,
  sectionLabel,
  index,
  total,
  onOpen,
  onPrevious,
  onNext,
}: {
  card: StoredCard
  sectionLabel: string
  index: number
  total: number
  onOpen: () => void
  onPrevious: () => void
  onNext: () => void
}) {
  const swipeStartXRef = useRef<number | null>(null)
  const didSwipeRef = useRef(false)
  const rotateCard = shouldRotateCard(card)

  function startSwipe(clientX: number) {
    swipeStartXRef.current = clientX
    didSwipeRef.current = false
  }

  function finishSwipe(clientX: number) {
    const startX = swipeStartXRef.current
    swipeStartXRef.current = null
    if (startX === null || total <= 1) return

    const deltaX = clientX - startX
    if (Math.abs(deltaX) < 44) return

    didSwipeRef.current = true
    if (deltaX > 0) {
      onPrevious()
    } else {
      onNext()
    }
    window.setTimeout(() => {
      didSwipeRef.current = false
    }, 250)
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    startSwipe(event.clientX)
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    finishSwipe(event.clientX)
  }

  function handleMouseDown(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    startSwipe(event.clientX)
  }

  function handleMouseUp(event: ReactMouseEvent<HTMLDivElement>) {
    finishSwipe(event.clientX)
  }

  function handleTouchStart(event: ReactTouchEvent<HTMLDivElement>) {
    const touch = event.changedTouches[0]
    if (!touch) return
    startSwipe(touch.clientX)
  }

  function handleTouchEnd(event: ReactTouchEvent<HTMLDivElement>) {
    const touch = event.changedTouches[0]
    if (!touch) return
    finishSwipe(touch.clientX)
  }

  function cancelSwipe() {
    swipeStartXRef.current = null
  }

  function handleOpen() {
    if (!didSwipeRef.current) onOpen()
  }

  return (
    <article
      className="card-viewer"
      aria-label={`${sectionLabel}, card ${index + 1} of ${total}: ${card.title}`}
      aria-live="polite"
    >
      <div
        className="card-stage"
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={cancelSwipe}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={cancelSwipe}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={cancelSwipe}
        onDragStart={(event) => event.preventDefault()}
      >
        <button
          type="button"
          className="card-nav-button previous"
          onClick={onPrevious}
          disabled={total <= 1}
          aria-label="Previous card"
          title="Previous card"
        >
          <ChevronLeft size={22} aria-hidden="true" />
        </button>

        <button
          type="button"
          className={`card-frame${rotateCard ? ' rotated' : ''}`}
          onClick={handleOpen}
          aria-label={`Open ${card.title}`}
        >
          <CardImageShell card={card} rotate={rotateCard} />
        </button>

        <button
          type="button"
          className="card-nav-button next"
          onClick={onNext}
          disabled={total <= 1}
          aria-label="Next card"
          title="Next card"
        >
          <ChevronRight size={22} aria-hidden="true" />
        </button>
      </div>
    </article>
  )
}

function CardImage({
  card,
  style,
}: {
  card: StoredCard
  style?: CSSProperties
}) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    const objectUrl = URL.createObjectURL(card.image)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [card.image])

  return url ? <img src={url} alt={card.title} style={style} /> : null
}

function CardImageShell({
  card,
  rotate,
  modal = false,
}: {
  card: StoredCard
  rotate: boolean
  modal?: boolean
}) {
  const viewport = useViewportSize()
  const styles = rotatedCardImageStyles(card, rotate, viewport, modal)

  return (
    <span
      className={`card-image-shell${rotate ? ' rotated' : ''}`}
      style={styles.shell}
    >
      <CardImage card={card} style={styles.image} />
    </span>
  )
}

function AboutModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop about-backdrop" role="dialog" aria-modal="true">
      <div className="about-panel">
        <div className="modal-toolbar">
          <strong>About Kartickator</strong>
          <button type="button" onClick={onClose} aria-label="Close about">
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <p>
          Unofficial fan-made tool. PDFs and generated card images stay on this
          device.
        </p>
      </div>
    </div>
  )
}

function CardModal({ card, onClose }: { card: StoredCard; onClose: () => void }) {
  const rotateCard = shouldRotateCard(card)

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal-toolbar">
        <strong>{card.title}</strong>
        <button type="button" onClick={onClose} aria-label="Close card">
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      <div className={`modal-card-frame${rotateCard ? ' rotated' : ''}`}>
        <CardImageShell card={card} rotate={rotateCard} modal />
      </div>
    </div>
  )
}

function teamRowMeta(team: StoredTeam) {
  if (team.error) return team.error
  if (team.manual) return team.cardCount > 0 ? `${team.cardCount} cards stored` : 'Manual import'
  return teamLastUpdatedLabel(team)
}

function teamHasOfficialUpdate(team: StoredTeam) {
  if (team.cardCount === 0 || team.manual) return false
  if (team.remoteRevision && team.remoteRevision !== team.storedRevision) return true

  const localUpdatedAt = parseDateTime(team.processedAt)
  const officialUpdatedAt = parseDateTime(team.lastUpdated)
  return (
    localUpdatedAt !== null &&
    officialUpdatedAt !== null &&
    localUpdatedAt < officialUpdatedAt
  )
}

function teamLastUpdatedLabel(team: StoredTeam) {
  if (team.lastUpdatedLabel) return `Updated ${team.lastUpdatedLabel}`
  if (team.lastUpdated) return `Updated ${new Date(team.lastUpdated).toLocaleDateString()}`
  return 'No official update date'
}

function parseDateTime(value: string | null) {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? null : timestamp
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function sectionLabel(sectionId: CardSection) {
  return CARD_SECTIONS.find((section) => section.id === sectionId)?.label ?? ''
}

function sectionShortLabel(label: string) {
  return label.slice(0, 2)
}

function shouldRotateCard(card: StoredCard) {
  return card.section === 'operatives' && card.width > card.height
}

function useViewportSize() {
  const [viewport, setViewport] = useState(() => currentViewportSize())

  useEffect(() => {
    const handleResize = () => setViewport(currentViewportSize())
    window.addEventListener('resize', handleResize)
    window.visualViewport?.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      window.visualViewport?.removeEventListener('resize', handleResize)
    }
  }, [])

  return viewport
}

function currentViewportSize() {
  return {
    width: window.visualViewport?.width ?? window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
  }
}

function rotatedCardImageStyles(
  card: StoredCard,
  rotateCard: boolean,
  viewport: { width: number; height: number },
  modal = false,
): { shell?: CSSProperties; image?: CSSProperties } {
  if (!rotateCard) return {}

  const horizontalReserve = modal ? 24 : viewport.width <= 560 ? 58 : 96
  const verticalReserve = modal ? 92 : viewport.width <= 560 ? 170 : 180
  const maxVisualWidth = Math.max(180, viewport.width - horizontalReserve)
  const maxVisualHeight = Math.max(260, viewport.height - verticalReserve)
  const scale = Math.min(maxVisualWidth / card.height, maxVisualHeight / card.width)
  const imageWidth = Math.floor(card.width * scale)
  const imageHeight = Math.floor(card.height * scale)

  return {
    shell: {
      width: `${imageHeight}px`,
      height: `${imageWidth}px`,
    },
    image: {
      width: `${imageWidth}px`,
      height: `${imageHeight}px`,
    },
  }
}

type LockableScreenOrientation = ScreenOrientation & {
  lock?: (orientation: OrientationLockType) => Promise<void>
  unlock?: () => void
}

function lockPortraitOrientation() {
  const orientation = screen.orientation as LockableScreenOrientation | undefined
  if (typeof orientation?.lock !== 'function') return undefined

  void orientation.lock('portrait').catch(() => undefined)

  return () => {
    if (typeof orientation.unlock === 'function') {
      orientation.unlock()
    }
  }
}

function findTeamForImport(file: File, teams: StoredTeam[]) {
  const importedName = normalizedBaseFileName(file.name)
  if (!importedName) return null

  return teams.find((team) => {
    if (!team.fileName || team.manual) return false
    return normalizedBaseFileName(team.fileName) === importedName
  }) ?? null
}

function normalizedBaseFileName(fileName: string) {
  const baseName = fileName.split(/[\\/]/).at(-1)?.trim()
  if (!baseName) return ''

  try {
    return decodeURIComponent(baseName).toLowerCase()
  } catch {
    return baseName.toLowerCase()
  }
}

function routeTeamId() {
  const routePrefix = '#/teams/'
  if (!window.location.hash.startsWith(routePrefix)) return null

  const routeValue = window.location.hash.slice(routePrefix.length)
  if (!routeValue) return null

  try {
    return decodeURIComponent(routeValue)
  } catch {
    return routeValue
  }
}

function teamRoute(teamId: string) {
  return `#/teams/${encodeURIComponent(teamId)}`
}

export default App
