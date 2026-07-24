import {
  getDocument,
  GlobalWorkerOptions,
  Util,
} from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import { CARD_SECTIONS, type CardSection, type ProgressState } from './types'
import { slugify } from './hash'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl

type Rect = {
  x: number
  y: number
  width: number
  height: number
}

type TextItem = {
  str?: string
  transform?: number[]
  width?: number
  height?: number
}

type TextSpan = {
  text: string
  x: number
  y: number
  width: number
  height: number
}

export type ProcessedCard = {
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
}

type ProcessOptions = {
  teamName: string
  onProgress: (progress: ProgressState) => void
}

type FixedLayout = 'landscape' | 'portrait'

const CARD_LONG_TO_SHORT = 121 / 70
const TEMPLATE_MARK_THRESHOLD = 12

export async function processPdfCards(
  bytes: ArrayBuffer,
  { teamName, onProgress }: ProcessOptions,
) {
  const loadingTask = getDocument({ data: new Uint8Array(bytes.slice(0)) })
  const pdfDocument = await loadingTask.promise
  const processedCards: ProcessedCard[] = []
  let currentSection: CardSection = 'faction-rules'

  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    onProgress({
      label: 'Processing PDF',
      detail: `Rendering page ${pageNumber} of ${pdfDocument.numPages}`,
      current: pageNumber,
      total: pdfDocument.numPages,
    })

    const page = await pdfDocument.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 2 })
    const canvas = documentCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    const context = canvas.getContext('2d', { willReadFrequently: true })

    if (!context) {
      throw new Error('Canvas is not available in this browser')
    }

    await page.render({
      canvas,
      canvasContext: context,
      viewport,
    }).promise

    const pageText = await page.getTextContent()
    const spans = extractTextSpans(pageText.items as TextItem[], viewport.transform)
    const fullText = spans.map((span) => span.text).join(' ')
    if (!likelyCardPage(fullText)) {
      page.cleanup()
      continue
    }

    const rects = detectCardRects(context, canvas.width, canvas.height, fullText)

    let pageCardIndex = 0
    for (const rect of rects) {
      const text = collectTextForRect(spans, rect)
      if (shouldSkipCard(text)) continue

      currentSection = classifyCard(text, currentSection)
      const title = inferTitle(text, currentSection, teamName)
      const groupTitle = currentSection === 'operatives' ? title : CARD_SECTIONS.find(
        (section) => section.id === currentSection,
      )?.label ?? title
      const image = await cropCard(canvas, rect)

      pageCardIndex += 1
      processedCards.push({
        section: currentSection,
        title,
        groupTitle,
        groupKey:
          currentSection === 'operatives'
            ? slugify(title || `operative-${processedCards.length + 1}`)
            : `${currentSection}-${processedCards.length + 1}`,
        order: processedCards.length,
        pageNumber,
        pageCardIndex,
        image,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        text,
      })

      await yieldToBrowser()
    }

    page.cleanup()
  }

  await loadingTask.destroy()
  groupOperativeContinuationCards(processedCards)
  return processedCards
}

