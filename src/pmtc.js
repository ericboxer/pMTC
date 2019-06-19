/**
 * @file pmtc.js
 *
 * @summary A reader for full frame only MTC
 * @author Eric Boxer <eric@ericboxer.net>
 *
 * Created at     : 2019-05-22 07:43:32
 * Last modified  : 2019-06-18 22:10:11
 */

'use strict'

const dgram = require('dgram')
const boxtools = require('boxtoolsjs')
const EventEmitter = require('events')

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
 * Enum for framerate values.
 * @readonly
 * @enum {number}
 */
const frameratesEnum = {
  fr24: 0,
  fr25: 1,
  fr29: 2,
  fr30: 3,
}

const transportState = {
  stopped: 'STOPPED',
  running: 'RUNNING',
  freewheel: 'FREEWHEELING',
}

class PMTC extends EventEmitter {
  constructor(options) {
    super()

    // User configurable settings
    this.address = options.interfaceAddress || ''
    this.port = options.port || 5005
    this._mtcOnly = options.mtcOnly || false
    this._useHearbeat = options.useHeartbeat || false
    this._useFreewheel = options.useFreewheel || false
    this._useSequenceNumber = options.useSequenceNumber || false
    this._freewheelTolerance = options.freewheelTolerance || 5
    this._freewheelFrames = options.freewheelFrames || 30 // Number of frames to freewheel before stopping
    this._heartbeatIntervalMillis = options.heartbeatIntervalMillis || 1000

    // Flags
    this._currentlyFreewheeling = false
    this._hasSetFreewheel = false
    this._isHeartbeat = false

    // Things that will change dynamically
    this._currentFramerate = 30
    this._freewheelTimeoutTime = 33 // number of milliseconds of without a new frame to realize TC has stopped
    this._transportState = transportState.stopped
    this._lastTime = Buffer.from(mtcPacket)
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

  set currentFramerate(framerate) {
    if (typeof framerate == 'number') {
      this._currentFramerate = framerate
    } else {
      console.log('framerate is not a number')
    }
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
      if (msg.length == 10 && msg.slice[(0, 3)] == mtcPacket.slice[(0, 3)] && this.freewheel == true) {
        clearInterval(this._freewheelInterval)
        this.freewheel = false
      }
      this._isHeartbeat = false
      this.parseMessage(buf)
    })

    this.conn.on('listening', () => {
      console.log(`Listening on port ${this.port}`)
    })

    this.conn.on('error', (err) => {
      console.log(err)
    })

