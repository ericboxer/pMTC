# pMTC
An easy to use reader for full frame (SysEx) Midi Timecode

## Why Full frame only?
* It cuts down on network traffic
* You get all the time information in one packet per frame
* The Kissbox TC2TR supports it out of the box [with minor configuration], which was the original use case.

## Installation
```bash
npm install pmtc
```

## Ussage
```javascript
const {PMTC} = require('pmtc')

const server = new PMTC('',5005) // Listen for pMTC data on all interfaces on port 5005
server.run()
server.on('timecode',(data)=>{
    console.log(data)
})
```
Want to test with a pMTC Generator? Find one on my [Github](https://github.com/ericboxer/Timecode-Generator)

## Data format
The timecode data is converted to an easy to use JSON packet with a few options.

```json
{"framerate":"fr24","json":"{\"hours\":0,\"minutes\":0,\"seconds\":23,\"frames\":16}","frame":568,"legacy":[240,127,127,1,1,0,0,23,16,247]}
```

Optionally, you can set the legacyOnly flag to receive the raw data packet (useful to multicast or broadcast)

```javascript
const server = new PMTC('',5005,true)
server.run()

// <Buffer f0 7f 7f 01 01 00 00 03 11 f7>
```

## Functions

### PMTC.run()
Starts the server listening for pMTC data.

### PMTC.stop()
stops the server.

## TODOs
* [ ] Add more to the readme
* [ ] Add qurater frame support (maybe)
* [ ] Fix setters and getters