function documentCanvas(width: number, height: number) {
  const canvas = window.document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function detectCardRects(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  pageText: string,
) {
  const data = context.getImageData(0, 0, width, height).data
  const fixedLayoutRects = detectFixedLayoutRects(data, width, height, pageText)
  if (fixedLayoutRects.length > 0) return fixedLayoutRects

  const headerRects = detectHeaderBasedRects(data, width, height)
  if (headerRects.length > 0) return headerRects

  const cropMarkRects = detectCropMarkRects(data, width, height)
  if (cropMarkRects.length > 0) return cropMarkRects

  const xProjection = columnCoverage(data, width, height)

  const xLines = selectStructuralLines(
    findThinRuns(xProjection, Math.max(18, maxProjection(xProjection) * 0.45), 10),
    width * 0.16,
    3,
  ).sort((a, b) => a.position - b.position)

  if (xLines.length < 2) return []

  const yProjection = rowBoundaryCoverage(
    data,
    width,
    height,
    xLines.map((line) => line.position),
  )
  const yLines = selectStructuralLines(
    findThinRuns(yProjection, 1, 12),
    height * 0.025,
    24,
  ).sort((a, b) => a.position - b.position)

  if (yLines.length < 2) return []

  const rects: Rect[] = []
  for (let column = 0; column < xLines.length - 1; column += 1) {
    for (let row = 0; row < yLines.length - 1; row += 1) {
      const x = xLines[column].position
      const y = yLines[row].position
      const rectWidth = xLines[column + 1].position - x
      const rectHeight = yLines[row + 1].position - y

      if (rectWidth < width * 0.22 || rectHeight < height * 0.12) continue
      rects.push(padRect({ x, y, width: rectWidth, height: rectHeight }, width, height))
    }
  }

  return rects.sort((a, b) => a.y - b.y || a.x - b.x)
}

function detectFixedLayoutRects(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  pageText: string,
) {
  const textLayout = inferFixedLayoutFromText(pageText)
  if (textLayout) return buildFixedLayoutRects(textLayout, width, height)

  const landscapeScore = scoreFixedLayout(data, width, height, 'landscape')
  const portraitScore = scoreFixedLayout(data, width, height, 'portrait')

  if (
    landscapeScore.hits >= 7 &&
    landscapeScore.total > portraitScore.total * 1.4
  ) {
    return buildFixedLayoutRects('landscape', width, height)
  }

  if (
    portraitScore.hits >= 3 &&
    portraitScore.total > landscapeScore.total * 1.1
  ) {
    return buildFixedLayoutRects('portrait', width, height)
  }

  return []
}

function inferFixedLayoutFromText(pageText: string): FixedLayout | null {
  const normalized = pageText.toLowerCase().replace(/\s+/g, ' ')

  if (
    normalized.includes('apl move save wounds') ||
    normalized.includes('name atk hit')
  ) {
    return 'landscape'
  }

  if (
    normalized.includes('faction rule') ||
    normalized.includes('strategy ploy') ||
    normalized.includes('strategic ploy') ||
    normalized.includes('firefight ploy') ||
    normalized.includes('faction equipment') ||
    normalized.includes('marker/token guide') ||
    normalized.includes('operative selected from') ||
    normalized.includes('operatives selected from')
  ) {
    return 'portrait'
  }

  return null
}

function buildFixedLayoutRects(layout: FixedLayout, width: number, height: number) {
  const shortSide = width / 3
  const longSide = shortSide * CARD_LONG_TO_SHORT

  if (layout === 'landscape') {
    const x = (width - longSide) / 2
    const top = (height - 4 * shortSide) / 2
    return Array.from({ length: 4 }, (_, row) =>
      clampRect({
        x,
        y: top + row * shortSide,
        width: longSide,
        height: shortSide,
      }, width, height),
    )
  }

  const left = width / 6
  const top = (height - 2 * longSide) / 2
  return [0, 1].flatMap((row) =>
    [0, 1].map((column) =>
      clampRect({
        x: left + column * shortSide,
        y: top + row * longSide,
        width: shortSide,
        height: longSide,
      }, width, height),
    ),
  )
}

function scoreFixedLayout(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  layout: FixedLayout,
) {
  const { xs, ys } = fixedLayoutLines(layout, width, height)
  let hits = 0
  let total = 0

  for (const x of xs) {
    for (const y of ys) {
      const score = cropMarkScoreNear(data, width, height, x, y)
      if (score >= TEMPLATE_MARK_THRESHOLD) hits += 1
      total += score
    }
  }

  return { hits, total }
}

function fixedLayoutLines(layout: FixedLayout, width: number, height: number) {
  const shortSide = width / 3
  const longSide = shortSide * CARD_LONG_TO_SHORT

  if (layout === 'landscape') {
    const left = (width - longSide) / 2
    const top = (height - 4 * shortSide) / 2
    return {
      xs: [left, left + longSide],
      ys: Array.from({ length: 5 }, (_, index) => top + index * shortSide),
    }
  }

  const left = width / 6
  const top = (height - 2 * longSide) / 2
  return {
    xs: [left, left + shortSide, left + 2 * shortSide],
    ys: [top, top + longSide, top + 2 * longSide],
  }
}

function cropMarkScoreNear(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
) {
  let best = 0

  for (let yy = Math.round(y) - 18; yy <= Math.round(y) + 18; yy += 2) {
    for (let xx = Math.round(x) - 18; xx <= Math.round(x) + 18; xx += 2) {
      if (xx < 10 || xx >= width - 10 || yy < 10 || yy >= height - 10) continue

      const horizontal = countDarkPixels(data, width, height, xx - 10, yy, xx + 10, yy)
      const vertical = countDarkPixels(data, width, height, xx, yy - 10, xx, yy + 10)
      const density = countDarkBox(data, width, height, xx - 10, yy - 10, xx + 10, yy + 10)

      if (horizontal >= 4 && vertical >= 4 && density <= 140) {
        best = Math.max(best, horizontal + vertical)
      }
    }
  }

  return best
}

function clampRect(rect: Rect, width: number, height: number) {
  const x = Math.max(0, rect.x)
  const y = Math.max(0, rect.y)
  const right = Math.min(width, rect.x + rect.width)
  const bottom = Math.min(height, rect.y + rect.height)
  return { x, y, width: right - x, height: bottom - y }
}

function detectHeaderBasedRects(data: Uint8ClampedArray, width: number, height: number) {
  const rowCounts = new Uint32Array(height)
  for (let y = 0; y < height; y += 1) {
    let count = 0
    for (let x = 0; x < width; x += 2) {
      const index = (y * width + x) * 4
      if (isStructuralDark(data[index], data[index + 1], data[index + 2])) {
        count += 1
      }
    }
    rowCounts[y] = count
  }

  const headerRows = findThickRuns(
    rowCounts,
    Math.max(90, width * 0.15),
    18,
    95,
  )
  const headers = headerRows.flatMap((row) =>
    findHeaderColumns(data, width, row.start, row.end),
  )

  if (headers.length === 0) return []

  const columns = groupHeadersIntoColumns(headers, width)
  const rects: Rect[] = []

  for (const column of columns) {
    const sorted = column.sort((a, b) => a.y - b.y)
    const knownHeights = sorted
      .slice(0, -1)
      .map((header, index) => sorted[index + 1].y - header.y - 10)
      .filter((value) => value > height * 0.12)
    const fallbackHeight =
      median(knownHeights) || (sorted[0].width > width * 0.55 ? height * 0.23 : height * 0.4)

    sorted.forEach((header, index) => {
      const next = sorted[index + 1]
      const bottom = next ? next.y - 10 : Math.min(height - 12, header.y + fallbackHeight)
      const rect = {
        x: header.x,
        y: header.y,
        width: header.width,
        height: bottom - header.y,
      }
      if (rect.height > height * 0.12) {
        rects.push(padRect(rect, width, height))
      }
    })
  }

  return rects.sort((a, b) => a.y - b.y || a.x - b.x)
}

function findThickRuns(
  projection: Uint32Array,
  threshold: number,
  minThickness: number,
  maxThickness: number,
) {
  const runs: Array<{ start: number; end: number }> = []
  let index = 0
  while (index < projection.length) {
    if (projection[index] < threshold) {
      index += 1
      continue
    }

    const start = index
    while (index < projection.length && projection[index] >= threshold) {
      index += 1
    }
    const end = index - 1
    const thickness = end - start + 1
    if (thickness >= minThickness && thickness <= maxThickness) {
      runs.push({ start, end })
    }
  }
  return runs
}

function findHeaderColumns(
  data: Uint8ClampedArray,
  width: number,
  yStart: number,
  yEnd: number,
) {
  const projection = new Uint32Array(width)
  const headerHeight = yEnd - yStart + 1
  for (let x = 0; x < width; x += 1) {
    let count = 0
    for (let y = yStart; y <= yEnd; y += 2) {
      const index = (y * width + x) * 4
      if (isStructuralDark(data[index], data[index + 1], data[index + 2])) {
        count += 1
      }
    }
    projection[x] = count
  }

  const runs = findWideRuns(projection, Math.max(4, headerHeight * 0.18), width * 0.2)
  return runs.flatMap((run) => {
    const runWidth = run.end - run.start + 1
    if (runWidth > width * 0.62) {
      const midpoint = Math.round((run.start + run.end) / 2)
      return [
        { x: run.start, y: yStart, width: midpoint - run.start, height: headerHeight },
        { x: midpoint, y: yStart, width: run.end - midpoint + 1, height: headerHeight },
      ]
    }
    return [{ x: run.start, y: yStart, width: runWidth, height: headerHeight }]
  })
}

function findWideRuns(projection: Uint32Array, threshold: number, minWidth: number) {
  const runs: Array<{ start: number; end: number }> = []
  let index = 0
  while (index < projection.length) {
    if (projection[index] < threshold) {
      index += 1
      continue
    }
    const start = index
    while (index < projection.length && projection[index] >= threshold) {
      index += 1
    }
    const end = index - 1
    if (end - start + 1 >= minWidth) {
      runs.push({ start, end })
    }
  }
  return runs
}

function groupHeadersIntoColumns(headers: Rect[], pageWidth: number) {
  const columns: Rect[][] = []
  for (const header of headers.sort((a, b) => a.x - b.x)) {
    const center = header.x + header.width / 2
    const column = columns.find((items) => {
      const first = items[0]
      const firstCenter = first.x + first.width / 2
      return Math.abs(firstCenter - center) < pageWidth * 0.18
    })
    if (column) column.push(header)
    else columns.push([header])
  }
  return columns
}

function median(values: number[]) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function detectCropMarkRects(data: Uint8ClampedArray, width: number, height: number) {
  const marks = findCropMarks(data, width, height)
  if (marks.length < 4) return []

  const xClusters = clusterPositions(marks.map((mark) => mark.x), 12).filter(
    (cluster) => cluster.count >= 2,
  )
  const roughYClusters = clusterPositions(marks.map((mark) => mark.y), 12)
  const yClusters = roughYClusters.filter((cluster) => {
    const xHits = new Set<number>()
    for (const mark of marks) {
      if (Math.abs(mark.y - cluster.position) > 12) continue
      const xIndex = xClusters.findIndex(
        (xCluster) => Math.abs(mark.x - xCluster.position) <= 14,
      )
      if (xIndex >= 0) xHits.add(xIndex)
    }
    return xHits.size >= 2
  })

  const structuralX = xClusters
    .filter((cluster) => {
      const yHits = new Set<number>()
      for (const mark of marks) {
        if (Math.abs(mark.x - cluster.position) > 14) continue
        const yIndex = yClusters.findIndex(
          (yCluster) => Math.abs(mark.y - yCluster.position) <= 14,
        )
        if (yIndex >= 0) yHits.add(yIndex)
      }
      return yHits.size >= 2
    })
    .sort((a, b) => a.position - b.position)
    .slice(0, 4)
  const structuralY = yClusters.sort((a, b) => a.position - b.position)

  if (structuralX.length < 2 || structuralY.length < 2) return []

  const rects: Rect[] = []
  for (let column = 0; column < structuralX.length - 1; column += 1) {
    for (let row = 0; row < structuralY.length - 1; row += 1) {
      const x1 = structuralX[column].position
      const x2 = structuralX[column + 1].position
      const y1 = structuralY[row].position
      const y2 = structuralY[row + 1].position
      const rect = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }

      if (rect.width < width * 0.22 || rect.height < height * 0.12) continue
      if (
        hasMarkNear(marks, x1, y1) &&
        hasMarkNear(marks, x2, y1) &&
        hasMarkNear(marks, x1, y2) &&
        hasMarkNear(marks, x2, y2)
      ) {
        rects.push(padRect(rect, width, height))
      }
    }
  }

  return rects.sort((a, b) => a.y - b.y || a.x - b.x)
}

