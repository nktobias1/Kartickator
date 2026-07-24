import Dexie, { type Table } from 'dexie'
import type { StoredCard, StoredTeam } from './types'

type MetaRecord = {
  key: string
  value: unknown
  updatedAt: string
}

class KartickatorDatabase extends Dexie {
  teams!: Table<StoredTeam, string>
  cards!: Table<StoredCard, string>
  meta!: Table<MetaRecord, string>

  constructor() {
    super('kartickator')
    this.version(1).stores({
      teams: 'id, slug, name, remoteRevision, storedRevision, processedAt',
      cards: 'id, teamId, section, groupKey, order',
      meta: 'key',
    })
  }
}

export const db = new KartickatorDatabase()

export async function getCardsForTeam(teamId: string) {
  return db.cards.where('teamId').equals(teamId).sortBy('order')
}

export async function getTeams() {
  const teams = await db.teams.toArray()
  return teams.sort(compareTeams)
}

export async function putMeta(key: string, value: unknown) {
  await db.meta.put({ key, value, updatedAt: new Date().toISOString() })
}

function compareTeams(a: StoredTeam, b: StoredTeam) {
  if (Boolean(a.favorite) !== Boolean(b.favorite)) {
    return a.favorite ? -1 : 1
  }

  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
    a.id.localeCompare(b.id)
}
