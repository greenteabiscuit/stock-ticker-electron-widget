const { app, BrowserWindow, Menu, ipcMain, screen, globalShortcut } = require('electron')
const path = require('node:path')

const MIN_WIDTH = 340
const MIN_HEIGHT = 360
const DEFAULT_WIDTH = 440
const DEFAULT_HEIGHT = 560
const COMPACT_SIZE = 64
const TOGGLE_COMPACT_SHORTCUT = 'Control+Shift+K'
const QUOTE_TIMEOUT_MS = 8000
const FUNDAMENTAL_TYPES = [
  'quarterlyTotalRevenue',
  'quarterlyGrossProfit',
  'quarterlyOperatingIncome',
  'quarterlyEBITDA',
  'quarterlyNetIncome',
  'quarterlyFreeCashFlow',
  'quarterlyTotalDebt',
  'quarterlyCashCashEquivalentsAndShortTermInvestments',
  'annualTotalRevenue',
  'annualGrossProfit',
  'annualOperatingIncome',
  'annualEBITDA',
  'annualNetIncome',
  'annualFreeCashFlow',
  'annualTotalDebt',
  'annualCashCashEquivalentsAndShortTermInvestments',
  'trailingTotalRevenue',
  'trailingEBITDA',
  'trailingNetIncome',
  'trailingFreeCashFlow',
]

const SEEDED_STOCKS = [
  {
    ticker: '8001.T',
    name: 'Itochu Corporation',
    exchange: 'TSE',
    currency: 'JPY',
    seededPrice: 7800,
    buffettTag: true,
  },
  {
    ticker: 'AB',
    name: 'AllianceBernstein Holding L.P.',
    exchange: 'NYSE',
    currency: 'USD',
    seededPrice: 38.5,
  },
  {
    ticker: 'AXP',
    name: 'American Express Company',
    exchange: 'NYSE',
    currency: 'USD',
    seededPrice: 305,
    buffettTag: true,
  },
  {
    ticker: 'NVDA',
    name: 'NVIDIA Corporation',
    exchange: 'NASDAQ',
    currency: 'USD',
    seededPrice: 135,
  },
  {
    ticker: 'GOOGL',
    name: 'Alphabet Inc. (Google)',
    exchange: 'NASDAQ',
    currency: 'USD',
    seededPrice: 402.62,
    buffettTag: true,
  },
  {
    ticker: '8766.T',
    name: 'Tokio Marine Holdings, Inc.',
    exchange: 'TSE',
    currency: 'JPY',
    seededPrice: 7362,
    buffettTag: true,
  },
  {
    ticker: '6098.T',
    name: 'Recruit Holdings Co., Ltd.',
    exchange: 'TSE',
    currency: 'JPY',
    seededPrice: 7780,
  },
  {
    ticker: '285A.T',
    name: 'キオクシア / Kioxia Holdings Corp.',
    exchange: 'TSE',
    currency: 'JPY',
    seededPrice: 48460,
  },
  {
    ticker: '7011.T',
    name: 'Mitsubishi Heavy Industries, Ltd. (MHI)',
    exchange: 'TSE',
    currency: 'JPY',
    seededPrice: 4162,
  },
  {
    ticker: '5803.T',
    name: 'フジクラ / Fujikura Ltd.',
    exchange: 'TSE',
    currency: 'JPY',
    seededPrice: 6355,
  },
  {
    ticker: '6857.T',
    name: 'アドテスト / Advantest Corp.',
    exchange: 'TSE',
    currency: 'JPY',
    seededPrice: 28615,
  },
]