function findCropMarks(data: Uint8ClampedArray, width: number, height: number) {
  const candidates: Array<{ x: number; y: number; strength: number }> = []

  for (let y = 10; y < height - 10; y += 2) {
    for (let x = 10; x < width - 10; x += 2) {
      const index = (y * width + x) * 4
      if (!isCropMarkDark(data[index], data[index + 1], data[index + 2])) {
        continue
      }

      const horizontal = countDarkPixels(data, width, height, x - 9, y, x + 9, y)
      const vertical = countDarkPixels(data, width, height, x, y - 9, x, y + 9)
      const density = countDarkBox(data, width, height, x - 9, y - 9, x + 9, y + 9)
      if (horizontal >= 4 && vertical >= 4 && density <= 110) {
        candidates.push({ x, y, strength: horizontal + vertical })
      }
    }
  }

  return dedupeMarks(candidates)
}

function countDarkPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
) {
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1)
  let count = 0

  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(x1 + ((x2 - x1) * step) / steps)
    const y = Math.round(y1 + ((y2 - y1) * step) / steps)
    if (x < 0 || x >= width || y < 0 || y >= height) continue
    const index = (y * width + x) * 4
    if (isCropMarkDark(data[index], data[index + 1], data[index + 2])) {
      count += 1
    }
  }

  return count
}

