const MIN_WIDTH = 340
const MIN_HEIGHT = 360
const OPEN_MARKET_REFRESH_MS = 60 * 1000
const CLOSED_MARKET_REFRESH_MS = 15 * 60 * 1000
const PRACTICE_BUYS_STORAGE_KEY = 'stock-ticker-widget:practice-buys'
const STOCK_ORDER_STORAGE_KEY = 'stock-ticker-widget:stock-order'

let activeResize = null
let activeCompactDrag = null
let isCompact = false
let isRefreshing = false
let autoRefreshTimer = null
let activeBuyStock = null
let quotesByTicker = new Map()
let activeStockDragTicker = null

const shrinkButton = document.querySelector('.shrink-button')
const refreshButton = document.querySelector('.refresh-button')
const compactLauncher = document.querySelector('.compact-launcher')
const stockList = document.querySelector('.stock-list')
const lastUpdated = document.querySelector('.last-updated')
const buyModal = document.querySelector('.buy-modal')
const buyForm = document.querySelector('.buy-form')
const buyModalTitle = document.querySelector('#buyModalTitle')
const buyModalSummary = document.querySelector('.buy-modal-summary')
const buyReasonInput = document.querySelector('.buy-reason-input')
const buyHistoryList = document.querySelector('.buy-history-list')
const buyModalClose = document.querySelector('.buy-modal-close')
const buyCancelButton = document.querySelector('.buy-cancel-button')

function applyCompactMode(compact) {
  isCompact = compact
  document.body.classList.toggle('is-compact', compact)
}

function setCompactMode(compact) {
  applyCompactMode(compact)
  window.widgetWindow.setCompactMode(compact)
}

function resizeWindow(event) {
  if (!activeResize) {
    return
  }

  const dx = event.screenX - activeResize.startX
  const dy = event.screenY - activeResize.startY
  const nextWidth = activeResize.axes.x
    ? Math.max(MIN_WIDTH, activeResize.startWidth + dx)
    : activeResize.startWidth
  const nextHeight = activeResize.axes.y
    ? Math.max(MIN_HEIGHT, activeResize.startHeight + dy)
    : activeResize.startHeight

  window.widgetWindow.resize(nextWidth, nextHeight)
}

function stopResize() {
  activeResize = null
  document.body.classList.remove('is-resizing')
  window.removeEventListener('mousemove', resizeWindow)
  window.removeEventListener('mouseup', stopResize)
}

function startResize(event) {
  const handle = event.currentTarget.dataset.resizeHandle

  activeResize = {
    axes: {
      x: handle === 'right' || handle === 'corner',
      y: handle === 'bottom' || handle === 'corner',
    },
    startX: event.screenX,
    startY: event.screenY,
    startWidth: window.innerWidth,
    startHeight: window.innerHeight,
  }

  event.preventDefault()
  document.body.classList.add('is-resizing')
  window.addEventListener('mousemove', resizeWindow)
  window.addEventListener('mouseup', stopResize)
}

function moveCompactWindow(event) {
  if (!activeCompactDrag) {
    return
  }

  const dx = event.screenX - activeCompactDrag.startX
  const dy = event.screenY - activeCompactDrag.startY

  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
    activeCompactDrag.didMove = true
  }

  window.widgetWindow.move(activeCompactDrag.startBounds.x + dx, activeCompactDrag.startBounds.y + dy)
}

function stopCompactDrag() {
  if (!activeCompactDrag) {
    return
  }

  const shouldExpand = !activeCompactDrag.didMove

  activeCompactDrag = null
  window.removeEventListener('mousemove', moveCompactWindow)
  window.removeEventListener('mouseup', stopCompactDrag)

  if (shouldExpand) {
    setCompactMode(false)
  }
}

async function startCompactDrag(event) {
  if (!isCompact) {
    return
  }

  const bounds = await window.widgetWindow.getBounds()

  if (!bounds) {
    return
  }

  activeCompactDrag = {
    didMove: false,
    startX: event.screenX,
    startY: event.screenY,
    startBounds: bounds,
  }

  event.preventDefault()
  window.addEventListener('mousemove', moveCompactWindow)
  window.addEventListener('mouseup', stopCompactDrag)
}

