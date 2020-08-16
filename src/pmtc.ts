/**
 * @file pmtc.js
 *
 * @summary A reader for full frame only MTC
 * @author Eric Boxer <eric@ericboxer.net>
 *
 * Created at     : 2019-05-22 07:43:32
 * Last modified  : 2019-06-18 22:10:11
 */

import dgram, { Socket } from 'dgram'
//TODO: remove when tested
// import boxtools from 'boxtoolsjs' /* Not needed anymore... leaving here for testing*/
import { EventEmitter } from 'events'

// F0 7F 7F 01 01 hh mm ss ff F7

const mtcPacket = [
  0xf0, // Message Start
  0x7f, // Universal Message
  0x7f, // Global Broadcast
  0x01, // Timecode Message
  0x01, // The article was right. Framerate is baked into the binary data of the hours byte. You sneaky...
  0x00, // Hours
  0x00, // Minutes
  0x00, // Seconds
  0x00, // Frames
  0xf7, // EoE message
]

/**
 * @description An enum describing the different supported framerates
 * @export
 * @enum {number}
 */
export enum Framerates {
  fr24 = 0,
  fr25,
  fr29,
  fr30,
}

export import frameratesEnum = Framerates /* Type alias for older legacy support */

export enum TransportState {
  STOPPED = 'STOPPED',
  RUNNING = 'RUNNING',
  FREEWHEEL = 'FREEWHEEL',
}

export import transportState = TransportState /* Type alias for older legacy support */

enum MessageOrigin {
  NONE = 0,
  HEARTBEAT = 1,
  FREEWHEEL = 2,
  UDP = 3,
}

import messageOrigin = MessageOrigin /* Type alias for older legacy support */
import { type } from 'os'

export interface PMTCOptions {
  interfaceAddress: string
  port: number
  mtcOnly: boolean
  useHeartbeat: boolean
  useFreewheel: boolean
  useSequenceNumber?: boolean
  freewheelTolerance?: number
  freewheelFrames?: number
  heartbeatIntervalMillis: number
  readerAutoFramerate: boolean
  currentFramerate: number
}

export class PMTC extends EventEmitter {
  address: string
  port: number
  conn: Socket
  private _mtcOnly: boolean
  private _useHeartbeat: boolean
  private _useFreewheel: boolean
  private _useSequenceNumber: boolean
  private _freewheelTolerance: number
  private _freewheelFrames: number
  private _heartbeatIntervalMillis: number
  private _readerAutoFramerate: boolean

  private _messageOrigin: MessageOrigin
  private _currentlyFreewheeling: boolean
  private _hasSetFreewheel: boolean
  private _isHeartbeat: boolean

  private _currentFramerate: number
  private _freewheelTimeoutTime: number
  private _transportState: TransportState
  private _lastTime: Buffer
  private _currentTime: Buffer

  //TODO: Make an interface for this
  private _tcObject: any

  private _freewheelTimeout!: NodeJS.Timeout
  private _freewheelInterval!: NodeJS.Timeout
  private _heartbeatInterval!: NodeJS.Timeout

  constructor(options: PMTCOptions) {
    super()
    this.address = options.interfaceAddress || ''
    this.port = options.port || 5005
    this._mtcOnly = options.mtcOnly || false
    this._useHeartbeat = options.useHeartbeat || false
    this._useFreewheel = options.useFreewheel || false
    this._useSequenceNumber = options.useSequenceNumber || false
    this._freewheelTolerance = options.freewheelTolerance || 5
    this._freewheelFrames = options.freewheelFrames || 30 // Number of frames to freewheel before stopping
    this._heartbeatIntervalMillis = options.heartbeatIntervalMillis || 1000
    this._readerAutoFramerate = options.readerAutoFramerate || false

    // Flags
    this._messageOrigin = MessageOrigin.NONE
    this._currentlyFreewheeling = false
    this._hasSetFreewheel = false
    this._isHeartbeat = false

    // Things that will change dynamically
    this._currentFramerate = options.currentFramerate || 30
    this._freewheelTimeoutTime = 33 // number of milliseconds of without a new frame to realize TC has stopped
    this._transportState = TransportState.STOPPED
    this._lastTime = Buffer.from(mtcPacket)
    this._currentTime = Buffer.from(mtcPacket)
    this._tcObject

    // Timers
    this._freewheelTimeout
    this._freewheelInterval
    this._heartbeatInterval

    // Things that wont change
    this.conn = dgram.createSocket('udp4')
  }

