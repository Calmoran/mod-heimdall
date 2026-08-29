import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

function safeFilename(name) {
  return path.basename(String(name)).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180) || 'attachment'
}

export class ArchiveStore {
  constructor(root, maxBytes) {
    this.root = root
    this.maxBytes = maxBytes
  }

  async initialize() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 })
  }

  async save(ticketKey, attachment) {
    const response = await fetch(attachment.url, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok || !response.body) throw new Error(`Attachment download failed with HTTP ${response.status}`)
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length && length > this.maxBytes) throw new Error('Attachment exceeds configured size limit')
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > this.maxBytes) throw new Error('Attachment exceeds configured size limit')
    const digest = crypto.createHash('sha256').update(bytes).digest('hex')
    const ticketDir = path.join(this.root, safeFilename(ticketKey))
    await fs.mkdir(ticketDir, { recursive: true, mode: 0o700 })
    const storedName = `${digest}-${safeFilename(attachment.name)}`
    const target = path.join(ticketDir, storedName)
    await fs.writeFile(target, bytes, { mode: 0o600, flag: 'wx' }).catch(async (error) => {
      if (error.code !== 'EEXIST') throw error
    })
    return { storedName: path.join(safeFilename(ticketKey), storedName), sha256: digest, byteSize: bytes.length, contentType: attachment.contentType ?? null, originalName: safeFilename(attachment.name) }
  }

  async remove(storedName) {
    const target = path.resolve(this.root, storedName)
    if (!target.startsWith(`${path.resolve(this.root)}${path.sep}`)) throw new Error('Refusing archive path outside root')
    await fs.rm(target, { force: true })
  }
}