function formatPrice(stock) {
  const price = Number(stock.price ?? stock.seededPrice)
  const currency = stock.currency || 'USD'
  const maximumFractionDigits = currency === 'JPY' ? 0 : 2

  if (!Number.isFinite(price)) {
    return '—'
  }

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits,
  }).format(price)
}

function formatPtsPrice(stock) {
  if (!stock.pts || !Number.isFinite(Number(stock.pts.price))) {
    return null
  }

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: stock.pts.currency || stock.currency || 'JPY',
    maximumFractionDigits: 0,
  }).format(stock.pts.price)
}

function formatChange(stock, change) {
  if (!Number.isFinite(Number(change?.amount)) || !Number.isFinite(Number(change?.percent))) {
    return '—'
  }

  const direction = change.amount > 0 ? '+' : ''
  const maximumFractionDigits = stock.currency === 'JPY' ? 0 : 2
  const amount = new Intl.NumberFormat('en-US', {
    maximumFractionDigits,
  }).format(change.amount)
  const percent = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(change.percent)

  return `${direction}${amount} (${direction}${percent}%)`
}

function createChangePill(stock, label, change) {
  const pill = document.createElement('div')
  const amount = Number(change?.amount)
  pill.className = 'change-pill'

  if (Number.isFinite(amount)) {
    pill.classList.add(amount >= 0 ? 'is-up' : 'is-down')
  }

  const labelNode = document.createElement('span')
  labelNode.className = 'change-label'
  labelNode.textContent = label

  const valueNode = document.createElement('span')
  valueNode.className = 'change-value'
  valueNode.textContent = formatChange(stock, change)

  pill.append(labelNode, valueNode)

  return pill
}

function formatUpdatedAt(value) {
  if (!value) {
    return 'Not refreshed yet'
  }

  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))
}

function formatPracticeDate(value) {
  if (!value) {
    return 'Unknown date'
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}

function getPracticeBuys() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PRACTICE_BUYS_STORAGE_KEY) || '[]')

    return Array.isArray(parsed) ? parsed : []
  } catch (_error) {
    return []
  }
}

function savePracticeBuys(entries) {
  localStorage.setItem(PRACTICE_BUYS_STORAGE_KEY, JSON.stringify(entries))
}

function getStockOrder() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STOCK_ORDER_STORAGE_KEY) || '[]')

    return Array.isArray(parsed) ? parsed.filter((ticker) => typeof ticker === 'string') : []
  } catch (_error) {
    return []
  }
}

function saveStockOrder(tickers) {
  localStorage.setItem(STOCK_ORDER_STORAGE_KEY, JSON.stringify(tickers))
}

function orderStocks(stocks) {
  const orderedTickers = getStockOrder()

  if (orderedTickers.length === 0) {
    return stocks
  }

  const stocksByTicker = new Map(stocks.map((stock) => [stock.ticker, stock]))
  const orderedStocks = []

  for (const ticker of orderedTickers) {
    const stock = stocksByTicker.get(ticker)

    if (!stock) {
      continue
    }

    orderedStocks.push(stock)
    stocksByTicker.delete(ticker)
  }

  return [
    ...orderedStocks,
    ...stocks.filter((stock) => stocksByTicker.has(stock.ticker)),
  ]
}

function setStocks(stocks) {
  const orderedStocks = orderStocks(stocks)
  quotesByTicker = new Map(orderedStocks.map((stock) => [stock.ticker, stock]))
  renderStocks(orderedStocks)

  return orderedStocks
}

function persistRenderedStockOrder() {
  const tickers = Array.from(stockList.querySelectorAll('.stock-card'))
    .map((card) => card.dataset.ticker)
    .filter(Boolean)

  saveStockOrder(tickers)
  quotesByTicker = new Map(
    tickers
      .map((ticker) => quotesByTicker.get(ticker))
      .filter(Boolean)
      .map((stock) => [stock.ticker, stock]),
  )
}