function countDarkBox(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
) {
  let count = 0
  for (let y = Math.max(0, y1); y <= Math.min(height - 1, y2); y += 1) {
    for (let x = Math.max(0, x1); x <= Math.min(width - 1, x2); x += 1) {
      const index = (y * width + x) * 4
      if (isCropMarkDark(data[index], data[index + 1], data[index + 2])) {
        count += 1
      }
    }
  }
  return count
}

function dedupeMarks(candidates: Array<{ x: number; y: number; strength: number }>) {
  const marks: Array<{ x: number; y: number }> = []
  for (const candidate of candidates.sort((a, b) => b.strength - a.strength)) {
    const existing = marks.find(
      (mark) =>
        Math.abs(mark.x - candidate.x) <= 10 && Math.abs(mark.y - candidate.y) <= 10,
    )
    if (!existing) {
      marks.push({ x: candidate.x, y: candidate.y })
    }
  }
  return marks
}

function clusterPositions(values: number[], tolerance: number) {
  const clusters: Array<{ position: number; count: number }> = []
  for (const value of [...values].sort((a, b) => a - b)) {
    const cluster = clusters.at(-1)
    if (cluster && Math.abs(cluster.position - value) <= tolerance) {
      cluster.position =
        (cluster.position * cluster.count + value) / (cluster.count + 1)
      cluster.count += 1
    } else {
      clusters.push({ position: value, count: 1 })
    }
  }
  return clusters
}

