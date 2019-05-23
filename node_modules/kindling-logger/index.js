const dateformat = require('dateformat')
const dgram = require('dgram')
const EventEmitter = require('events')
const fs = require('fs')
const path = require('path')

// .:: In the event of electron ::.

// Electron will be required when needed... however we need to set some gloabal vairables for it to get used correctly.
var ipcRenderer //= require('electron')
var remote // = reuqire('electron')

/**
 * The preferred set of levels
 * @enum {number}
 */
var logLevels = {
  UNGODLY: -1000,
  INFO: 0,
  DEBUG: 10,
  WARN: 20,
  ERROR: 30,
  FAILURE: 50,
  GODLY: 1000,
}

class Logger extends EventEmitter {
  constructor(options = {}) {
    super()
    // A log stream is where the log info will go (ie console, text file, udp...) it should be open enough to accept pretty much anything
    this.loggers = []
    this.udpClients = {} // A place to store the udp clients
    this.logLevel = logLevels.INFO
    this.dateFormat = options.dateFormat || 'yyyy-mm-dd HH:MM:ss.l' // You can find formatting options here https://www.npmjs.com/package/dateformat
    this.isElectron = false
    this.selfLog = false
  }
  /**
   *
   * @param {Object} logStream
   * @property {Object} logStream
   * @property {string} logStream.name - The name of the log stream
   * @property {string} logStream.type  - The type of log stream [console | file]
   */
  addLogger(logStream) {
    this.loggers.push(logStream)
    // TODO: add handling for Network logging here
    switch (logStream.type) {
      case 'udp':
        this.udpClients[logStream.name] = this._createUdpClient(logStream.ipAddress, logStream.port || 2485, logStream.udpBind || false)
        break
      default:
        break
    }
    this.info(`New logger added:: Name: ${logStream.name}, Log Level: ${this._getKeyByValue(logLevels, logStream.logLevel || this.logLevel).toUpperCase()}, Type: ${logStream.type.toUpperCase()}`)
  }

  /**
   * 
   * @param {String} logMessage [var x = 1]
   * @param {logLevels} logLevel [logLevels.DEBUG] 
  
   */
  log(logMessage, logLevel = 0) {
    /**
     * {name: 'File Logger',
     * type: ['file' | 'console' | 'udp'],
     * filePath: 'path/to/file, * 'file' only
     * fileName: 'log.txt', * 'file' only
     * rotating: true, * 'file' only
     * rotateFreq: ['hourly' | 'daily' | 'monthly'] * 'file' only
     * ipAddress: ['192.168.0.136', '192.168.0.42'] * udp only. Should be an array.
     * port: 1234 * 'udp' only
     * }
     */

    // loop through all of the log streams
    for (let i = 0; i < this.loggers.length; i++) {
      const activeLogger = this.loggers[i]
      const shouldLog = logLevel >= activeLogger.logLevel && logLevel >= this.logLevel

      // For logging the logger... weird, right?
      this._log('Active logger:', activeLogger)
      this._log('Log Level:', this.logLevel)
      this._log('Local Log Level:', logLevel)
      this._log('Should log:', shouldLog)

      if (shouldLog) {
        // Build out the data to log
        const now = new Date()
        const date = dateformat(now, this.dateFormat)
        const logData = `${date} ${this._getKeyByValue(logLevels, Number(logLevel)).toLocaleUpperCase()}:: ${logMessage}`

        // Logger specifics

        // Loop through all of the loggers
        switch (activeLogger.type) {
          case 'console':
            console.log(logData)
            break
          case 'electron console':
            // We're savvy enough to know we're using Electron, so lets just enable it
            if (!this.isElectron) {
              this.useElectron()
            }
            ipcRenderer.send(activeLogger.channel || 'log', logData)
            break

          case 'file':
            // File specifics
            const fullFilePath = path.join(activeLogger.filePath, activeLogger.fileName)
            const dataWithNewLines = logData + '\r'

            // NOW we can do all of the logging
            fs.appendFileSync(fullFilePath, dataWithNewLines)
            break

          case 'udp':
            // console.log('UDP Bitches!')

            const bufferedMessage = Buffer.from(logData)
            this.udpClients[activeLogger.name].send(bufferedMessage, activeLogger.port, activeLogger.ipaddress)
            // this.udpClients[activeLogger.name].close()
            break

          case 'custom':
            activeLogger.customFunction(logData)
            break
          default:
            console.log(Date.now(), 'Unknown type of logger', activeLogger.logLevel)
        }
      }
    }
  }

  /**
   * @description
   * @param {*} data
   * @memberof Logger
   */
  info(data) {
    this.log(data, logLevels.INFO)
  }

  debug(data) {
    this.log(data, logLevels.DEBUG)
  }

  /**
   * Just a warning. This may cause issue in the futre
   * @param {String} logMessage
   */
  warn(logMessage) {
    this.log(logMessage, logLevels.WARN)
  }

  /**
   * Log your error messages here
   * @param {String} logMessage
   */
  error(logMessage) {
    this.log(logMessage, logLevels.ERROR)
  }

  /**
   * This log will pretty much always show... Think of it as the voiceover of your program
   * @param {String} logMessage
   */
  godly(logMessage) {
    this.log(logMessage, logLevels.GODLY)
  }

  // TODO: Exclude anything other than whats in the loglevel
  setLogLevel(logLevel) {
    this.warn(`Log level changed to ${this._getKeyByValue(logLevels, logLevel).toUpperCase()}`)
    this.logLevel = logLevel
  }

  /**
   * This enables ussage in an electron app.
   */
  useElectron() {
    this.isElectron = true
    ipcRenderer = require('electron').ipcRenderer
    remote = require('electron').remote
  }

  _getKeyByValue(object, value) {
    return Object.keys(object).find((key) => object[key] === value)
  }

  /**
   *
   * @param {string} data
   */
  _log(data) {
    if (this.selfLog) {
      console.log(data)
    }
  }

  _createUdpClient(ipaddress, port = 2485, bind = false) {
    const client = dgram.createSocket('udp4')
    client.unref()

    if (bind) {
      client.bind(port)
    }

    return client
  }
}

module.exports = {
  Logger,
  logLevels,
}

// .:: Local moduling... ::.
if (typeof require != 'undefined' && require.main == module) {
  const bat = new Logger()

  bat.addLogger({
    name: 'base',
    type: 'console',
    logLevel: logLevels.INFO,
  })

  bat.addLogger({
    name: 'udp logger',
    type: 'udp',
    ipAddress: '127.0.0.1',
    port: 2485,
    logLevel: logLevels.UNGODLY,
  })

  // bat.log(String(bat.udpClients))
  // console.log(bat.udpClients)
  bat.info('holler at me bith')

  bat.addLogger({
    name: 'udp logger 2',
    type: 'udp',
    ipAddress: '127.0.0.1',
    port: 2485,
    logLevel: logLevels.UNGODLY,
  })

  bat.info('Testing')
}