function getDragAfterStockCard(y) {
  const cards = Array.from(stockList.querySelectorAll('.stock-card:not(.is-dragging)'))

  return cards.reduce((closest, card) => {
    const box = card.getBoundingClientRect()
    const offset = y - box.top - box.height / 2

    if (offset < 0 && offset > closest.offset) {
      return { offset, card }
    }

    return closest
  }, { offset: Number.NEGATIVE_INFINITY, card: null }).card
}

function startStockDrag(event) {
  if (event.target.closest('button, input, textarea, select, summary')) {
    event.preventDefault()
    return
  }

  const card = event.currentTarget

  activeStockDragTicker = card.dataset.ticker
  card.classList.add('is-dragging')
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('text/plain', activeStockDragTicker)
}

function moveStockDrag(event) {
  if (!activeStockDragTicker) {
    return
  }

  event.preventDefault()

  const draggingCard = stockList.querySelector('.stock-card.is-dragging')
  const afterCard = getDragAfterStockCard(event.clientY)

  if (!draggingCard) {
    return
  }

  if (afterCard) {
    stockList.insertBefore(draggingCard, afterCard)
  } else {
    stockList.append(draggingCard)
  }
}

function finishStockDrag(event) {
  if (activeStockDragTicker) {
    event.preventDefault()
    persistRenderedStockOrder()
  }

  stockList.querySelector('.stock-card.is-dragging')?.classList.remove('is-dragging')
  activeStockDragTicker = null
}

function deletePracticeBuy(entryId) {
  savePracticeBuys(getPracticeBuys().filter((entry) => entry.id !== entryId))
  renderStocks(Array.from(quotesByTicker.values()))

  if (activeBuyStock) {
    renderBuyHistory(activeBuyStock)
  }
}

function getPracticeBuysForTicker(ticker) {
  return getPracticeBuys()
    .filter((entry) => entry.ticker === ticker)
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
}

function createPracticeEntry(stock, reason) {
  return {
    id: `${stock.ticker}-${Date.now()}`,
    ticker: stock.ticker,
    name: stock.name,
    reason,
    price: Number(stock.price ?? stock.seededPrice),
    currency: stock.currency,
    marketState: stock.marketState,
    createdAt: new Date().toISOString(),
  }
}

function createPracticeLog(stock) {
  const entries = getPracticeBuysForTicker(stock.ticker)

  if (entries.length === 0) {
    return document.createDocumentFragment()
  }

  const details = document.createElement('details')
  details.className = 'practice-log-details'

  const summary = document.createElement('summary')
  summary.textContent = `Practice buys (${entries.length})`
  details.append(summary)

  const list = document.createElement('div')
  list.className = 'practice-log-list'

  for (const entry of entries.slice(0, 3)) {
    const item = document.createElement('article')
    item.className = 'practice-log-item'

    const header = document.createElement('div')
    header.className = 'practice-log-item-header'

    const meta = document.createElement('div')
    meta.className = 'practice-log-meta'
    meta.textContent = `${formatPracticeDate(entry.createdAt)} · ${formatPrice(entry)}`

    const deleteButton = document.createElement('button')
    deleteButton.className = 'practice-delete-button'
    deleteButton.type = 'button'
    deleteButton.textContent = 'Delete'
    deleteButton.addEventListener('click', () => {
      deletePracticeBuy(entry.id)
    })

    header.append(meta, deleteButton)

    const reason = document.createElement('p')
    reason.textContent = entry.reason

    item.append(header, reason)
    list.append(item)
  }

  details.append(list)

  return details
}

function renderBuyHistory(stock) {
  const entries = getPracticeBuysForTicker(stock.ticker)
  buyHistoryList.replaceChildren()

  if (entries.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'buy-history-empty'
    empty.textContent = 'No practice buys saved yet. Use this first note to record your thesis before acting.'
    buyHistoryList.append(empty)
    return
  }

  for (const entry of entries) {
    const item = document.createElement('article')
    item.className = 'buy-history-item'

    const header = document.createElement('div')
    header.className = 'buy-history-item-header'

    const meta = document.createElement('div')
    meta.className = 'buy-history-meta'
    meta.textContent = `${formatPracticeDate(entry.createdAt)} · ${formatPrice(entry)}`

    const deleteButton = document.createElement('button')
    deleteButton.className = 'practice-delete-button'
    deleteButton.type = 'button'
    deleteButton.textContent = 'Delete'
    deleteButton.addEventListener('click', () => {
      deletePracticeBuy(entry.id)
    })

    header.append(meta, deleteButton)

    const reason = document.createElement('p')
    reason.textContent = entry.reason

    item.append(header, reason)
    buyHistoryList.append(item)
  }
}

