const POSITIVE_SIGNALS = [
  { pattern: /raises?|raised|secures?|secured|closes?|closed|funding|round/i, weight: 15, category: 'Funding Round' },
  { pattern: /profitable|profitability|profit|breakeven/i, weight: 20, category: 'Profitability' },
  { pattern: /revenue.*(grew|grows?|surged?|jumped?|doubled|tripled|3x|5x)/i, weight: 18, category: 'Revenue Growth' },
  { pattern: /ipo|public listing|listing|market debut/i, weight: 12, category: 'IPO / Listing' },
  { pattern: /launches?|launched|unveils?|introduces?|announces?/i, weight: 8, category: 'Product Launch' },
  { pattern: /partnership|partners with|collaborat|mou|tie[-\s]?up/i, weight: 8, category: 'Partnership' },
  { pattern: /award|wins?|won|recognition|named|best/i, weight: 6, category: 'Award / Recognition' },
  { pattern: /expansion|expand|scale|new market|enters?/i, weight: 10, category: 'Expansion' },
  { pattern: /exit|divest|acquired|acquisition|merger/i, weight: 10, category: 'M&A / Exit' },
  { pattern: /million users?|lakh users?|crore users?|milestone|record/i, weight: 8, category: 'Growth Milestone' }
]

const NEGATIVE_SIGNALS = [
  { pattern: /probe|fir|cid|investigation|raid|chargesheet|complaint/i, weight: -25, category: 'Regulatory & Legal' },
  { pattern: /laid off|layoff|retrench|job cuts?|let go/i, weight: -20, category: 'Layoffs' },
  { pattern: /written.?off|write.?off|impair/i, weight: -30, category: 'Write-off' },
  { pattern: /fraud|scam|cheat|misappropriat/i, weight: -30, category: 'Fraud / Misconduct' },
  { pattern: /deal falls through|fell through|deal collapse|valuation gap/i, weight: -15, category: 'Deal Breakdown' },
  { pattern: /losses? widen|losses? grew|burn rate|runway concern/i, weight: -12, category: 'Financial Risk' },
  { pattern: /shutdown|shut down|wound up|closure|bankrupt/i, weight: -35, category: 'Shutdown' },
  { pattern: /lawsuit|sued|litigation|legal notice/i, weight: -18, category: 'Legal Risk' },
  { pattern: /concern|risk|warn|caution|delay/i, weight: -6, category: 'Risk / Concern' }
]

const WATCH_TRIGGERS = [
  /investigation|probe|cid|fir|raid/i,
  /written.?off|write.?off/i,
  /shutdown|bankrupt|wound up/i,
  /fraud|scam/i
]

export function classifySentiment(title = '', summary = '') {
  const text = `${title} ${summary}`.toLowerCase()
  let score = 50
  let category = 'General Update'

  for (const sig of POSITIVE_SIGNALS) {
    if (sig.pattern.test(text)) {
      score += sig.weight
      category = sig.category
    }
  }

  for (const sig of NEGATIVE_SIGNALS) {
    if (sig.pattern.test(text)) {
      score += sig.weight
      category = sig.category
    }
  }

  score = Math.min(100, Math.max(0, score))

  let sentiment
  if (WATCH_TRIGGERS.some((p) => p.test(text))) {
    sentiment = 'watch'
  } else if (score >= 65) {
    sentiment = 'positive'
  } else if (score <= 35) {
    sentiment = 'negative'
  } else {
    sentiment = 'neutral'
  }

  return { sentiment, score: Number(score.toFixed(2)), category }
}
