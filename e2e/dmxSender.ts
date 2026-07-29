import dgram from 'node:dgram'

/**
 * A synthetic console, for the tests only.
 *
 * Crewbox itself never transmits on a lighting network — the listener's
 * sockets have `send` taken off them. This is the other end of the wire,
 * existing purely so the live-rig features can be driven end to end without
 * a rig.
 */
export class FakeConsole {
  private socket: dgram.Socket | null = null
  private timer: NodeJS.Timeout | null = null
  private syncTimer: NodeJS.Timeout | null = null
  private sequence = 0
  private syncSequence = 0
  /**
   * The universe this console asks receivers to synchronise on, or 0.
   *
   * Set on its own, a receiver holds nothing — E1.31 §6.2.4.1 needs an actual
   * synchronization stream too, which is `startSync`. Being able to do one
   * without the other is exactly what makes the frozen-rig case testable.
   */
  private syncAddress = 0

  async start(universe: number, levels: Record<number, number>): Promise<void> {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.socket = socket
    await new Promise<void>((resolve) => socket.bind(0, resolve))
    socket.setMulticastTTL(1)
    socket.setMulticastLoopback(true)
    try {
      socket.setMulticastInterface('127.0.0.1')
    } catch {
      // The default interface may still deliver on loopback.
    }
    const group = `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`
    const send = () => socket.send(this.packet(universe, levels), 5568, group, () => {})
    send()
    this.timer = setInterval(send, 40)
  }

  /** Change what it is sending, without restarting the stream. */
  set(universe: number, levels: Record<number, number>): void {
    const socket = this.socket
    if (!socket) return
    const group = `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`
    if (this.timer) clearInterval(this.timer)
    const send = () => socket.send(this.packet(universe, levels), 5568, group, () => {})
    send()
    this.timer = setInterval(send, 40)
  }

  /** Ask receivers to hold this console's data until a sync packet arrives. */
  syncOn(syncAddress: number): void {
    this.syncAddress = syncAddress
  }

  /** Start sending synchronization packets on that universe's own group. */
  startSync(): void {
    const socket = this.socket
    if (!socket || this.syncAddress === 0) return
    const group = `239.255.${(this.syncAddress >> 8) & 0xff}.${this.syncAddress & 0xff}`
    const send = () => socket.send(this.syncPacket(), 5568, group, () => {})
    send()
    this.syncTimer = setInterval(send, 40)
  }

  /** Stop them, leaving the data stream running. This is what freezes a rig. */
  stopSync(): void {
    if (this.syncTimer) clearInterval(this.syncTimer)
    this.syncTimer = null
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.stopSync()
    try {
      this.socket?.close()
    } catch {
      // Already closed.
    }
    this.socket = null
  }

  /** An E1.31 data packet. Layout mirrors server/src/dmx/sacn.ts. */
  private packet(universe: number, levels: Record<number, number>): Buffer {
    const buf = Buffer.alloc(638)
    buf.writeUInt16BE(0x0010, 0)
    Buffer.from('ASC-E1.17\0\0\0', 'latin1').copy(buf, 4)
    buf.writeUInt32BE(4, 18)
    Buffer.from('crewbox-e2e-cid1').copy(buf, 22)
    buf.writeUInt32BE(2, 40)
    Buffer.from('Test Console', 'utf8').copy(buf, 44)
    buf[108] = 100
    buf.writeUInt16BE(this.syncAddress, 109)
    buf[111] = this.sequence = (this.sequence + 1) % 256
    // Options 0: force-synchronization clear, which is both the default and
    // the case worth testing — it is the one where losing sync freezes a rig.
    buf[112] = 0
    buf.writeUInt16BE(universe, 113)
    buf[117] = 2
    buf[118] = 0xa1
    buf.writeUInt16BE(1, 121)
    buf.writeUInt16BE(513, 123)
    buf[125] = 0
    for (const [address, level] of Object.entries(levels)) buf[126 + Number(address) - 1] = level
    return buf
  }

  /** An E1.31 Synchronization Packet. No DMP layer, extended root vector. */
  private syncPacket(): Buffer {
    const buf = Buffer.alloc(49)
    buf.writeUInt16BE(0x0010, 0)
    Buffer.from('ASC-E1.17\0\0\0', 'latin1').copy(buf, 4)
    buf.writeUInt32BE(8, 18)
    Buffer.from('crewbox-e2e-cid1').copy(buf, 22)
    buf.writeUInt32BE(1, 40)
    buf[44] = this.syncSequence = (this.syncSequence + 1) % 256
    buf.writeUInt16BE(this.syncAddress, 45)
    return buf
  }
}
