import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const API_URL = 'https://www.warhammer-community.com/api/search/downloads/'
const SOURCE_URL =
  'https://www.warhammer-community.com/en-gb/downloads/kill-team/'
const ASSET_BASE_URL = 'https://assets.warhammer-community.com/'
const OUTPUT_PATH = path.join(process.cwd(), 'public', 'kill-team-downloads.json')

function parseWarhammerDate(value) {
  if (!value || typeof value !== 'string') return null
  const [day, month, year] = value.split('/').map((part) => Number(part))
  if (!day || !month || !year) return null
  return `${year.toString().padStart(4, '0')}-${month
    .toString()
    .padStart(2, '0')}-${day.toString().padStart(2, '0')}`
}

function normalizeDownload(hit) {
  const id = hit.id ?? {}
  const fileName = id.file
  const categories = Array.isArray(id.download_categories)
    ? id.download_categories.map((category) => ({
        title: category.title,
        slug: category.slug,
      }))
    : []
  const topics = Array.isArray(id.topics)
    ? id.topics.map((topic) => ({ title: topic.title, slug: topic.slug }))
    : []
  const lastUpdated = parseWarhammerDate(id.last_updated)
  const createdAt = parseWarhammerDate(id.created_at)

  return {
    id: id.slug,
    title: id.title ?? hit.title,
    slug: id.slug,
    pdfUrl: fileName ? `${ASSET_BASE_URL}${fileName}` : null,
    fileName,
    fileSize: id.file_size ?? null,
    lastUpdated,
    lastUpdatedLabel: id.last_updated ?? null,
    createdAt,
    createdAtLabel: id.created_at ?? null,
    categories,
    topics,
    revision: [id.last_updated, fileName, id.file_size].filter(Boolean).join('|'),
  }
}

async function main() {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Kartickator manifest refresh',
    },
    body: JSON.stringify({
      index: 'downloads_v2',
      searchTerm: '',
      gameSystem: 'kill-team',
      language: 'english',
    }),
  })

  if (!response.ok) {
    throw new Error(`Warhammer download API returned ${response.status}`)
  }

  const payload = await response.json()
  const downloads = (payload.hits ?? [])
    .map(normalizeDownload)
    .filter((download) => download.id && download.pdfUrl)
    .sort((a, b) => a.title.localeCompare(b.title))
  const teams = downloads.filter((download) =>
    download.categories.some((category) => category.slug === 'team-rules'),
  )

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceUrl: SOURCE_URL,
    sourceApi: API_URL,
    language: 'english',
    teams,
    downloads,
  }

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true })
  await writeFile(OUTPUT_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Wrote ${teams.length} Kill Team rules to ${OUTPUT_PATH}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