function setCompactMode(win, compact) {
  const shouldCompact = Boolean(compact)

  if (!win || win.isDestroyed() || shouldCompact === Boolean(win.isCompact)) {
    return
  }

  if (shouldCompact) {
    win.expandedBounds = win.getBounds()

    const expandedBounds = win.expandedBounds

    win.isCompact = true
    win.setMinimumSize(COMPACT_SIZE, COMPACT_SIZE)
    win.setBounds({
      x: expandedBounds.x + expandedBounds.width - COMPACT_SIZE,
      y: expandedBounds.y,
      width: COMPACT_SIZE,
      height: COMPACT_SIZE,
    })
  } else {
    const compactBounds = win.getBounds()
    const expandedBounds = win.expandedBounds || { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }

    win.isCompact = false
    win.setMinimumSize(MIN_WIDTH, MIN_HEIGHT)
    win.setBounds({
      ...expandedBounds,
      x: compactBounds.x + COMPACT_SIZE - expandedBounds.width,
      y: compactBounds.y,
    })
  }

  win.webContents.send('compact-mode-changed', shouldCompact)
}

function getWidgetWindow() {
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed())
}

function registerGlobalShortcuts() {
  const registered = globalShortcut.register(TOGGLE_COMPACT_SHORTCUT, () => {
    const win = getWidgetWindow()

    if (!win) {
      return
    }

    setCompactMode(win, !win.isCompact)
  })

  if (!registered) {
    console.warn(`Failed to register shortcut: ${TOGGLE_COMPACT_SHORTCUT}`)
  }
}

function getSeededStocks() {
  return SEEDED_STOCKS.map((stock) => ({ ...stock }))
}

function addMonths(date, months) {
  const nextDate = new Date(date)

  nextDate.setMonth(nextDate.getMonth() + months)

  return nextDate
}

function getChange(price, baselinePrice) {
  if (!Number.isFinite(price) || !Number.isFinite(baselinePrice) || baselinePrice === 0) {
    return {
      amount: null,
      percent: null,
    }
  }

  const amount = price - baselinePrice

  return {
    amount,
    percent: (amount / baselinePrice) * 100,
  }
}

function getHistoricalClose(chartResult, targetDate) {
  const timestamps = chartResult?.timestamp || []
  const closes = chartResult?.indicators?.quote?.[0]?.close || []
  const targetMs = targetDate.getTime()
  let fallbackClose = null

  for (let index = 0; index < timestamps.length; index += 1) {
    const close = Number(closes[index])

    if (!Number.isFinite(close)) {
      continue
    }

    if (fallbackClose === null) {
      fallbackClose = close
    }

    if (timestamps[index] * 1000 > targetMs) {
      break
    }

    fallbackClose = close
  }

  return fallbackClose
}

function getPreviousDailyClose(chartResult) {
  const closes = chartResult?.indicators?.quote?.[0]?.close || []
  const finiteCloses = closes
    .map((close) => Number(close))
    .filter((close) => Number.isFinite(close))

  if (finiteCloses.length < 2) {
    return null
  }

  return finiteCloses[finiteCloses.length - 2]
}

function getJapaneseTickerCode(ticker) {
  const match = String(ticker).match(/^([0-9A-Z]+)\.T$/)

  return match ? match[1] : null
}

function parseNumber(value) {
  const normalized = String(value || '').replace(/,/g, '')
  const number = Number(normalized)

  return Number.isFinite(number) ? number : null
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
}

