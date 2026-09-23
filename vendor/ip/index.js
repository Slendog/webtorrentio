'use strict'

// Local stand-in for the `ip` package (installed through "overrides" in the root package.json).
//
// ip@2.0.1 has an unfixed advisory in isPublic() (GHSA-2p57-rm9w-gvfp). The only code in this
// project's dependency tree that uses `ip` is bittorrent-tracker/lib/server/parse-udp.js, and it
// only calls toString(). This file provides exactly that function, so the vulnerable code is not
// installed at all. If a dependency starts using another `ip` function, it fails at startup with
// "... is not a function" instead of silently running unreviewed code.
//
// toString() is copied from ip@2.0.1 (MIT, Copyright Fedor Indutny, 2012; see LICENSE here).
exports.toString = function toString (buff, offset, length) {
  offset = ~~offset
  length = length || (buff.length - offset)

  let result = []
  if (length === 4) {
    // IPv4
    for (let i = 0; i < length; i++) {
      result.push(buff[offset + i])
    }
    result = result.join('.')
  } else if (length === 16) {
    // IPv6
    for (let i = 0; i < length; i += 2) {
      result.push(buff.readUInt16BE(offset + i).toString(16))
    }
    result = result.join(':')
    result = result.replace(/(^|:)0(:0)*:0(:|$)/, '$1::$3')
    result = result.replace(/:{3,4}/, '::')
  }

  return result
}
