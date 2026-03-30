// CRM theme palette used in the email renderer
// Light, warm background — matches the CRM UI
const THEME = {
  brandBg: '#FF7102',   // orange header
  brandBgAlt: '#FF8C2E',   // slightly lighter orange for stat row
  headerText: '#FFFFFF',
  headerSub: 'rgba(255,255,255,0.75)',
  bodyBg: '#FAFAF8',   // warm white — exact CRM page bg
  cardBg: '#FFFFFF',
  footerBg: '#F5F3EE',
  footerText: '#9A958E',
  border: '#E8E5DE',
  headingColor: '#1A1815',
  bodyText: '#3A3630',
  mutedText: '#9A958E',
}

const SENTIMENT_COLORS = {
  positive: { bg: '#E8F5EE', text: '#1A6B3C', label: '↑ Positive' },
  negative: { bg: '#FBF0F0', text: '#A32D2D', label: '↓ Negative' },
  watch: { bg: '#FFF8EC', text: '#92560A', label: '⚠ Watch' },
  neutral: { bg: '#F0EDE7', text: '#5A5650', label: '→ Neutral' },
}

const FUND_LABELS = { fund1: 'Fund I', fund2: 'Fund II', fund3: 'Fund III' }

export function renderIssue(issue) {
  const { title, period_label: periodLabel, segments, picks, stats, created_by: createdBy } = issue
  const publishedDate = issue.published_at
    ? new Date(issue.published_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
    : new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })

  const picksByFund = picks.reduce((acc, p) => {
    if (!acc[p.fund]) acc[p.fund] = []
    acc[p.fund].push(p)
    return acc
  }, {})

  const sectionsHtml = segments
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((seg) => renderSegment(seg, picksByFund))
    .join('\n')

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${escHtml(title)}</title></head>
<body style="margin:0;padding:0;background:${THEME.bodyBg};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${THEME.bodyBg};padding:32px 0;"><tr><td align="center">
<table width="620" cellpadding="0" cellspacing="0" border="0" style="max-width:620px;width:100%;border-radius:14px;overflow:hidden;border:1px solid ${THEME.border};box-shadow:0 2px 8px rgba(0,0,0,0.06);">
${renderHeader(title, periodLabel, publishedDate, stats)}${sectionsHtml}${renderFooter(createdBy)}
</table></td></tr></table></body></html>`
}

function renderHeader(title, periodLabel, date, stats) {
  return `<tr><td style="background:${THEME.brandBg};padding:28px 32px 0;border-radius:14px 14px 0 0;">
    <div style="display:inline-block;background:rgba(255,255,255,0.18);border-radius:6px;padding:3px 10px;font-size:10px;font-weight:700;letter-spacing:0.12em;color:rgba(255,255,255,0.9);text-transform:uppercase;margin-bottom:12px;">WEH Ventures</div>
    <div style="font-family:Georgia,serif;font-size:26px;color:${THEME.headerText};line-height:1.3;">${escHtml(title)}</div>
    ${periodLabel ? `<div style="font-size:13px;color:${THEME.headerSub};margin-top:5px;">${escHtml(periodLabel)}</div>` : ''}
    <div style="font-size:11px;color:${THEME.headerSub};margin-top:4px;">${escHtml(date)}</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;background:rgba(255,255,255,0.12);border-radius:8px;">
      <tr>
        <td style="text-align:center;padding:14px 8px;">
          <div style="font-size:22px;font-weight:600;color:#fff;">${stats.total_picks}</div>
          <div style="font-size:10px;color:${THEME.headerSub};margin-top:2px;">Stories</div>
        </td>
        <td style="text-align:center;padding:14px 8px;border-left:1px solid rgba(255,255,255,0.15);">
          <div style="font-size:22px;font-weight:600;color:#A8EFC4;">${stats.by_sentiment?.positive || 0}</div>
          <div style="font-size:10px;color:${THEME.headerSub};margin-top:2px;">Positive</div>
        </td>
        <td style="text-align:center;padding:14px 8px;border-left:1px solid rgba(255,255,255,0.15);">
          <div style="font-size:22px;font-weight:600;color:#FFD999;">${stats.by_sentiment?.watch || 0}</div>
          <div style="font-size:10px;color:${THEME.headerSub};margin-top:2px;">Watch</div>
        </td>
        <td style="text-align:center;padding:14px 8px;border-left:1px solid rgba(255,255,255,0.15);">
          <div style="font-size:22px;font-weight:600;color:#fff;">${Object.keys(stats.by_fund || {}).length}</div>
          <div style="font-size:10px;color:${THEME.headerSub};margin-top:2px;">Funds</div>
        </td>
      </tr>
    </table>
  </td></tr>`
}

function renderSegment(segment, picksByFund) {
  switch (segment.segment_type) {
    case 'portfolio_highlights': return renderPortfolioHighlights(picksByFund)
    case 'market_context': return renderTextSegment(segment, '#EDF4FD')
    case 'founder_spotlight': return renderFounderSpotlight(segment)
    default: return renderTextSegment(segment, THEME.bodyBg)
  }
}

function renderPortfolioHighlights(picksByFund) {
  if (!Object.keys(picksByFund).length) return ''
  const fundsHtml = ['fund1', 'fund2', 'fund3']
    .filter((f) => picksByFund[f]?.length)
    .map((fund) =>
      `<div style="margin-bottom:16px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${THEME.mutedText};padding:10px 0 8px;">${FUND_LABELS[fund]}</div>
        ${picksByFund[fund].map(renderPickCard).join('\n')}
      </div>`
    )
    .join('')
  return `<tr><td style="background:${THEME.cardBg};padding:28px 32px;border-top:1px solid ${THEME.border};">
    <div style="font-family:Georgia,serif;font-size:20px;color:${THEME.headingColor};margin-bottom:20px;">Portfolio Highlights</div>
    ${fundsHtml}
  </td></tr>`
}

function renderPickCard(pick) {
  const sc = SENTIMENT_COLORS[pick.sentiment] || SENTIMENT_COLORS.neutral
  const summary = pick.ai_summary || pick.summary || ''
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px;border:1px solid ${THEME.border};border-radius:10px;overflow:hidden;background:#fff;"><tr><td style="padding:14px 16px;">
    <div style="font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${THEME.mutedText};">${escHtml(pick.company_name)}</div>
    <div style="margin-top:6px;font-family:Georgia,serif;font-size:15px;color:${THEME.headingColor};line-height:1.4;">${escHtml(pick.title)}</div>
    ${summary ? `<div style="margin-top:5px;font-size:12px;color:${THEME.bodyText};line-height:1.6;">${escHtml(summary.slice(0, 220))}${summary.length > 220 ? '…' : ''}</div>` : ''}
    <span style="display:inline-block;padding:3px 10px;border-radius:20px;background:${sc.bg};color:${sc.text};font-size:10px;font-weight:700;margin-top:8px;">${sc.label}</span>
  </td></tr></table>`
}

