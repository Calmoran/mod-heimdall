function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function unxml(value) {
  return String(value)
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&#xD;', ' ')
    .replaceAll('&amp;', '&')
    .replace(/\s+/g, ' ')
    .trim()
}

export class SoapClient {
  constructor(config) {
    this.url = config.url
    this.auth = `Basic ${Buffer.from(`${config.user}:${config.password}`).toString('base64')}`
  }

  async command(text) {
    const body = `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="urn:AC"><SOAP-ENV:Body><ns1:executeCommand><command>${xml(text)}</command></ns1:executeCommand></SOAP-ENV:Body></SOAP-ENV:Envelope>`
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { Authorization: this.auth, 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: 'urn:AC#executeCommand' },
      body,
      signal: AbortSignal.timeout(15_000),
    })
    const payload = await response.text()
    if (!response.ok || /<faultstring>/i.test(payload)) {
      // The core puts the reason a command refused into the fault, and it is the only place that
      // reason exists - "Player not found!", or the command's own syntax line. Dropping it left
      // callers with a bare HTTP 500 and nothing to tell anyone.
      const fault = unxml(payload.match(/<faultstring>([\s\S]*?)<\/faultstring>/i)?.[1] ?? '')
      throw new Error(fault ? `SOAP command refused: ${fault}` : `SOAP command failed with HTTP ${response.status}`)
    }

    // AzerothCore only emits a SOAP fault when a command handler returns false. Several ticket
    // handlers return true after doing nothing - ".ticket complete" on an unknown id answers
    // "Ticket not found." with HTTP 200 - so a successful transport does not mean the command had
    // any effect. Callers that care must inspect the result text.
    const match = payload.match(/<result>([\s\S]*?)<\/result>/i)
    return match ? match[1].trim() : payload
  }

  // Runs a command and rejects when the core's own reply says it did nothing, so the delivery job
  // retries and stays visible instead of being marked delivered. The markers are English server
  // strings; a localised core needs its own list, which is why the raw reply is kept in the error.
  async commandExpectingEffect(text, failureMarkers = [
    /not found/i,
    /does not exist/i,
    /invalid name specified/i,   // .ticket assign, when the GM name has no gmlevel on its account
    /cannot be assigned/i,
    /already assigned/i,
  ]) {
    const result = await this.command(text)
    if (failureMarkers.some((marker) => marker.test(result))) {
      throw new Error(`Core rejected "${text}": ${result.replace(/\s+/g, ' ').slice(0, 200)}`)
    }
    return result
  }

  async commands(commands) {
    for (const command of commands) await this.command(command)
  }
}
