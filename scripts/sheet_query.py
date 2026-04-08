#!/usr/bin/env python3
"""
sheet_query.py
--------------
Fetches data from the WEH Ventures Google Sheet and returns it as structured
JSON. Handles OAuth token refresh automatically using google-token.json.

Tab schemas:
  Sheet1            — Inbound contacts  (Timestamp, Name, Industry, Description, Logged By, Team Meeting, Notes)
  Outbound Contacts — Outbound outreach (Date, Name, Company Name, Industry, Description, Logged By, Reverted?, Email, Remarks, Team Meeting)
  Referrals         — Referral tracking (Date, Name, Company Name, Industry, Description, Direction, Logged By, Reverted?, Email, Remarks, Priority, Team Meeting)
  Team meetings     — Deal pipeline     (Company, Date, POC, Sector, Status, Why is this exciting?, Risks, Conviction Score (on 10), Reasons for Pass, Reasons to watch, Action required)

Usage:
  python3 sheet_query.py --tab "Sheet1" [--filter-month March] [--filter-year 2025] [--filter-keyword fintech] [--limit 500]

Returns JSON to stdout:
  { "tab": "Sheet1", "total_rows": 120, "filtered_count": 14, "returned_count": 14, "columns": [...], "rows": [...] }
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

SPREADSHEET_ID = '1Nosp-GCCPp3gZJ3NM1JwPjHfknFCS8Ir7c3MuevuFhQ'

MONTH_MAP = {
    'january': 1,   'jan': 1,
    'february': 2,  'feb': 2,
    'march': 3,     'mar': 3,
    'april': 4,     'apr': 4,
    'may': 5,
    'june': 6,      'jun': 6,
    'july': 7,      'jul': 7,
    'august': 8,    'aug': 8,
    'september': 9, 'sep': 9,
    'october': 10,  'oct': 10,
    'november': 11, 'nov': 11,
    'december': 12, 'dec': 12,
}

# Date columns (compared case-insensitively)
DATE_COLUMNS = {'timestamp', 'date'}

# ─── Token helpers ────────────────────────────────────────────────────────────

def find_token_path():
    token_file = os.environ.get('GOOGLE_TOKEN_PATH', 'google-token.json')
    candidates = [
        token_file,
        os.path.join(os.getcwd(), token_file),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', token_file),
    ]
    for p in candidates:
        if os.path.exists(p):
            return os.path.abspath(p)
    raise FileNotFoundError(f'google-token.json not found. Searched: {candidates}')


def load_tokens():
    path = find_token_path()
    with open(path, 'r') as f:
        return json.load(f), path


def save_tokens(path, tokens):
    with open(path, 'w') as f:
        json.dump(tokens, f, indent=2)


def refresh_access_token(tokens, path):
    client_id = os.environ.get('CLIENT_ID')
    client_secret = os.environ.get('CLIENT_SECRET')
    if not client_id or not client_secret:
        raise EnvironmentError('CLIENT_ID / CLIENT_SECRET env vars not set')
    if not tokens.get('refresh_token'):
        raise ValueError('No refresh_token in google-token.json — re-run authorizeGoogleDrive.js')

    data = urlencode({
        'client_id': client_id,
        'client_secret': client_secret,
        'refresh_token': tokens['refresh_token'],
        'grant_type': 'refresh_token',
    }).encode()

    req = Request('https://oauth2.googleapis.com/token', data=data, method='POST')
    with urlopen(req) as resp:
        refreshed = json.loads(resp.read())

    tokens['access_token'] = refreshed['access_token']
    tokens['expiry_date'] = (
        int(datetime.now().timestamp() * 1000) + refreshed.get('expires_in', 3600) * 1000
    )
    if 'refresh_token' in refreshed:
        tokens['refresh_token'] = refreshed['refresh_token']

    save_tokens(path, tokens)
    return tokens['access_token']


def get_access_token():
    tokens, path = load_tokens()
    now_ms = int(datetime.now().timestamp() * 1000)
    expiry = tokens.get('expiry_date', 0)
    if tokens.get('access_token') and (expiry - now_ms) > 60_000:
        return tokens['access_token']
    return refresh_access_token(tokens, path)


# ─── Sheets API ───────────────────────────────────────────────────────────────

def fetch_tab(access_token, tab_name):
    url = (
        f'https://sheets.googleapis.com/v4/spreadsheets/{SPREADSHEET_ID}'
        f'/values/{quote(tab_name)}'
    )
    req = Request(url, headers={'Authorization': f'Bearer {access_token}'})
    try:
        with urlopen(req) as resp:
            data = json.loads(resp.read())
        return data.get('values', [])
    except HTTPError as e:
        body = e.read().decode('utf-8', errors='replace')[:300]
        raise RuntimeError(f'Sheets API error for "{tab_name}" ({e.code}): {body}')


# ─── Date parsing ─────────────────────────────────────────────────────────────

DATE_PATTERN = re.compile(r'^(\d{1,2})/(\d{1,2})/(\d{4})')


def parse_date(val):
    """
    Parses M/D/YYYY or M/D/YYYY H:MM:SS format (Google Sheets default).
    Returns a dict with month/day/year/formatted, or None if not parseable.
    """
    if not val:
        return None
    val = str(val).strip()

    m = DATE_PATTERN.match(val)
    if m:
        month, day, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
        try:
            dt = datetime(year, month, day)
            return {
                'month': month,
                'day': day,
                'year': year,
                'formatted': dt.strftime('%-d %B %Y'),  # e.g. "5 March 2025"
            }
        except ValueError:
            pass

    # Fallback: try ISO / other formats
    for fmt in ('%Y-%m-%d', '%d-%m-%Y', '%d/%m/%Y'):
        try:
            dt = datetime.strptime(val[:10], fmt)
            return {
                'month': dt.month, 'day': dt.day, 'year': dt.year,
                'formatted': dt.strftime('%-d %B %Y'),
            }
        except ValueError:
            continue

    return None


# ─── Header cleaning ─────────────────────────────────────────────────────────

def clean_header(h):
    """
    Clean a raw header string from the Google Sheets API.
    The Sheet1 tab has a garbled '\u0192C' (ƒC) character for the Timestamp column.
    """
    h = str(h or '').replace('\xa0', ' ').strip()

    # Handle the garbled ƒC Timestamp header from Sheet1
    if '\u0192' in h or h == '\x83C':
        return 'Timestamp'

    return h


# ─── Grid → records ──────────────────────────────────────────────────────────

def grid_to_records(rows):
    """Convert a grid (list of lists) to (headers, list of dicts) with parsed dates."""
    if not rows or len(rows) < 2:
        return [], []

    headers = [clean_header(h) for h in rows[0]]
    records = []

    for row in rows[1:]:
        # Skip entirely blank rows
        if not any(cell for cell in row if str(cell).strip()):
            continue

        record = {}
        for i, header in enumerate(headers):
            if not header:
                continue
            val = str(row[i]).strip() if i < len(row) and row[i] is not None else ''

            if header.lower() in DATE_COLUMNS:
                parsed = parse_date(val)
                if parsed:
                    record[header] = parsed['formatted']
                    # Hidden metadata for filtering (stripped before output)
                    record[f'__{header}_month'] = parsed['month']
                    record[f'__{header}_year'] = parsed['year']
                else:
                    record[header] = val
            else:
                record[header] = val

        records.append(record)

    return headers, records


# ─── Filtering ───────────────────────────────────────────────────────────────

def filter_records(records, filter_month=None, filter_year=None, filter_keyword=None):
    result = records

    if filter_month:
        month_num = MONTH_MAP.get(filter_month.lower())
        if month_num:
            result = [
                r for r in result
                if r.get('__Timestamp_month') == month_num
                or r.get('__Date_month') == month_num
            ]

    if filter_year:
        year = int(filter_year)
        result = [
            r for r in result
            if r.get('__Timestamp_year') == year
            or r.get('__Date_year') == year
        ]

    if filter_keyword:
        kw = filter_keyword.lower()
        result = [
            r for r in result
            if any(
                kw in str(v).lower()
                for k, v in r.items()
                if not k.startswith('__')
            )
        ]

    return result


def strip_internal(records):
    """Remove __ prefixed metadata fields before output."""
    return [{k: v for k, v in r.items() if not k.startswith('__')} for r in records]


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Query WEH Ventures Google Sheet')
    parser.add_argument('--tab', required=True,
                        choices=['Sheet1', 'Outbound Contacts', 'Referrals', 'Team meetings'],
                        help='Sheet tab name')
    parser.add_argument('--filter-month', default=None,
                        help='Month name to filter by (e.g. March)')
    parser.add_argument('--filter-year', default=None,
                        help='4-digit year to filter by (e.g. 2025)')
    parser.add_argument('--filter-keyword', default=None,
                        help='Keyword or company name to filter across all columns')
    parser.add_argument('--limit', type=int, default=500,
                        help='Max rows to return (default 500)')
    args = parser.parse_args()

    try:
        access_token = get_access_token()
        grid = fetch_tab(access_token, args.tab)
        headers, records = grid_to_records(grid)

        total_rows = len(records)
        filtered = filter_records(
            records,
            filter_month=args.filter_month,
            filter_year=args.filter_year,
            filter_keyword=args.filter_keyword,
        )
        # Compute year breakdown from ALL filtered rows (before limit)
        # This lets the LLM answer per-year count questions precisely
        filtered_count = len(filtered)
        year_field_candidates = ['__Timestamp_year', '__Date_year']
        year_breakdown = {}
        for r in filtered:
            year = None
            for field in year_field_candidates:
                if field in r:
                    year = r[field]
                    break
            if year is not None:
                year_breakdown[str(year)] = year_breakdown.get(str(year), 0) + 1
        # Sort by year ascending
        year_breakdown_sorted = dict(sorted(year_breakdown.items()))

        limited = filtered[:args.limit]
        clean = strip_internal(limited)

        result = {
            'tab': args.tab,
            'total_rows': total_rows,
            'filtered_count': filtered_count,
            'year_breakdown': year_breakdown_sorted,   # e.g. {"2023": 45, "2024": 67, "2026": 71}
            'returned_count': len(clean),
            'columns': [h for h in headers if h],
            'rows': clean,
        }
        print(json.dumps(result, ensure_ascii=False))

    except Exception as exc:
        print(json.dumps({'error': str(exc), 'tab': args.tab}))
        sys.exit(1)


if __name__ == '__main__':
    main()