function stripTags(value) {
  return decodeHtml(String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
}

function getFundamentalRows(timeseriesResult, type) {
  const entry = timeseriesResult.find((item) => item?.meta?.type?.[0] === type)
  const rows = entry?.[type] || []

  return rows
    .map((row) => ({
      asOfDate: row.asOfDate,
      currency: row.currencyCode,
      periodType: row.periodType,
      value: Number(row.reportedValue?.raw),
      formattedValue: row.reportedValue?.fmt,
    }))
    .filter((row) => row.asOfDate && Number.isFinite(row.value))
    .sort((left, right) => left.asOfDate.localeCompare(right.asOfDate))
}

function getLatestFundamental(timeseriesResult, type) {
  const rows = getFundamentalRows(timeseriesResult, type)

  return rows[rows.length - 1] || null
}

function getFirstAvailableFundamental(timeseriesResult, types) {
  for (const type of types) {
    const row = getLatestFundamental(timeseriesResult, type)

    if (row) {
      return row
    }
  }

  return null
}

function getFirstAvailableSum(timeseriesResult, types) {
  for (const type of types) {
    const row = type.startsWith('quarterly')
      ? sumLatestFundamentals(timeseriesResult, type)
      : getLatestFundamental(timeseriesResult, type)

    if (row) {
      return row
    }
  }

  return null
}

function sumLatestFundamentals(timeseriesResult, type, count = 4) {
  const rows = getFundamentalRows(timeseriesResult, type)
  const latestRows = rows.slice(-count)

  if (latestRows.length === 0) {
    return null
  }

  return {
    asOfDate: latestRows[latestRows.length - 1].asOfDate,
    currency: latestRows[latestRows.length - 1].currency,
    value: latestRows.reduce((total, row) => total + row.value, 0),
    periodCount: latestRows.length,
  }
}

function divideMetric(numerator, denominator) {
  if (!Number.isFinite(numerator?.value) || !Number.isFinite(denominator?.value) || denominator.value === 0) {
    return null
  }

  return numerator.value / denominator.value
}

function buildFundamentals(timeseriesResult) {
  const latestRevenue = getFirstAvailableFundamental(timeseriesResult, ['quarterlyTotalRevenue', 'annualTotalRevenue'])
  const latestGrossProfit = getFirstAvailableFundamental(timeseriesResult, ['quarterlyGrossProfit', 'annualGrossProfit'])
  const latestOperatingIncome = getFirstAvailableFundamental(timeseriesResult, ['quarterlyOperatingIncome', 'annualOperatingIncome'])
  const latestEbitda = getFirstAvailableFundamental(timeseriesResult, ['quarterlyEBITDA', 'annualEBITDA'])
  const latestNetIncome = getFirstAvailableFundamental(timeseriesResult, ['quarterlyNetIncome', 'annualNetIncome'])
  const latestFreeCashFlow = getFirstAvailableFundamental(timeseriesResult, ['quarterlyFreeCashFlow', 'annualFreeCashFlow'])
  const latestDebt = getFirstAvailableFundamental(timeseriesResult, ['quarterlyTotalDebt', 'annualTotalDebt'])
  const latestCash = getFirstAvailableFundamental(timeseriesResult, [
    'quarterlyCashCashEquivalentsAndShortTermInvestments',
    'annualCashCashEquivalentsAndShortTermInvestments',
  ])
  const ttmRevenue = getFirstAvailableSum(timeseriesResult, ['quarterlyTotalRevenue', 'trailingTotalRevenue', 'annualTotalRevenue'])
  const ttmEbitda = getFirstAvailableSum(timeseriesResult, ['quarterlyEBITDA', 'trailingEBITDA', 'annualEBITDA'])
  const ttmNetIncome = getFirstAvailableSum(timeseriesResult, ['quarterlyNetIncome', 'trailingNetIncome', 'annualNetIncome'])
  const ttmFreeCashFlow = getFirstAvailableSum(timeseriesResult, ['quarterlyFreeCashFlow', 'trailingFreeCashFlow', 'annualFreeCashFlow'])

  if (!latestRevenue && !ttmRevenue && !latestNetIncome && !ttmNetIncome) {
    return null
  }

  return {
    asOfDate: latestRevenue?.asOfDate || latestNetIncome?.asOfDate || ttmRevenue?.asOfDate || null,
    currency: latestRevenue?.currency || ttmRevenue?.currency || latestNetIncome?.currency || null,
    latestPeriodLabel: latestRevenue?.periodType === '12M' ? 'Latest fiscal year' : 'Latest quarter',
    quarter: {
      revenue: latestRevenue,
      grossProfit: latestGrossProfit,
      operatingIncome: latestOperatingIncome,
      ebitda: latestEbitda,
      netIncome: latestNetIncome,
      freeCashFlow: latestFreeCashFlow,
      grossMargin: divideMetric(latestGrossProfit, latestRevenue),
      operatingMargin: divideMetric(latestOperatingIncome, latestRevenue),
      profitMargin: divideMetric(latestNetIncome, latestRevenue),
    },
    ttm: {
      revenue: ttmRevenue,
      ebitda: ttmEbitda,
      netIncome: ttmNetIncome,
      freeCashFlow: ttmFreeCashFlow,
      ebitdaMargin: divideMetric(ttmEbitda, ttmRevenue),
      profitMargin: divideMetric(ttmNetIncome, ttmRevenue),
      freeCashFlowMargin: divideMetric(ttmFreeCashFlow, ttmRevenue),
    },
    balanceSheet: {
      cash: latestCash,
      totalDebt: latestDebt,
      netCash: Number.isFinite(latestCash?.value) && Number.isFinite(latestDebt?.value)
        ? {
            asOfDate: latestCash.asOfDate,
            currency: latestCash.currency || latestDebt.currency,
            value: latestCash.value - latestDebt.value,
          }
        : null,
    },
    source: 'Yahoo Finance fundamentals',
  }
}

function normalizeQuote(stock, chartResult) {
  const quoteMeta = chartResult?.meta
  const marketPrice = Number(quoteMeta?.regularMarketPrice ?? quoteMeta?.previousClose)
  const price = Number.isFinite(marketPrice) ? marketPrice : stock.seededPrice
  const previousClose = Number(quoteMeta?.previousClose ?? getPreviousDailyClose(chartResult) ?? quoteMeta?.chartPreviousClose)
  const now = new Date()
  const sixMonthClose = getHistoricalClose(chartResult, addMonths(now, -6))
  const oneYearClose = getHistoricalClose(chartResult, addMonths(now, -12))
  const dailyChange = getChange(price, previousClose)
  const sixMonthChange = getChange(price, sixMonthClose)
  const oneYearChange = getChange(price, oneYearClose)

  return {
    ...stock,
    price,
    currency: quoteMeta?.currency || stock.currency,
    exchange: quoteMeta?.exchangeName || stock.exchange,
    marketState: quoteMeta?.marketState || 'seeded',
    change: dailyChange.amount,
    changePercent: dailyChange.percent,
    changes: {
      daily: dailyChange,
      sixMonth: sixMonthChange,
      oneYear: oneYearChange,
    },
    updatedAt: new Date().toISOString(),
    source: Number.isFinite(marketPrice) ? 'Yahoo Finance' : 'Seeded fallback',
  }
}

async function fetchJson(url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), QUOTE_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
      },
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`Request returned ${response.status}`)
    }

    return response.json()
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchText(url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), QUOTE_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'Mozilla/5.0',
      },
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`Request returned ${response.status}`)
    }

    return response.text()
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchFundamentals(stock) {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const period1 = nowSeconds - 60 * 60 * 24 * 365 * 3
  const period2 = nowSeconds + 60 * 60 * 24 * 45
  const encodedTicker = encodeURIComponent(stock.ticker)
  const url = `https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodedTicker}?symbol=${encodedTicker}&type=${FUNDAMENTAL_TYPES.join(',')}&period1=${period1}&period2=${period2}`

  try {
    const payload = await fetchJson(url)
    const timeseriesResult = payload?.timeseries?.result || []

    return buildFundamentals(timeseriesResult)
  } catch (error) {
    console.warn(`Could not fetch fundamentals for ${stock.ticker}:`, error)

    return {
      error: error.message,
      source: 'Yahoo Finance fundamentals',
    }
  }
}

