import { db, putMeta } from './db'
import type { DownloadManifest, RemoteDownload, StoredTeam } from './types'

export const OFFICIAL_DOWNLOADS_URL =
  'https://www.warhammer-community.com/en-gb/downloads/kill-team/'

export async function fetchDownloadManifest() {
  const response = await fetch(`${import.meta.env.BASE_URL}kill-team-downloads.json`, {
    cache: 'no-cache',
  })

  if (!response.ok) {
    throw new Error(`Manifest request failed with ${response.status}`)
  }

  return (await response.json()) as DownloadManifest
}

export async function applyManifest(manifest: DownloadManifest) {
  const now = new Date().toISOString()

  await db.transaction('rw', db.teams, db.meta, async () => {
    for (const remoteTeam of manifest.teams) {
      const current = await db.teams.get(remoteTeam.id)
      await db.teams.put(toStoredTeam(remoteTeam, manifest, current, now))
    }

    await putMeta('downloadManifest', {
      generatedAt: manifest.generatedAt,
      checkedAt: now,
      teamCount: manifest.teams.length,
    })
  })
}

function toStoredTeam(
  remoteTeam: RemoteDownload,
  manifest: DownloadManifest,
  current: StoredTeam | undefined,
  checkedAt: string,
): StoredTeam {
  return {
    id: remoteTeam.id,
    slug: remoteTeam.slug,
    name: remoteTeam.title,
    pdfUrl: remoteTeam.pdfUrl,
    fileName: remoteTeam.fileName,
    fileSize: remoteTeam.fileSize,
    lastUpdated: remoteTeam.lastUpdated,
    lastUpdatedLabel: remoteTeam.lastUpdatedLabel,
    remoteRevision: remoteTeam.revision,
    storedRevision: current?.storedRevision ?? null,
    sourceHash: current?.sourceHash ?? null,
    cardCount: current?.cardCount ?? 0,
    processedAt: current?.processedAt ?? null,
    lastCheckedAt: checkedAt,
    manifestGeneratedAt: manifest.generatedAt,
    error: current?.error ?? null,
    manual: false,
    favorite: current?.favorite ?? false,
  }
}