function renderTextSegment(segment, bgColor) {
  if (!segment.title && !segment.body) return ''
  return `<tr><td style="background:${bgColor};padding:28px 32px;border-top:1px solid ${THEME.border};">
    ${segment.title ? `<div style="font-family:Georgia,serif;font-size:20px;color:${THEME.headingColor};margin-bottom:14px;">${escHtml(segment.title)}</div>` : ''}
    ${segment.body ? `<div style="font-size:14px;color:${THEME.bodyText};line-height:1.75;white-space:pre-wrap;">${escHtml(segment.body)}</div>` : ''}
  </td></tr>`
}

function renderFounderSpotlight(segment) {
  if (!segment.body) return ''
  return `<tr><td style="background:#FFF8F2;padding:28px 32px;border-top:1px solid ${THEME.border};border-left:4px solid ${THEME.brandBg};">
    ${segment.title ? `<div style="font-family:Georgia,serif;font-size:20px;color:${THEME.headingColor};margin-bottom:12px;">${escHtml(segment.title)}</div>` : ''}
    <div style="font-size:14px;color:${THEME.bodyText};line-height:1.75;white-space:pre-wrap;">${escHtml(segment.body)}</div>
  </td></tr>`
}

function renderFooter(createdBy) {
  return `<tr><td style="background:${THEME.footerBg};padding:18px 32px;border-top:1px solid ${THEME.border};border-radius:0 0 14px 14px;">
    <span style="font-size:12px;color:${THEME.footerText};">${createdBy ? `Prepared by ${escHtml(createdBy)}` : 'WEH Ventures Portfolio Intelligence'}</span>
  </td></tr>`
}

function escHtml(str) {
  if (!str) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