async function fetchPtsQuote(stock) {
  const code = getJapaneseTickerCode(stock.ticker)

  if (!code) {
    return null
  }

  try {
    const html = await fetchText(`https://kabutan.jp/stock/chart?code=${encodeURIComponent(code)}`)
    const match = html.match(/<div class="kabuka1">\s*PTS\s*<\/div>\s*<div class="kabuka2">([\s\S]*?)<\/div>\s*<div class="kabuka3">([\s\S]*?)<\/div>/)

    if (!match) {
      return null
    }

    const price = parseNumber(stripTags(match[1]).replace(/円/g, ''))

    if (!Number.isFinite(price)) {
      return null
    }

    return {
      price,
      currency: 'JPY',
      updatedAtText: stripTags(match[2]).replace(/\s+/g, ' '),
      source: 'Kabutan PTS / Japannext',
    }
  } catch (error) {
    console.warn(`Could not fetch PTS quote for ${stock.ticker}:`, error)
    return null
  }
}

async function fetchQuote(stock) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(stock.ticker)}?range=1y&interval=1d`

  try {
    const [payload, fundamentals, pts] = await Promise.all([
      fetchJson(url),
      fetchFundamentals(stock),
      fetchPtsQuote(stock),
    ])
    const result = payload?.chart?.result?.[0]

    if (!result?.meta) {
      throw new Error('Yahoo Finance response did not include quote metadata')
    }

    return {
      ...normalizeQuote(stock, result),
      fundamentals,
      pts,
    }
  } catch (error) {
    console.warn(`Could not fetch quote for ${stock.ticker}:`, error)

    return {
      ...normalizeQuote(stock, null),
      error: error.message,
    }
  }
}

async function fetchQuotes() {
  const quotes = await Promise.all(SEEDED_STOCKS.map(fetchQuote))

  return {
    quotes,
    updatedAt: new Date().toISOString(),
  }
}

function createWidgetWindow() {
  const { workArea } = screen.getPrimaryDisplay()
  const height = Math.min(DEFAULT_HEIGHT, Math.floor(workArea.height * 0.72))

  const win = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height,
    x: 40,
    y: workArea.y + Math.floor((workArea.height - height) / 2),
    frame: false,
    resizable: true,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: -100, y: -100 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Match the local widget pattern: keep the floating widget private during screen capture.
  win.setContentProtection(true)
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.loadFile(path.join(__dirname, 'index.html'))

  const menu = Menu.buildFromTemplate([
    { label: 'Refresh prices', click: () => win.webContents.send('refresh-quotes') },
    { type: 'separator' },
    { label: 'Copy', role: 'copy' },
    { label: 'Select All', role: 'selectAll' },
    { type: 'separator' },
    { label: 'Quit widget', role: 'quit' },
  ])

  win.webContents.on('context-menu', () => {
    menu.popup({ window: win })
  })
}

ipcMain.on('resize-widget', (event, size) => {
  const win = BrowserWindow.fromWebContents(event.sender)

  if (!win || win.isCompact) {
    return
  }

  const width = Math.max(MIN_WIDTH, Math.round(Number(size.width) || 0))
  const height = Math.max(MIN_HEIGHT, Math.round(Number(size.height) || 0))

  win.setBounds({ width, height })
})

ipcMain.handle('get-widget-bounds', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)

  if (!win) {
    return null
  }

  return win.getBounds()
})

ipcMain.on('move-widget', (event, position) => {
  const win = BrowserWindow.fromWebContents(event.sender)

  if (!win) {
    return
  }

  const x = Math.round(Number(position.x) || 0)
  const y = Math.round(Number(position.y) || 0)

  win.setBounds({ x, y })
})

ipcMain.on('set-compact-mode', (event, compact) => {
  const win = BrowserWindow.fromWebContents(event.sender)

  setCompactMode(win, compact)
})

ipcMain.handle('get-seeded-stocks', () => getSeededStocks())
ipcMain.handle('fetch-quotes', () => fetchQuotes())

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    app.dock.hide()
  }

  createWidgetWindow()
  registerGlobalShortcuts()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWidgetWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
})
