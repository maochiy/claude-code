export class LineDecoder {
  private readonly decoder = new TextDecoder()
  private buffered = ''

  push(chunk: Uint8Array): string[] {
    this.buffered += this.decoder.decode(chunk, { stream: true })
    return this.drain(false)
  }

  finish(): string[] {
    this.buffered += this.decoder.decode()
    return this.drain(true)
  }

  private drain(includeTail: boolean): string[] {
    const lines: string[] = []
    for (;;) {
      const newline = this.buffered.indexOf('\n')
      if (newline < 0) break
      const raw = this.buffered.slice(0, newline)
      this.buffered = this.buffered.slice(newline + 1)
      lines.push(raw.endsWith('\r') ? raw.slice(0, -1) : raw)
    }
    if (includeTail && this.buffered.length > 0) {
      lines.push(this.buffered)
      this.buffered = ''
    }
    return lines
  }
}