function openBuyModal(stock) {
  activeBuyStock = stock
  buyModalTitle.textContent = `Buy ${stock.ticker}`
  buyModalSummary.textContent = `${stock.name} · ${formatPrice(stock)} · ${stock.marketState || 'market state unknown'}`
  buyReasonInput.value = ''
  renderBuyHistory(stock)
  buyModal.showModal()
  buyReasonInput.focus()
}

function closeBuyModal() {
  activeBuyStock = null
  buyModal.close()
}

function saveActivePracticeBuy() {
  if (!activeBuyStock) {
    return
  }

  const reason = buyReasonInput.value.trim()

  if (!reason) {
    buyReasonInput.focus()
    return
  }

  savePracticeBuys([
    createPracticeEntry(activeBuyStock, reason),
    ...getPracticeBuys(),
  ])

  renderStocks(Array.from(quotesByTicker.values()))
  closeBuyModal()
}

function formatRefreshInterval(milliseconds) {
  const minutes = Math.round(milliseconds / 60000)

  return minutes === 1 ? '1 min' : `${minutes} min`
}

function isMarketOpen(stocks) {
  return stocks.some((stock) => stock.marketState === 'REGULAR')
}

function scheduleNextRefresh(stocks) {
  if (autoRefreshTimer) {
    clearTimeout(autoRefreshTimer)
  }

  const refreshInterval = isMarketOpen(stocks)
    ? OPEN_MARKET_REFRESH_MS
    : CLOSED_MARKET_REFRESH_MS

  autoRefreshTimer = setTimeout(() => {
    refreshQuotes()
  }, refreshInterval)

  return refreshInterval
}

function formatFundamentalMetric(metric, fallbackCurrency) {
  const value = Number(metric?.value)

  if (!Number.isFinite(value)) {
    return '—'
  }

  const currency = metric.currency || fallbackCurrency || 'USD'

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(value)
}

function formatPercent(value) {
  if (!Number.isFinite(Number(value))) {
    return '—'
  }

  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(value)
}

function createFundamentalRow(label, value, options = {}) {
  const row = document.createElement('div')
  row.className = 'fundamental-row'

  const labelNode = document.createElement('span')
  labelNode.className = 'fundamental-label'
  labelNode.textContent = label

  const valueNode = document.createElement('span')
  valueNode.className = 'fundamental-value'
  valueNode.textContent = options.percent ? formatPercent(value) : formatFundamentalMetric(value, options.currency)

  row.append(labelNode, valueNode)

  return row
}

function createFundamentalSection(title, rows) {
  const section = document.createElement('section')
  section.className = 'fundamental-section'

  const heading = document.createElement('h2')
  heading.textContent = title

  section.append(heading, ...rows)

  return section
}

