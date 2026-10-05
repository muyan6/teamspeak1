'use strict';
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { resolve, dirname } = require('node:path');
const { createRequire } = require('node:module');
const { createHash, generateKeyPairSync } = require('node:crypto');
const { runInNewContext } = require('node:vm');

const upstreamPath = process.argv[2] ? resolve(process.argv[2]) : dirname(require.resolve('node-forge/package.json'));
const metadata = JSON.parse(readFileSync(resolve(upstreamPath, 'package.json'), 'utf8'));
if (metadata.name !== 'node-forge') throw new Error('Fixture reference must be unmodified upstream node-forge');
const forge = require(upstreamPath);
const cryptoPath = require.resolve('NeteaseCloudMusicApi/util/crypto.js');
const cryptoSource = readFileSync(cryptoPath, 'utf8');
const requireCrypto = createRequire(cryptoPath);
const neteasePem = cryptoSource.match(/const publicKey = `([^`]+)`/)[1];
const keys = [{ name: 'netease-1024', pem: neteasePem }];
for (const bits of [1024, 2048]) {
  // Only public test keys are retained; generated private keys are discarded.
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: bits, publicExponent: 65537 });
  keys.push({ name: `generated-${bits}`, pem: publicKey.export({ type: 'spki', format: 'pem' }).toString() });
  keys.push({ name: `pkcs1-${bits}`, pem: publicKey.export({ type: 'pkcs1', format: 'pem' }).toString() });
}
const vectors = [];
for (const { name, pem } of keys) {
  const key = forge.pki.publicKeyFromPem(pem), width = Math.ceil(key.n.bitLength() / 8);
  const inputs = [Buffer.alloc(0), Buffer.from('0123456789abcdef'), Buffer.from([0, 1, 127, 128, 255]), Buffer.alloc(width), Buffer.alloc(width - 1, 0x7f)];
  for (const input of inputs) vectors.push({ key: name, inputHex: input.toString('hex'), encryptedHex: forge.util.bytesToHex(key.encrypt(input.toString('latin1'), 'NONE')) });
}
const randomValues = [0, 0.01, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 0.17, 0.33, 0.67, 0.99];
let index = 0;
const math = Object.create(Math); math.random = () => randomValues[index++ % randomValues.length];
const target = { exports: {} };
runInNewContext(cryptoSource, { require: name => name === 'node-forge' ? forge : requireCrypto(name), module: target, exports: target.exports, Math: math, Buffer, console });
const weapi = [{ s: 'test song', type: 1, limit: 30 }, { s: '中文歌曲', nested: { ids: [1, 2, 3] } }, {}].map(input => {
  index = 0;
  return { input, output: target.exports.weapi(input) };
});
const fixture = { referencePackage: `${metadata.name}@${metadata.version}`, upstreamCryptoSha256: createHash('sha256').update(cryptoSource).digest('hex'), keys, vectors, randomValues, weapi };
const destination = resolve(__dirname, '../src/music/fixtures/netease-rsa-compat.json');
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, JSON.stringify(fixture, null, 2) + '\n', 'utf8');
console.log(`Reference=${fixture.referencePackage}; RSA vectors=${vectors.length}; weapi vectors=${weapi.length}; output=${destination}`);