function hasMarkNear(marks: Array<{ x: number; y: number }>, x: number, y: number) {
  return marks.some((mark) => Math.abs(mark.x - x) <= 16 && Math.abs(mark.y - y) <= 16)
}

function columnCoverage(data: Uint8ClampedArray, width: number, height: number) {
  const bucketCount = 48
  const projection = new Uint32Array(width)

  for (let x = 0; x < width; x += 1) {
    const buckets = new Uint8Array(bucketCount)
    for (let y = 0; y < height; y += 3) {
      const index = (y * width + x) * 4
      if (isStructuralDark(data[index], data[index + 1], data[index + 2])) {
        buckets[Math.min(bucketCount - 1, Math.floor((y / height) * bucketCount))] = 1
      }
    }
    projection[x] = buckets.reduce((total, value) => total + value, 0)
  }

  return projection
}

function rowBoundaryCoverage(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  xLines: number[],
) {
  const projection = new Uint32Array(height)

  for (let y = 0; y < height; y += 1) {
    let hits = 0
    for (let index = 0; index < xLines.length - 1; index += 1) {
      const left = xLines[index]
      const right = xLines[index + 1]
      const arm = Math.min(72, Math.max(28, (right - left) * 0.13))
      const leftArm = hasHorizontalCropArm(data, width, height, y, left + 8, left + arm)
      const rightArm = hasHorizontalCropArm(
        data,
        width,
        height,
        y,
        right - arm,
        right - 8,
      )
      if (leftArm && rightArm) {
        hits += 1
      }
    }
    projection[y] = hits
  }

  return projection
}

