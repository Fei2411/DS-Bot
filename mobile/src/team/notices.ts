// Tracks the last seen host notice sequence per boot epoch so reconnects recover
// missed cross-chat notices even from seq=0 without replaying live-delivered events.
export interface NoticeCursorAnswer {
  boot?: string
  seq?: number
  reset?: boolean
  notices?: unknown[]
}

export function createNoticeCursor() {
  let boot: string | null = null
  let seq = 0

  function connect(hello: { boot: string; seq: number }): { sameBoot: boolean; since: number } {
    const sameBoot = boot !== null && boot === hello.boot
    if (!sameBoot) {
      boot = hello.boot
      seq = typeof hello.seq === 'number' ? hello.seq : 0
      return { sameBoot: false, since: seq }
    }
    return { sameBoot: true, since: seq }
  }

  function acceptLive(helloBoot: string, data: unknown): boolean {
    const nSeq = (data as { seq?: unknown } | null | undefined)?.seq
    if (typeof nSeq !== 'number') return true
    if (boot !== helloBoot) {
      boot = helloBoot
      seq = nSeq
      return true
    }
    if (nSeq <= seq) return false
    seq = nSeq
    return true
  }

  function acceptCatchUp(helloBoot: string, _sameBoot: boolean, answer: NoticeCursorAnswer): { reset: boolean; replay: unknown[] } {
    const nextBoot = typeof answer.boot === 'string' ? answer.boot : helloBoot
    if (boot !== nextBoot) {
      boot = nextBoot
      seq = typeof answer.seq === 'number' ? answer.seq : 0
      return { reset: answer.reset === true, replay: [] }
    }
    const replay: unknown[] = []
    if (answer.reset !== true && Array.isArray(answer.notices)) {
      for (const entry of answer.notices) {
        const eSeq = (entry as { seq?: unknown } | null | undefined)?.seq
        if (typeof eSeq === 'number') {
          if (eSeq > seq) {
            seq = eSeq
            replay.push(entry)
          }
        } else {
          replay.push(entry)
        }
      }
    }
    if (typeof answer.seq === 'number' && answer.seq > seq) {
      seq = answer.seq
    }
    return { reset: answer.reset === true, replay }
  }

  return { connect, acceptLive, acceptCatchUp, snapshot: () => ({ boot, seq }) }
}
