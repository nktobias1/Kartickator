export const CARD_SECTIONS = [
  { id: 'faction-rules', label: 'Faction rules' },
  { id: 'strategic-ploys', label: 'Strategic ploys' },
  { id: 'firefight-ploys', label: 'Firefight ploys' },
  { id: 'operatives', label: 'Operatives' },
  { id: 'equipment', label: 'Equipment' },
] as const

export type CardSection = (typeof CARD_SECTIONS)[number]['id']

export type RemoteDownload = {
  id: string
  title: string
  slug: string
  pdfUrl: string
  fileName: string
  fileSize: string | null
  lastUpdated: string | null
  lastUpdatedLabel: string | null
  createdAt: string | null
  createdAtLabel: string | null
  categories: Array<{ title: string; slug: string }>
  topics: Array<{ title: string; slug: string }>
  revision: string
}

export type DownloadManifest = {
  schemaVersion: number
  generatedAt: string
  sourceUrl: string
  sourceApi: string
  language: string
  teams: RemoteDownload[]
  downloads: RemoteDownload[]
}

export type StoredTeam = {
  id: string
  slug: string
  name: string
  pdfUrl: string | null
  fileName: string | null
  fileSize: string | null
  lastUpdated: string | null
  lastUpdatedLabel: string | null
  remoteRevision: string | null
  storedRevision: string | null
  sourceHash: string | null
  cardCount: number
  processedAt: string | null
  lastCheckedAt: string | null
  manifestGeneratedAt: string | null
  error: string | null
  manual: boolean
}

export type StoredCard = {
  id: string
  teamId: string
  section: CardSection
  title: string
  groupKey: string
  groupTitle: string
  order: number
  pageNumber: number
  pageCardIndex: number
  image: Blob
  width: number
  height: number
  text: string
  createdAt: string
}

export type ProgressState = {
  label: string
  detail?: string
  current?: number
  total?: number
}