  get currentFramerate() {
    return this._currentFramerate
  }

  get useHeartbeat() {
    return this._useHeartbeat
  }

  set useHeartbeat(shouldUseHeartbeat) {
    if (typeof shouldUseHeartbeat == 'boolean') {
      this._stopHeartbeat()
      this._useHeartbeat = shouldUseHeartbeat
      if (shouldUseHeartbeat == true) {
        this._startHeartbeat()
      }
    }
  }

  setCurrentFramerate(framerate: number) {
    if (typeof framerate == 'number') {
      this._currentFramerate = framerate
      //TODO: emit framerate change
    } else {
      // console.log('framerate is not a number')
      //TODO: Emit an error here...
    }
  }

  set currentFramerate(framerate) {}

  set transportState(transportState: TransportState) {
    this._transportState = transportState
  }
  get transportState() {
    return this._transportState
  }

  set messageOrigin(messageOrigin: MessageOrigin) {
    this._messageOrigin = messageOrigin
    if (messageOrigin == MessageOrigin.FREEWHEEL) {
      this.transportState = transportState.FREEWHEEL
    }
    if (messageOrigin == MessageOrigin.UDP) {
      this.transportState = transportState.RUNNING
    }
    if (messageOrigin == MessageOrigin.HEARTBEAT) {
      this.transportState = transportState.STOPPED
    }
  }

  get messageOrigin() {
    return this._messageOrigin
  }

  // get and set freewheel status

  get hasSetFreewheel() {
    return this._hasSetFreewheel
  }

  set hasSetFreewheel(bool) {
    this._hasSetFreewheel = bool
  }

  get freewheel() {
    return this._currentlyFreewheeling
  }
  set freewheel(bool) {
    this._currentlyFreewheeling = bool
  }

  get freewheelFrames() {
    return this._freewheelFrames
  }

  set freewheelFrames(seconds) {
    if (typeof seconds == 'number') {
      this._freewheelFrames = seconds
    } else {
      console.log('freewheelSeconds parameter is not a number')
    }
  }

  get freewheelTimeoutTime() {
    return this._freewheelTimeoutTime
  }

  set freewheelTimeoutTime(milliseconds) {
    if (typeof milliseconds == 'number') {
      this._freewheelTimeoutTime = milliseconds
    } else {
      console.log('freewheelTimeour parameter is not a number')
    }
  }

  run() {
    // Setup for freewheeling!

    this.conn.bind(this.port, this.address)
    this.conn.on('message', (msg, rinfo) => {
      const buf = Buffer.from(msg)

      // Chances of it being a timecode message here? Likely.
      if (rinfo.size == 10 && _compareArray([...msg.slice(0, 3)], [...mtcPacket.slice(0, 3)]) && this.freewheel == true) {
        clearInterval(this._freewheelInterval)
        this._resetFreewheel()
        // this.transportState = transportState.RUNNING
      }
      this.messageOrigin = messageOrigin.UDP
      // this._isHeartbeat = false
      this.parseMessage(buf)
    })

    this.conn.on('listening', () => {
      this.emit('info', `Timecode listening on port ${this.port}`)
      // console.log(`Listening on port ${this.port}`)
    })

    this.conn.on('error', (err) => {
      console.log(err)
    })

    this._startHeartbeat()
  }

  _checkTransport() {
    return Buffer.compare(this._currentTime, this._lastTime) == 0
  }

