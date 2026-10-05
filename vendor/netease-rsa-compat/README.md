# NetEase raw-RSA compatibility adapter

This package replaces only the `node-forge` dependency of the pinned
`NeteaseCloudMusicApi` dependency through the root npm override. Its actual
package identity is `@tsmusicbot/netease-rsa-compat`; it is **not** a renamed
copy of node-forge and does not claim to implement its general API.

The upstream `util/crypto.js` uses exactly:

- `pki.publicKeyFromPem(publicPem).encrypt(binaryString, 'NONE')`
- `util.bytesToHex(binaryString)`

These operations are implemented using Node.js `crypto.createPublicKey` and
`crypto.publicEncrypt` with `RSA_NO_PADDING`. Inputs are unsigned big-endian
binary strings, left-zero-padded to the RSA modulus width, preserving the
upstream NetEase wire format. Other schemes and non-RSA/private keys are
rejected. Certificate handling, signing and signature verification are not
implemented; the vulnerable forge signature-verification implementation is
absent, rather than suppressed or relabelled.

This raw RSA format is required by the existing upstream protocol. Do not
reuse this adapter as general application encryption.

## Verification and maintenance

`src/music/netease-rsa-compat.test.ts` verifies known outputs generated using
unmodified node-forge 1.4.0, multiple public-key sizes and binary inputs, and
the actual upstream `weapi()` module with deterministic random inputs. Only
public keys and synthetic data are kept in fixtures. Unsupported APIs and
invalid inputs are tested explicitly.

The fixture generator is `scripts/generate-netease-rsa-fixtures.cjs`; it needs
an independently installed upstream forge directory as its first argument.
It refuses to use this adapter as its own reference. Review upstream call sites
and rerun the compatibility suite whenever upgrading NeteaseCloudMusicApi.

Upstream advisory: https://github.com/advisories/GHSA-86w9-cpqp-85rv
Node API: https://nodejs.org/api/crypto.html#cryptopublicencryptkey-buffer