    this._startHeartbeat()
  }

  _startHeartbeat() {
    if (this._useHearbeat) {
      this._heartbeatInterval = setInterval(() => {
        if ((this.transportState = transportState.stopped)) {
          this._isHeartbeat = true
          this.parseMessage(this._lastTime)
        }
      }, this._heartbeatIntervalMillis)
    }
  }

  stop() {
    this.conn.close()
  }

  setInterface(ipAddress) {
    this.ipAddress = ipAddress
  }

  setPort(portNumber) {
    this.port = portNumber
  }

  getIpAddress() {
    return this.ipAddress
  }

  getPort() {
    return this.port
  }

  parseMessage(msg) {
    // Chances are good that this is pMTC message. Like seriously. It's pretty darn accurate.
    if (msg.length == 10 && msg.slice[(0, 3)] == mtcPacket.slice[(0, 3)]) {
      this._lastTime = msg

      try {
        if (this.freewheel == false && this._isHeartbeat == false) {
          this._transportState = transportState.running
          clearInterval(this._heartbeatInterval)
        }

        // lets grab the frame rate, hour, minute, seconds, and frames from the packet
        const hours = this._pmtcHourFromHours(msg[5])
        const fr = this._pmtcFrameRateFromHours(msg[5])
        const minutes = msg[6]
        const seconds = msg[7]
        const frames = msg[8]
        const framerateTC = boxtools.nameFromEnumValue(frameratesEnum, fr)
        const frDivider = this._pmtcDetermineFrameDivider(framerateTC) // When calculating timecode, what framerate do we need to divide by?

        if (this._mtcOnly) {
          // If all we want to do is send out the information on a multicast or boradcast address... this is where we do it.
          // this.emit('timecode', msg)
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
            TRANSPORT: this._transportState,
            FRAMERATE: framerateTC,
            JSON: jsonTC,
            FRAME: totalFrames,
            MTC: [...msg],
            SEQUENCE: Date.now(),
          })
        }
        // Send it off to the masses!
        this.emit('timecode', this._tcObject)

        // We should check to see if we've set our freewheeling...
        if (this._useFreewheel == true) {
          if (this.hasSetFreewheel == false && this.freewheel == false && this._isHeartbeat == false) {
            this.freewheelTimeoutTime = 1000 / this.currentFramerate + this._freewheelTolerance // sets our freewheel timeout
            this._startFreewheelcheck(this.freewheelTimeoutTime)
            this.hasSetFreewheel = true
          } else if (this.hasSetFreewheel == true && this.freewheel == false) {
            this._freewheelTimeout.refresh()
          }
        }
      } catch (e) {
        console.log(e)
      }
    } else {
      // Not really doing anything to handle other packet types... because there are none? Maybe hande the quarter frames at some point.
    }
  }

  /**
   * @description
   * @param {int} hours
   * @returns int
   * @memberof PMTC
   */
  _pmtcFrameRateFromHours(hours) {
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
  _pmtcHourFromHours(hours) {
    return hours - (hours & 0b01100000)
  }

  /**
   * @description
   * @param {framerate} framerateTC
   * @returns int
   * @memberof PMTC
   */
  // TODO: Return an error in default case
  _pmtcDetermineFrameDivider(framerateTC) {
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

  /**
   * @description Returns the frame number based on the current time and framerate.
   * @param {number} hours
   * @param {number} minutes
   * @param {number} seconds
   * @param {number} frames
   * @param {frameratesEnum} framerate
   * @returns number
   * @memberof PMTC
   */
  _pmtcCalculateFrames(hours, minutes, seconds, frames, framerate) {
    const secondTC = seconds * framerate
    const minutesTC = minutes * 60 * framerate
    const hoursTC = hours * 60 * 60 * framerate
    return hoursTC + minutesTC + secondTC + frames
  }

  _startFreewheelcheck(timeoutTime) {
    this._freewheelTimeout = setTimeout(() => {
      this._startFreewheel()
    }, timeoutTime)
  }

  _startFreewheel() {
    this.freewheel = true
    this._transportState = transportState.freewheel
    let framesRemaining = this.freewheelFrames
    this._freewheelInterval = setInterval(() => {
      this._updateTime()
      framesRemaining -= 1
      if (framesRemaining == 0) {
        this.transportState = transportState.stopped
        this._updateTime()
        this._resetFreewheel()
      }
    }, 1000 / this.currentFramerate)
  }

  _resetFreewheel() {
    this.freewheel = false
    clearInterval(this._freewheelInterval)
    clearTimeout(this._freewheelTimeout)
    this.hasSetFreewheel = false
    this._transportState = transportState.stopped
    this._startHeartbeat()
  }

  _updateTime() {
    this._lastTime[8] += 1

    // Frames
    if (this._lastTime[8] >= this.currentFramerate) {
      this._lastTime[8] = 0
      this._lastTime[7] += 1
    }

    // Seconds
    if (this._lastTime[7] >= 60) {
      this._lastTime[7] = 0
      this._lastTime[6] += 1
    }

    // Minutes
    if (this._lastTime[6] >= 60) {
      this._lastTime[6] = 0
      this._lastTime[5] += 1
    }

    // Making some assumptions here that hours probably arent going to rollover.
    this.parseMessage(this._lastTime)
  }
}

module.exports = {
  PMTC,
}

// Simple local testing

if (typeof require != 'undefined' && require.main == module) {
  let setupArgs = {
    port: 5005,
    useHeartbeat: true,
    useFreewheel: true,
    // mtcOnly: true,
    heartbeatIntervalMillis: 1000,
  }

  const a = new PMTC(setupArgs)
  a.run()

  a.on('timecode', (data) => {
    console.log(data)
  })
}