  _startHeartbeat() {
    this._heartbeatInterval = setInterval(() => {
      if (this._useHeartbeat) {
        if (this._checkTransport() == true && this._currentlyFreewheeling == false) {
          this.messageOrigin = messageOrigin.HEARTBEAT
          this.parseMessage(this._currentTime)
        } else {
          this._updateCurrentAndLastTime(this._currentTime)
        }
      }
    }, this._heartbeatIntervalMillis)
  }

  _stopHeartbeat() {
    clearInterval(this._heartbeatInterval)
  }

  stop() {
    this.conn.close()
  }

  setInterface(ipAddress: string) {
    this.address = ipAddress
    // this.ipAddress = ipAddress
  }

  setPort(portNumber: number) {
    this.port = portNumber
  }

  getIpAddress() {
    return this.address
    // return this.ipAddress
  }

  getPort() {
    return this.port
  }

  parseMessage(msg: Buffer) {
    if (msg.length == 10 && _compareArray([...msg.slice(0, 3)], [...mtcPacket.slice(0, 3)])) {
      this._updateCurrentAndLastTime(msg)

      try {
        if (this.messageOrigin == MessageOrigin.UDP) {
          this.transportState = TransportState.RUNNING
        } else if (this.messageOrigin == MessageOrigin.HEARTBEAT) {
          this.transportState = TransportState.STOPPED
        } else if (this.messageOrigin == MessageOrigin.FREEWHEEL) {
          this.transportState = TransportState.FREEWHEEL
        }

        // lets grab the frame rate, hour, minute, seconds, and frames from the packet
        const hours = this._pmtcHourFromHours(msg[5])
        const fr = this._pmtcFrameRateFromHours(msg[5])
        const minutes = msg[6]
        const seconds = msg[7]
        const frames = msg[8]

        let framerateTC
        let frDivider

        if (this._readerAutoFramerate === true) {
          // console.log('AUTO!')
          framerateTC = Framerates[fr]
          // framerateTC = boxtools.nameFromEnumValue(frameratesEnum, fr) /* Leaving this here to make sure it all still works */
          frDivider = this._pmtcDetermineFrameDivider(framerateTC) // When calculating timecode, what framerate do we need to divide by?
        } else {
          framerateTC = `fr${this._currentFramerate}`
          frDivider = this._currentFramerate
        }

        if (this._mtcOnly) {
          // If all we want to do is send out the information on a multicast or boradcast address... this is where we do it.
          this._tcObject = msg
        } else {
          // In JSON
          const jsonTC = JSON.stringify({
            hours: hours,
            minutes: minutes,
            seconds: seconds,
            frames: frames,
          })

          // In total Frames
          const totalFrames = this._pmtcCalculateFrames(hours, minutes, seconds, frames, frDivider)

          // Build the return object
          this._tcObject = JSON.stringify({
            TRANSPORT: this.transportState,
            FRAMERATE: framerateTC,
            JSON: jsonTC,
            FRAME: totalFrames,
            MTC: [...msg],
            SEQUENCE: Date.now(),
          })
        }
        // Send it off to the masses!
        this.emit('timecode', this._tcObject)

        // Freewheel 'em if you got 'em
        this._freewheel()
      } catch (e) {
        console.log(e)
      }
    } else {
      // Not really doing anything to handle other packet types... because there are none? Maybe hande the quarter frames at some point.
    }
  }

  private _updateCurrentAndLastTime(currentTimeBuffer: Buffer) {
    this._lastTime = this._currentTime
    this._currentTime = currentTimeBuffer
  }

  private _freewheel() {
    if (this._useFreewheel == true) {
      if (this.hasSetFreewheel == false && this.messageOrigin == messageOrigin.UDP) {
        this.freewheelTimeoutTime = 1000 / this.currentFramerate + this._freewheelTolerance // sets our freewheel timeout
        this._startFreewheelcheck(this.freewheelTimeoutTime)
        this.hasSetFreewheel = true
      } else if (this.hasSetFreewheel == true && this.freewheel == false) {
        this._freewheelTimeout.refresh()
      }
    }
  }

  /**
   * @description
   * @param {int} hours
   * @returns int
   * @memberof PMTC
   */
  private _pmtcFrameRateFromHours(hours: number) {
    let x = 0b01100000
    let y = hours & 0b01100000
    return (hours & 0b01100000) >> 5
  }

