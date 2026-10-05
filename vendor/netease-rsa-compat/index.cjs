'use strict';

// NeteaseCloudMusicApi/util/crypto.js uses only these two forge APIs. Do not
// implement certificate parsing, signature verification, or fallback schemes.
const { createPublicKey, publicEncrypt, constants } = require('node:crypto');

function binaryBytes(value) {
  if (typeof value !== 'string') throw new TypeError('Expected a binary string');
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 255) throw new TypeError('Expected one byte per character');
  }
  return Buffer.from(value, 'latin1');
}

function publicKeyFromPem(pem) {
  if (typeof pem !== 'string' || !/^\s*-----BEGIN (?:RSA )?PUBLIC KEY-----/.test(pem)) {
    throw new TypeError('Expected an RSA public-key PEM');
  }
  const key = createPublicKey({ key: pem, format: 'pem' });
  if (key.asymmetricKeyType !== 'rsa') throw new TypeError('Only RSA public keys are supported');
  const bits = key.asymmetricKeyDetails?.modulusLength;
  if (!Number.isInteger(bits) || bits < 512 || bits > 16384) throw new RangeError('Unsupported RSA modulus length');
  const width = Math.ceil(bits / 8);
  return Object.freeze({
    encrypt(value, scheme) {
      if (scheme !== 'NONE') throw new TypeError('Only the Netease raw RSA NONE scheme is supported');
      const input = binaryBytes(value);
      if (input.length > width) throw new RangeError('RSA input exceeds the modulus width');
      // Forge treats raw input as a big-endian integer. OpenSSL requires a
      // full-width buffer, so zero-pad on the left, never on the right.
      const padded = Buffer.alloc(width);
      input.copy(padded, width - input.length);
      // OpenSSL also rejects representatives >= modulus; do not reduce them.
      return publicEncrypt({ key, padding: constants.RSA_NO_PADDING }, padded).toString('latin1');
    },
  });
}

module.exports = Object.freeze({
  pki: Object.freeze({ publicKeyFromPem }),
  util: Object.freeze({ bytesToHex: value => binaryBytes(value).toString('hex') }),
});