function hasHorizontalCropArm(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  y: number,
  start: number,
  end: number,
) {
  let darkPixels = 0
  const safeStart = Math.max(0, Math.floor(Math.min(start, end)))
  const safeEnd = Math.min(width - 1, Math.ceil(Math.max(start, end)))

  for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy += 1) {
    for (let x = safeStart; x <= safeEnd; x += 2) {
      const index = (yy * width + x) * 4
      if (isStructuralDark(data[index], data[index + 1], data[index + 2])) {
        darkPixels += 1
      }
    }
  }

  return darkPixels >= Math.max(4, (safeEnd - safeStart) / 14)
}

function isStructuralDark(red: number, green: number, blue: number) {
  return red < 105 && green < 105 && blue < 105
}

function isCropMarkDark(red: number, green: number, blue: number) {
  return red < 165 && green < 165 && blue < 165
}

function maxProjection(projection: Uint32Array) {
  let max = 0
  for (const value of projection) max = Math.max(max, value)
  return max
}

function findThinRuns(
  projection: Uint32Array,
  threshold: number,
  maxThickness: number,
) {
  const runs: Array<{ position: number; strength: number }> = []
  let index = 0

  while (index < projection.length) {
    if (projection[index] < threshold) {
      index += 1
      continue
    }

    const start = index
    let strength = projection[index]
    while (index < projection.length && projection[index] >= threshold) {
      strength = Math.max(strength, projection[index])
      index += 1
    }

    const end = index - 1
    if (end - start + 1 <= maxThickness) {
      runs.push({ position: Math.round((start + end) / 2), strength })
    }
  }

  return runs
}

function selectStructuralLines(
  candidates: Array<{ position: number; strength: number }>,
  minDistance: number,
  maxLines: number,
) {
  const selected: Array<{ position: number; strength: number }> = []
  const strongest = [...candidates].sort((a, b) => b.strength - a.strength)

  for (const candidate of strongest) {
    if (
      selected.every(
        (line) => Math.abs(line.position - candidate.position) >= minDistance,
      )
    ) {
      selected.push(candidate)
    }
    if (selected.length >= maxLines) break
  }

  return selected
}

function padRect(rect: Rect, width: number, height: number) {
  const padding = 8
  const x = Math.max(0, rect.x - padding)
  const y = Math.max(0, rect.y - padding)
  const right = Math.min(width, rect.x + rect.width + padding)
  const bottom = Math.min(height, rect.y + rect.height + padding)
  return { x, y, width: right - x, height: bottom - y }
}

function extractTextSpans(items: TextItem[], viewportTransform: number[]) {
  const spans: TextSpan[] = []

  for (const item of items) {
    if (!item.str?.trim() || !item.transform) continue
    const transform = Util.transform(viewportTransform, item.transform)
    const height = Math.max(Math.abs(transform[3]), item.height ?? 8)
    spans.push({
      text: item.str,
      x: transform[4],
      y: transform[5],
      width: Math.max(item.width ?? 1, 1),
      height,
    })
  }

  return spans
}

