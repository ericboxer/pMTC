'use strict'

const dgram = require('dgram')
const boxtools = require('boxtoolsjs')
const EventEmitter = require('events')

// F0 7F 7F 01 01 hh mm ss ff F7
// f0 7f 7f 01 01 61 1d 09 15 f7
// f0 7f 7f 01 01 80 00 03 15 f7

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

// function framerates() {
//   this.fr24 = 0
//   this.fr25 = 1
//   this.fr29 = 2
//   this.fr30 = 3
// }

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

class PMTC extends EventEmitter {
  constructor(interfaceAddress, port) {
    super()
    this.address = interfaceAddress || ''
    this.port = port || 5555
    this.conn = dgram.createSocket('udp4')
  }

  run() {
    this.conn.bind(this.port, this.address)

    this.conn.on('message', (msg, rinfo) => {
      const buf = Buffer.from(msg)
      console.log(buf)
      this.parseMessage(buf)
    })

    this.conn.on('listening', () => {
      console.log(`Listening on port ${this.port}`)
    })

    this.conn.on('error', (err) => {
      console.log(err)
    })
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
      try {
        // lets grab the frame rate, hour, minute, seconds, and frames from the packet
        const hours = this._pmtcHourFromHours(msg[5])
        const fr = this._pmtcFrameRateFromHours(msg[5])
        const minutes = msg[6]
        const seconds = msg[7]
        const frames = msg[8]

        // Now we have all the parts we need. Lets create a few different ways of transmitting the code.

        const framerateTC = boxtools.nameFromEnumValue(frameratesEnum, fr)
        const frDivider = this._pmtcDetermineFrameDivider(framerateTC) // When calculating timecode, what framerate do we need to divide by?

        // In JSON
        const jsonTC = JSON.stringify({
          hours: hours,
          minutes: minutes,
          seconds: seconds,
          frames: frames,
        })

        // In total Frames
        const totalFrames = this._pmtcCalculateFrames(hours, minutes, seconds, frames, frDivider)

        // Bult the return object
        const tcObject = {
          framerate: framerateTC,
          json: jsonTC,
          frame: totalFrames,
          legacy: [...msg],
        }

        // Send it off to the masses!
        this.emit('timecode', JSON.stringify(tcObject))
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
    console.log(x, y)
    console.log((hours & 0b01100000) >> 5)
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
        return 24
      case 'fr25':
        return 25
      case 'fr29':
        return 29
      case 'fr30':
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
}

module.exports = {
  PMTC,
}

// Simple local testing

if (typeof require != 'undefined' && require.main == module) {
  const a = new PMTC('', 5005)
  a.run()

  a.on('timecode', (data) => {
    console.log(data)
  })
}
