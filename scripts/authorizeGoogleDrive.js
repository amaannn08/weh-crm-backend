/**
 * One-time script to authorize this app to access Google Drive via OAuth2.
 * Run: node scripts/authorizeGoogleDrive.js
 *
 * It starts a local HTTP server on port 3001, opens the auth URL,
 * Google redirects back with the code automatically — no manual pasting needed.
 * Tokens are saved to google-token.json.
 */
import 'dotenv/config'
import { google } from 'googleapis'
import { createServer } from 'http'
import { writeFileSync } from 'fs'
import { join } from 'path'

const CLIENT_ID = process.env.CLIENT_ID
const CLIENT_SECRET = process.env.CLIENT_SECRET
const PORT = 3001
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('CLIENT_ID and CLIENT_SECRET must be set in .env')
    process.exit(1)
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI)

const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/spreadsheets.readonly'
    ],
    prompt: 'consent'
})

// Start a temporary local server to catch the redirect
const server = createServer(async (req, res) => {
    if (!req.url?.startsWith('/oauth2callback')) {
        res.end('Not found')
        return
    }

    const url = new URL(req.url, `http://localhost:${PORT}`)
    const code = url.searchParams.get('code')
    const error = url.searchParams.get('error')

    if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(`<h2>❌ Authorization failed: ${error}</h2><p>You can close this tab.</p>`)
        server.close()
        process.exit(1)
    }

    if (!code) {
        res.end('No code received')
        return
    }

    try {
        const { tokens } = await oauth2Client.getToken(code)
        const tokenPath = join(process.cwd(), process.env.GOOGLE_TOKEN_PATH || 'google-token.json')
        writeFileSync(tokenPath, JSON.stringify(tokens, null, 2))

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(`
      <h2>✅ Authorization successful!</h2>
      <p>Tokens saved to <code>google-token.json</code>.</p>
      <p>You can close this tab and return to the terminal.</p>
    `)
        console.log(`\n✅ Tokens saved to ${tokenPath}`)
        console.log('Drive ingestion is now authorized. You can close this terminal when ready.')
        server.close()
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' })
        res.end(`<h2>❌ Failed to get tokens: ${err.message}</h2>`)
        console.error('Failed to exchange code:', err.message)
        server.close()
        process.exit(1)
    }
})

server.listen(PORT, () => {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('Opening browser for Google Drive authorization...')
    console.log('\nIf your browser does not open, visit this URL manually:')
    console.log('\n' + authUrl + '\n')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
    console.log('Waiting for authorization callback on port', PORT, '...')

    // Try to open in browser automatically
    const opener =
        process.platform === 'win32' ? 'start' :
            process.platform === 'darwin' ? 'open' : 'xdg-open'

    import('child_process').then(({ exec }) => exec(`${opener} "${authUrl}"`))
})