function collectTextForRect(spans: TextSpan[], rect: Rect) {
  const inRect = spans
    .filter((span) => {
      const x = span.x + span.width / 2
      const y = span.y - span.height / 2
      return (
        x >= rect.x &&
        x <= rect.x + rect.width &&
        y >= rect.y &&
        y <= rect.y + rect.height
      )
    })
    .sort((a, b) => a.y - b.y || a.x - b.x)

  const lines: Array<{ y: number; text: string[] }> = []
  for (const span of inRect) {
    const line = lines.find((entry) => Math.abs(entry.y - span.y) < 10)
    if (line) {
      line.text.push(span.text)
    } else {
      lines.push({ y: span.y, text: [span.text] })
    }
  }

  return lines
    .map((line) => line.text.join(' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

function shouldSkipCard(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase()
  if (!normalized) return true
  if (normalized.includes('kill team archetype')) return true
  if (normalized.includes('operative selected from')) return true
  if (normalized.includes('operatives selected from')) return true
  if (normalized.includes('operative with one option from each')) return true
  if (/^notes?:?\s*$/.test(normalized)) return true
  if (
    normalized.includes('notes') &&
    normalized.length < 120 &&
    !normalized.includes('faction') &&
    !normalized.includes('name atk') &&
    !normalized.includes('apl move')
  ) {
    return true
  }
  return normalized.length < 18 && normalized.includes('notes')
}

function likelyCardPage(text: string) {
  const normalized = text.toLowerCase()
  if (
    normalized.includes('update log') ||
    normalized.includes('previous erratas') ||
    normalized.includes('previous rules commentaries')
  ) {
    return false
  }
  return [
    'faction rule',
    'strategy ploy',
    'strategic ploy',
    'firefight ploy',
    'faction equipment',
    'marker/token guide',
    'apl move save wounds',
    'name atk hit',
  ].some((needle) => normalized.includes(needle))
}

function classifyCard(text: string, fallback: CardSection): CardSection {
  const normalized = text.toLowerCase()
  if (
    normalized.includes('apl move save wounds') ||
    normalized.includes('name atk hit')
  ) {
    return 'operatives'
  }
  if (
    normalized.includes('faction rule') ||
    normalized.includes('marker/token guide')
  ) {
    return 'faction-rules'
  }
  if (normalized.includes('firefight ploy')) return 'firefight-ploys'
  if (
    normalized.includes('strategy ploy') ||
    normalized.includes('strategic ploy')
  ) {
    return 'strategic-ploys'
  }
  if (
    normalized.includes('faction equipment') ||
    normalized.includes('equipment')
  ) {
    return 'equipment'
  }
  return fallback
}

function inferTitle(text: string, section: CardSection, teamName: string) {
  const teamPattern = new RegExp(escapeRegExp(teamName), 'i')
  const ignored = [
    'faction rules',
    'faction equipment',
    'firefight ploy',
    'strategy ploy',
    'strategic ploy',
    'marker/token guide',
    'rules continue on other side',
    'notes',
  ]

  const lines = text
    .split('\n')
    .map((line) => line.replace(teamPattern, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)

  for (const line of lines) {
    const lower = line.toLowerCase()
    if (ignored.some((item) => lower.includes(item))) continue
    if (lower.includes('chaos, heretic') || /^[\d\s,]+/.test(line)) continue
    if (lower.includes('apl') && lower.includes('move')) continue
    if (line.length > 70) continue
    if (/^[\d\s"'+/-]+$/.test(line)) continue

    return toTitleCase(line.replace(/[:.]+$/, ''))
  }

  const fallback = CARD_SECTIONS.find((item) => item.id === section)?.label ?? 'Card'
  return fallback
}

function toTitleCase(value: string) {
  return value
    .toLowerCase()
    .split(/\s+/)
    .map((word) => (word[0] ? `${word[0].toUpperCase()}${word.slice(1)}` : word))
    .join(' ')
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function cropCard(source: HTMLCanvasElement, rect: Rect) {
  const canvas = documentCanvas(Math.round(rect.width), Math.round(rect.height))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas is not available in this browser')
  context.drawImage(
    source,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    canvas.width,
    canvas.height,
  )
  return canvasToBlob(canvas)
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else reject(new Error('Could not encode card image'))
      },
      'image/jpeg',
      0.94,
    )
  })
}

function groupOperativeContinuationCards(cards: ProcessedCard[]) {
  let previousOperative: ProcessedCard | null = null

  for (const card of cards) {
    if (card.section !== 'operatives') {
      previousOperative = null
      continue
    }

    const sameTitle =
      previousOperative &&
      slugify(previousOperative.title) === slugify(card.title)
    if (sameTitle && previousOperative) {
      card.groupKey = previousOperative.groupKey
      card.groupTitle = previousOperative.groupTitle
    }

    previousOperative = card
  }
}

function yieldToBrowser() {
  return new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
}
