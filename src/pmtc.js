/**
 * @file pmtc.js
 *
 * @summary A reader for full frame only MTC
 * @author Eric Boxer <eric@ericboxer.net>
 *
 * Created at     : 2019-05-22 07:43:32
 * Last modified  : 2019-06-08 11:25:12
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

class PMTC extends EventEmitter {
  constructor(interfaceAddress, port, legacyOnly = false) {
    super()
    this.address = interfaceAddress || ''
    this.port = port || 5555
    this.conn = dgram.createSocket('udp4')
    this.legacyOnly = legacyOnly
  }

  run() {
    this.conn.bind(this.port, this.address)

    this.conn.on('message', (msg, rinfo) => {
      const buf = Buffer.from(msg)
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
        // If all we want to do is send out the information on a multicast or boradcast address... this is where we do it.
        if (this.legacyOnly) {
          this.emit('timecode', msg)
        } else {
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

          // Build the return object
          const tcObject = {
            framerate: framerateTC,
            json: jsonTC,
            frame: totalFrames,
            legacy: [...msg],
          }

          // Send it off to the masses!
          this.emit('timecode', JSON.stringify(tcObject))
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

// if (typeof require != 'undefined' && require.main == module) {
//   const a = new PMTC('', 5005, true)
//   a.run()

//   a.on('timecode', (data) => {
//     console.log(data)
//   })
// }