function createFundamentalsDetails(stock) {
  const details = document.createElement('details')
  details.className = 'fundamentals-details'

  const summary = document.createElement('summary')
  summary.textContent = 'Fundamentals'
  details.append(summary)

  const fundamentals = stock.fundamentals

  if (!fundamentals || fundamentals.error) {
    const message = document.createElement('p')
    message.className = 'fundamentals-message'
    message.textContent = fundamentals?.error
      ? `Fundamentals unavailable: ${fundamentals.error}`
      : 'Fundamentals unavailable for this ticker.'
    details.append(message)
    return details
  }

  const body = document.createElement('div')
  body.className = 'fundamentals-body'
  const currency = fundamentals.currency || stock.currency

  body.append(
    createFundamentalSection(`${fundamentals.latestPeriodLabel || 'Latest quarter'}${fundamentals.asOfDate ? ` · ${fundamentals.asOfDate}` : ''}`, [
      createFundamentalRow('Revenue', fundamentals.quarter.revenue, { currency }),
      createFundamentalRow('Gross profit', fundamentals.quarter.grossProfit, { currency }),
      createFundamentalRow('Operating income', fundamentals.quarter.operatingIncome, { currency }),
      createFundamentalRow('EBITDA', fundamentals.quarter.ebitda, { currency }),
      createFundamentalRow('Net income', fundamentals.quarter.netIncome, { currency }),
      createFundamentalRow('Free cash flow', fundamentals.quarter.freeCashFlow, { currency }),
      createFundamentalRow('Profit margin', fundamentals.quarter.profitMargin, { percent: true }),
    ]),
    createFundamentalSection('Trailing 12 months', [
      createFundamentalRow('Revenue', fundamentals.ttm.revenue, { currency }),
      createFundamentalRow('EBITDA', fundamentals.ttm.ebitda, { currency }),
      createFundamentalRow('Net income', fundamentals.ttm.netIncome, { currency }),
      createFundamentalRow('Free cash flow', fundamentals.ttm.freeCashFlow, { currency }),
      createFundamentalRow('EBITDA margin', fundamentals.ttm.ebitdaMargin, { percent: true }),
      createFundamentalRow('Profit margin', fundamentals.ttm.profitMargin, { percent: true }),
      createFundamentalRow('FCF margin', fundamentals.ttm.freeCashFlowMargin, { percent: true }),
    ]),
    createFundamentalSection('Balance sheet', [
      createFundamentalRow('Cash + short-term investments', fundamentals.balanceSheet.cash, { currency }),
      createFundamentalRow('Total debt', fundamentals.balanceSheet.totalDebt, { currency }),
      createFundamentalRow('Net cash / debt', fundamentals.balanceSheet.netCash, { currency }),
    ]),
  )

  const source = document.createElement('p')
  source.className = 'fundamentals-source'
  source.textContent = fundamentals.source || 'Yahoo Finance fundamentals'
  body.append(source)
  details.append(body)

  return details
}

function renderStocks(stocks) {
  const openFundamentals = new Set(
    Array.from(stockList.querySelectorAll('.fundamentals-details[open]'))
      .map((details) => details.dataset.ticker)
      .filter(Boolean),
  )

  stockList.replaceChildren()

  for (const stock of stocks) {
    const card = document.createElement('article')
    const change = Number(stock.changes?.daily?.amount ?? stock.change)
    card.className = 'stock-card'
    card.dataset.ticker = stock.ticker
    card.draggable = true
    card.addEventListener('dragstart', startStockDrag)
    card.addEventListener('dragend', finishStockDrag)

    if (Number.isFinite(change)) {
      card.classList.add(change >= 0 ? 'is-up' : 'is-down')
    }

    const topLine = document.createElement('div')
    topLine.className = 'stock-top-line'

    const ticker = document.createElement('div')
    ticker.className = 'stock-ticker'
    ticker.textContent = stock.ticker

    if (stock.buffettTag) {
      const buffettTag = document.createElement('span')
      buffettTag.className = 'buffett-tag'
      buffettTag.title = 'Warren Buffett / Berkshire Hathaway has bought this stock in the past'
      buffettTag.textContent = 'BUF'
      ticker.append(buffettTag)
    }

    const price = document.createElement('div')
    price.className = 'stock-price'
    price.textContent = formatPrice(stock)

    const priceStack = document.createElement('div')
    priceStack.className = 'stock-price-stack'
    priceStack.append(price)

    const ptsPrice = formatPtsPrice(stock)

    if (ptsPrice) {
      const ptsNode = document.createElement('div')
      ptsNode.className = 'pts-price'
      ptsNode.title = stock.pts.updatedAtText
        ? `${stock.pts.source || 'PTS'} · ${stock.pts.updatedAtText}`
        : stock.pts.source || 'PTS'
      ptsNode.textContent = `PTS ${ptsPrice}`
      priceStack.append(ptsNode)
    }

    const buyButton = document.createElement('button')
    buyButton.className = 'buy-button'
    buyButton.type = 'button'
    buyButton.textContent = 'Buy'
    buyButton.addEventListener('click', () => {
      openBuyModal(stock)
    })

    const priceActions = document.createElement('div')
    priceActions.className = 'stock-price-actions'
    priceActions.append(priceStack, buyButton)

    topLine.append(ticker, priceActions)

    const name = document.createElement('div')
    name.className = 'stock-name'
    name.textContent = stock.name

    const meta = document.createElement('div')
    meta.className = 'stock-meta'

    const exchange = document.createElement('span')
    exchange.textContent = stock.exchange

    const changeNode = document.createElement('span')
    changeNode.className = 'stock-change'
    changeNode.textContent = `1D ${formatChange(stock, stock.changes?.daily || {
      amount: stock.change,
      percent: stock.changePercent,
    })}`

    const source = document.createElement('span')
    source.textContent = stock.source || 'Seeded'

    const changeGrid = document.createElement('div')
    changeGrid.className = 'change-grid'
    changeGrid.append(
      createChangePill(stock, '1D', stock.changes?.daily || {
        amount: stock.change,
        percent: stock.changePercent,
      }),
      createChangePill(stock, '6M', stock.changes?.sixMonth),
      createChangePill(stock, 'YoY', stock.changes?.oneYear),
    )

    meta.append(exchange, changeNode, source)
    const fundamentalsDetails = createFundamentalsDetails(stock)
    fundamentalsDetails.dataset.ticker = stock.ticker
    fundamentalsDetails.open = openFundamentals.has(stock.ticker)

    card.append(topLine, name, changeGrid, meta, createPracticeLog(stock), fundamentalsDetails)
    stockList.append(card)
  }
}

