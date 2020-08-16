/**
 * @file pmtc.js
 *
 * @summary A reader for full frame only MTC
 * @author Eric Boxer <eric@ericboxer.net>
 *
 * Created at     : 2019-05-22 07:43:32
 * Last modified  : 2019-06-18 22:10:11
 */
'use strict';
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dgram_1 = __importDefault(require("dgram"));
const boxtoolsjs_1 = __importDefault(require("boxtoolsjs"));
const events_1 = __importDefault(require("events"));
// F0 7F 7F 01 01 hh mm ss ff F7
const mtcPacket = [
    0xf0,
    0x7f,
    0x7f,
    0x01,
    0x01,
    0x00,
    0x00,
    0x00,
    0x00,
    0xf7,
];
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
};
const transportState = {
    STOPPED: 'STOPPED',
    RUNNING: 'RUNNING',
    FREEWHEEL: 'FREEWHEELING',
};
const messageOrigin = {
    NONE: 0,
    HEARTBEAT: 1,
    FREEWHEEL: 2,
    UDP: 3,
};
class PMTC extends events_1.default {
    constructor(options) {
        super();
        // User configurable settings
        this.address = options.interfaceAddress || '';
        this.port = options.port || 5005;
        this._mtcOnly = options.mtcOnly || false;
        this._useHeartbeat = options.useHeartbeat || false;
        this._useFreewheel = options.useFreewheel || false;
        this._useSequenceNumber = options.useSequenceNumber || false;
        this._freewheelTolerance = options.freewheelTolerance || 5;
        this._freewheelFrames = options.freewheelFrames || 30; // Number of frames to freewheel before stopping
        this._heartbeatIntervalMillis = options.heartbeatIntervalMillis || 1000;
        this._readerAutoFramerate = options.readerAutoFramerate || false;
        // Flags
        this._messageOrigin = messageOrigin.NONE;
        this._currentlyFreewheeling = false;
        this._hasSetFreewheel = false;
        this._isHeartbeat = false;
        // Things that will change dynamically
        this._currentFramerate = options.currentFramerate || 30;
        this._freewheelTimeoutTime = 33; // number of milliseconds of without a new frame to realize TC has stopped
        this._transportState = transportState.STOPPED;
        this._lastTime = Buffer.from(mtcPacket);
        this._currentTime = Buffer.from(mtcPacket);
        this._tcObject;
        // Timers
        this._freewheelTimeout;
        this._freewheelInterval;
        this._heartbeatInterval;
        // Things that wont change
        this.conn = dgram_1.default.createSocket('udp4');
    }
    get currentFramerate() {
        return this._currentFramerate;
    }
    get useHeartbeat() {
        return this._useHeartbeat;
    }
    set useHeartbeat(shouldUseHeartbeat) {
        if (typeof shouldUseHeartbeat == 'boolean') {
            this._stopHeartbeat();
            this._useHeartbeat = shouldUseHeartbeat;
            if (shouldUseHeartbeat == true) {
                this._startHeartbeat();
            }
        }
    }
    setCurrentFramerate(framerate) {
        if (typeof framerate == 'number') {
            this._currentFramerate = framerate;
            //TODO: emit framerate change
        }
        else {
            // console.log('framerate is not a number')
            //TODO: Emit an error here...
        }
    }
    set currentFramerate(framerate) { }
    set transportState(transportState) {
        this._transportState = transportState;
    }
    get transportState() {
        return this._transportState;
    }
    set messageOrigin(messageOrigin) {
        this._messageOrigin = messageOrigin;
        if (messageOrigin == messageOrigin.FREEWHEEL) {
            this.transportState = transportState.FREEWHEEL;
        }
        if (messageOrigin == messageOrigin.UDP) {
            this.transportState = transportState.RUNNING;
        }
        if (messageOrigin == messageOrigin.HEARTBEAT) {
            this.transportState = transportState.STOPPED;
        }
    }
    get messageOrigin() {
        return this._messageOrigin;
    }
    // get and set freewheel status
    get hasSetFreewheel() {
        return this._hasSetFreewheel;
    }
    set hasSetFreewheel(bool) {
        this._hasSetFreewheel = bool;
    }
    get freewheel() {
        return this._currentlyFreewheeling;
    }
    set freewheel(bool) {
        this._currentlyFreewheeling = bool;
    }
    get freewheelFrames() {
        return this._freewheelFrames;
    }
    set freewheelFrames(seconds) {
        if (typeof seconds == 'number') {
            this._freewheelFrames = seconds;
        }
        else {
            console.log('freewheelSeconds parameter is not a number');
        }
    }
    get freewheelTimeoutTime() {
        return this._freewheelTimeoutTime;
    }
    set freewheelTimeoutTime(milliseconds) {
        if (typeof milliseconds == 'number') {
            this._freewheelTimeoutTime = milliseconds;
        }
        else {
            console.log('freewheelTimeour parameter is not a number');
        }
    }
    run() {
        // Setup for freewheeling!
        this.conn.bind(this.port, this.address);
        this.conn.on('message', (msg, rinfo) => {
            const buf = Buffer.from(msg);
            // Chances of it being a timecode message here? Likely.
            if (rinfo.size == 10 && msg.slice[(0, 3)] == mtcPacket.slice[(0, 3)] && this.freewheel == true) {
                clearInterval(this._freewheelInterval);
                this._resetFreewheel();
                // this.transportState = transportState.RUNNING
            }
            this.messageOrigin = messageOrigin.UDP;
            // this._isHeartbeat = false
            this.parseMessage(buf);
        });
        this.conn.on('listening', () => {
            this.emit('info', `Timecode listening on port ${this.port}`);
            // console.log(`Listening on port ${this.port}`)
        });
        this.conn.on('error', (err) => {
            console.log(err);
        });
        this._startHeartbeat();
    }
    _checkTransport() {
        return Buffer.compare(this._currentTime, this._lastTime) == 0;
    }
    _startHeartbeat() {
        this._heartbeatInterval = setInterval(() => {
            if (this._useHeartbeat) {
                if (this._checkTransport() == true && this._currentlyFreewheeling == false) {
                    this.messageOrigin = messageOrigin.HEARTBEAT;
                    this.parseMessage(this._currentTime);
                }
                else {
                    this._updateCurrentAndLastTime(this._currentTime);
                }
            }
        }, this._heartbeatIntervalMillis);
    }
    _stopHeartbeat() {
        clearInterval(this._useHeartbeatInterval);
    }
    stop() {
        this.conn.close();
    }
    setInterface(ipAddress) {
        this.ipAddress = ipAddress;
    }
    setPort(portNumber) {
        this.port = portNumber;
    }
    getIpAddress() {
        return this.ipAddress;
    }
    getPort() {
        return this.port;
    }
    parseMessage(msg) {
        if (msg.length == 10 && msg.slice[(0, 3)] == mtcPacket.slice[(0, 3)]) {
            this._updateCurrentAndLastTime(msg);
            try {
                if (this.messageOrigin == messageOrigin.UDP) {
                    this.transportState = transportState.RUNNING;
                }
                else if (this.messageOrigin == messageOrigin.HEARTBEAT) {
                    this.transportState = transportState.STOPPED;
                }
                else if (this.messageOrigin == messageOrigin.FREEWHEEL) {
                    this.transportState = transportState.FREEWHEEL;
                }
                // lets grab the frame rate, hour, minute, seconds, and frames from the packet
                const hours = this._pmtcHourFromHours(msg[5]);
                const fr = this._pmtcFrameRateFromHours(msg[5]);
                const minutes = msg[6];
                const seconds = msg[7];
                const frames = msg[8];
                let framerateTC;
                let frDivider;
                if (this._readerAutoFramerate === true) {
                    // console.log('AUTO!')
                    framerateTC = boxtoolsjs_1.default.nameFromEnumValue(frameratesEnum, fr);
                    frDivider = this._pmtcDetermineFrameDivider(framerateTC); // When calculating timecode, what framerate do we need to divide by?
                }
                else {
                    // console.log('NOT AUTO')
                    framerateTC = `fr${this._currentFramerate}`;
                    frDivider = this._currentFramerate;
                }
                if (this._mtcOnly) {
                    // If all we want to do is send out the information on a multicast or boradcast address... this is where we do it.
                    this._tcObject = msg;
                }
                else {
                    // In JSON
                    const jsonTC = JSON.stringify({
                        hours: hours,
                        minutes: minutes,
                        seconds: seconds,
                        frames: frames,
                    });
                    // In total Frames
                    const totalFrames = this._pmtcCalculateFrames(hours, minutes, seconds, frames, frDivider);
                    // Build the return object
                    this._tcObject = JSON.stringify({
                        TRANSPORT: this.transportState,
                        FRAMERATE: framerateTC,
                        JSON: jsonTC,
                        FRAME: totalFrames,
                        MTC: [...msg],
                        SEQUENCE: Date.now(),
                    });
                }
                // Send it off to the masses!
                this.emit('timecode', this._tcObject);
                // Freewheel 'em if you got 'em
                this._freewheel();
            }
            catch (e) {
                console.log(e);
            }
        }
        else {
            // Not really doing anything to handle other packet types... because there are none? Maybe hande the quarter frames at some point.
        }
    }
    _updateCurrentAndLastTime(currentTimeBuffer) {
        this._lastTime = this._currentTime;
        this._currentTime = currentTimeBuffer;
    }
    _freewheel() {
        if (this._useFreewheel == true) {
            if (this.hasSetFreewheel == false && this.messageOrigin == messageOrigin.UDP) {
                this.freewheelTimeoutTime = 1000 / this.currentFramerate + this._freewheelTolerance; // sets our freewheel timeout
                this._startFreewheelcheck(this.freewheelTimeoutTime);
                this.hasSetFreewheel = true;
            }
            else if (this.hasSetFreewheel == true && this.freewheel == false) {
                this._freewheelTimeout.refresh();
            }
        }
    }
    /**
     * @description
     * @param {int} hours
     * @returns int
     * @memberof PMTC
     */
    _pmtcFrameRateFromHours(hours) {
        let x = 0b01100000;
        let y = hours & 0b01100000;
        return (hours & 0b01100000) >> 5;
    }
    /**
     * @description
     * @param {int} hours
     * @returns int
     * @memberof PMTC
     */
    _pmtcHourFromHours(hours) {
        return hours - (hours & 0b01100000);
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
                this.currentFramerate = 24;
                return 24;
            case 'fr25':
                this.currentFramerate = 25;
                return 25;
            case 'fr29':
                this.currentFramerate = 29;
                return 29;
            case 'fr30':
                this.currentFramerate = 30;
                return 30;
            default:
                return 0;
        }
    }
    _selectFramerateSource(framerateTC) {
        if (this._readerFramerate != null) {
            return this.readerFramerate;
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
        let is29 = false;
        if (framerate == 29) {
            framerate = 30;
            is29 = true;
        }
        const secondTC = seconds * framerate;
        const minutesTC = minutes * 60 * framerate;
        const hoursTC = hours * 60 * 60 * framerate;
        let returnFrame = hoursTC + minutesTC + secondTC + frames;
        if (is29 != true) {
            return returnFrame;
        }
        else {
            return (returnFrame * 1.001).toFixed(0);
        }
    }
    _startFreewheelcheck(timeoutTime) {
        this._freewheelTimeout = setTimeout(() => {
            this._startFreewheel();
        }, timeoutTime);
    }
    _startFreewheel() {
        this.freewheel = true;
        // this.transportState = transportState.FREEWHEEL
        this.messageOrigin = messageOrigin.FREEWHEEL;
        let framesRemaining = this.freewheelFrames;
        this._freewheelInterval = setInterval(() => {
            this._updateTimeViaFreewheel();
            framesRemaining -= 1;
            if (framesRemaining == 0) {
                // if (this._useHearbeat == false) {
                //   this.transportState = transportState.STOPPED
                // }
                this._updateTimeViaFreewheel();
                this._resetFreewheel();
            }
        }, 1000 / this.currentFramerate);
    }
    _resetFreewheel() {
        this._currentlyFreewheeling = false;
        clearInterval(this._freewheelInterval);
        clearTimeout(this._freewheelTimeout);
        this.hasSetFreewheel = false;
        // this.transportState = transportState.STOPPED
        // this._startHeartbeat()
    }
    _updateTimeViaFreewheel() {
        this._currentTime[8] += 1;
        // Frames
        if (this._currentTime[8] >= this.currentFramerate) {
            this._currentTime[8] = 0;
            this._currentTime[7] += 1;
        }
        // Seconds
        if (this._currentTime[7] >= 60) {
            this._currentTime[7] = 0;
            this._currentTime[6] += 1;
        }
        // Minutes
        if (this._currentTime[6] >= 60) {
            this._currentTime[6] = 0;
            this._currentTime[5] += 1;
        }
        // Making some assumptions here that hours probably arent going to rollover.
        this.messageOrigin = messageOrigin.FREEWHEEL;
        this.parseMessage(this._currentTime);
    }
}
module.exports = {
    PMTC,
};
// Simple local testing
if (typeof require != 'undefined' && require.main == module) {
    let setupArgs = {
        port: 5005,
        useHeartbeat: false,
        useFreewheel: false,
        interfaceAddress: '127.0.0.1',
        readerAutoFramerate: false,
        heartbeatIntervalMillis: 1000,
        currentFramerate: 29,
        mtcOnly: false,
    };
    const a = new PMTC(setupArgs);
    a.setCurrentFramerate(29);
    a.run();
    a.on('timecode', (data) => {
        console.log(data);
    });
    setTimeout(() => {
        a.useHeartbeat = true;
    }, 1000);
    setTimeout(() => {
        a.useHeartbeat = false;
        // clearInterval(a._useHe÷artbeatInterval)
    }, 3000);
}