  /**
   * @description
   * @param {int} hours
   * @returns int
   * @memberof PMTC
   */
  private _pmtcHourFromHours(hours: number) {
    return hours - (hours & 0b01100000)
  }

  /**
   * @description
   * @param {framerate} framerateTC
   * @returns int
   * @memberof PMTC
   */
  // TODO: Return an error in default case
  private _pmtcDetermineFrameDivider(framerateTC: string) {
    switch (framerateTC) {
      case 'fr24':
        this.currentFramerate = 24
        return 24
      case 'fr25':
        this.currentFramerate = 25
        return 25
      case 'fr29':
        this.currentFramerate = 29
        return 29
      case 'fr30':
        this.currentFramerate = 30
        return 30
      default:
        return 0
    }
  }

  private _pmtcCalculateFrames(hours: number, minutes: number, seconds: number, frames: number, framerate: Framerates) {
    let is29 = false
    if (framerate == 29) {
      framerate = 30
      is29 = true
    }
    const secondTC = seconds * framerate
    const minutesTC = minutes * 60 * framerate
    const hoursTC = hours * 60 * 60 * framerate

    let returnFrame = hoursTC + minutesTC + secondTC + frames

    if (is29 != true) {
      return returnFrame
    } else {
      return (returnFrame * 1.001).toFixed(0)
    }
  }

  private _startFreewheelcheck(timeoutTime: number) {
    this._freewheelTimeout = setTimeout(() => {
      this._startFreewheel()
    }, timeoutTime)
  }

  private _startFreewheel() {
    this.freewheel = true
    this.messageOrigin = messageOrigin.FREEWHEEL
    let framesRemaining = this.freewheelFrames
    this._freewheelInterval = setInterval(() => {
      this._updateTimeViaFreewheel()
      framesRemaining -= 1
      if (framesRemaining == 0) {
        this._updateTimeViaFreewheel()
        this._resetFreewheel()
      }
    }, 1000 / this.currentFramerate)
  }

  private _resetFreewheel() {
    this._currentlyFreewheeling = false
    clearInterval(this._freewheelInterval)
    clearTimeout(this._freewheelTimeout)
    this.hasSetFreewheel = false
  }

  _updateTimeViaFreewheel() {
    this._currentTime[8] += 1

    // Frames
    if (this._currentTime[8] >= this.currentFramerate) {
      this._currentTime[8] = 0
      this._currentTime[7] += 1
    }

    // Seconds
    if (this._currentTime[7] >= 60) {
      this._currentTime[7] = 0
      this._currentTime[6] += 1
    }

    // Minutes
    if (this._currentTime[6] >= 60) {
      this._currentTime[6] = 0
      this._currentTime[5] += 1
    }

    // Making some assumptions here that hours probably arent going to rollover.
    this.messageOrigin = messageOrigin.FREEWHEEL
    this.parseMessage(this._currentTime)
  }
}

function _compareArray<T>(array1: T[], array2: T[]): boolean {
  if (array1.length == array2.length) {
    for (const val in array1) {
      if (array1[val] != array2[val]) {
        return false
      }
    }
  }
  return true
}

module.exports = {
  PMTC,
}

// // Simple local testing
// if (typeof require != 'undefined' && require.main == module) {
//   let setupArgs: PMTCOptions = {
//     port: 5005,
//     useHeartbeat: false,
//     useFreewheel: false,
//     interfaceAddress: '127.0.0.1',
//     readerAutoFramerate: false,
//     heartbeatIntervalMillis: 1000,
//     currentFramerate: 29,
//     mtcOnly: false,
//   }

//   const a = new PMTC(setupArgs)
//   a.setCurrentFramerate(29)
//   a.run()

//   a.on('timecode', (data) => {
//     console.log(data)
//   })
//   setTimeout(() => {
//     a.useHeartbeat = true
//   }, 1000)

//   setTimeout(() => {
//     a.useHeartbeat = false
//   }, 3000)
// }