async function loadSeededStocks() {
  const stocks = await window.widgetWindow.getSeededStocks()
  setStocks(stocks)
}

async function refreshQuotes() {
  if (isRefreshing) {
    return
  }

  isRefreshing = true
  refreshButton.disabled = true
  lastUpdated.textContent = 'Refreshing prices…'

  try {
    const result = await window.widgetWindow.fetchQuotes()
    const orderedQuotes = setStocks(result.quotes)
    const refreshInterval = scheduleNextRefresh(orderedQuotes)
    const marketSummary = isMarketOpen(orderedQuotes) ? 'market open' : 'market closed'
    lastUpdated.textContent = `${formatUpdatedAt(result.updatedAt)} · ${orderedQuotes.length} tickers · ${marketSummary} · next ${formatRefreshInterval(refreshInterval)}`
  } catch (error) {
    const stocks = Array.from(quotesByTicker.values())
    renderStocks(stocks)
    scheduleNextRefresh(stocks)
    lastUpdated.textContent = `Refresh failed: ${error.message}`
  } finally {
    isRefreshing = false
    refreshButton.disabled = false
  }
}

for (const handle of document.querySelectorAll('[data-resize-handle]')) {
  handle.addEventListener('mousedown', startResize)
}

shrinkButton.addEventListener('click', () => {
  setCompactMode(true)
})

refreshButton.addEventListener('click', () => {
  refreshQuotes()
})

stockList.addEventListener('dragover', moveStockDrag)
stockList.addEventListener('drop', finishStockDrag)

compactLauncher.addEventListener('mousedown', startCompactDrag)

buyForm.addEventListener('submit', (event) => {
  event.preventDefault()
  saveActivePracticeBuy()
})

buyModalClose.addEventListener('click', () => {
  closeBuyModal()
})

buyCancelButton.addEventListener('click', () => {
  closeBuyModal()
})

buyModal.addEventListener('click', (event) => {
  if (event.target === buyModal) {
    closeBuyModal()
  }
})

buyModal.addEventListener('close', () => {
  activeBuyStock = null
})

window.widgetWindow.onCompactModeChanged((compact) => {
  applyCompactMode(compact)
})

window.widgetWindow.onRefreshQuotes(() => {
  refreshQuotes()
})

window.addEventListener('beforeunload', () => {
  if (autoRefreshTimer) {
    clearTimeout(autoRefreshTimer)
  }
})

loadSeededStocks().then(refreshQuotes)
