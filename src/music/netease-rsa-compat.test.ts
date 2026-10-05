import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

// DEPENDENCY_TEST_ROOT also verifies a clean npm-ci checkout against the same
// public upstream fixtures without silently resolving this checkout's packages.
const dependencyRequire = createRequire(resolve(process.env.DEPENDENCY_TEST_ROOT ?? process.cwd(), 'package.json'));
const upstreamRequire = createRequire(dependencyRequire.resolve('NeteaseCloudMusicApi/package.json'));
const adapter = upstreamRequire('node-forge');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/netease-rsa-compat.json', import.meta.url), 'utf8')) as {
  referencePackage: string; upstreamCryptoSha256: string;
  keys: { name: string; pem: string }[];
  vectors: { key: string; inputHex: string; encryptedHex: string }[];
  randomValues: number[]; weapi: { input: unknown; output: { params: string; encSecKey: string } }[];
};
afterEach(() => vi.restoreAllMocks());

it('installs the explicit narrow adapter, not vulnerable forge under a changed version', () => {
  expect(upstreamRequire('node-forge/package.json').name).toBe('@tsmusicbot/netease-rsa-compat');
  expect(Object.keys(adapter).sort()).toEqual(['pki', 'util']);
  expect(Object.keys(adapter.pki)).toEqual(['publicKeyFromPem']);
  expect(Object.keys(adapter.util)).toEqual(['bytesToHex']);
  expect(adapter.pki.verifyCertificateChain).toBeUndefined();
  expect(adapter.pki.rsa).toBeUndefined();
  expect(Object.isFrozen(adapter)).toBe(true);
  expect(fixture.referencePackage).toBe('node-forge@1.4.0');
});

it.each(fixture.vectors)('matches unmodified forge raw RSA for $key / $inputHex', vector => {
  const pem = fixture.keys.find(key => key.name === vector.key)!.pem;
  const encrypted = adapter.pki.publicKeyFromPem(pem).encrypt(Buffer.from(vector.inputHex, 'hex').toString('latin1'), 'NONE');
  expect(adapter.util.bytesToHex(encrypted)).toBe(vector.encryptedHex);
});

it('requires review if the upstream crypto implementation changes', () => {
  const source = readFileSync(upstreamRequire.resolve('./util/crypto.js'), 'utf8');
  expect(createHash('sha256').update(source).digest('hex')).toBe(fixture.upstreamCryptoSha256);
  expect(source.match(/forge\./g)).toHaveLength(2);
});

it.each(fixture.weapi)('actual upstream weapi wire output matches forge for $input', vector => {
  let position = 0;
  vi.spyOn(Math, 'random').mockImplementation(() => fixture.randomValues[position++ % fixture.randomValues.length]);
  expect(upstreamRequire('./util/crypto.js').weapi(vector.input)).toEqual(vector.output);
});

it('rejects unsupported schemes, oversized representatives and non-byte input', () => {
  const pem = fixture.keys[0].pem, key = adapter.pki.publicKeyFromPem(pem);
  for (const scheme of [undefined, 'RSAES-PKCS1-V1_5', 'RSA-OAEP', 'RAW', 'none']) {
    expect(() => key.encrypt('secret', scheme)).toThrow(/Only.*NONE/);
  }
  expect(() => key.encrypt('x'.repeat(129), 'NONE')).toThrow(/modulus width/);
  const jwk = createPublicKey(pem).export({ format: 'jwk' });
  expect(() => key.encrypt(Buffer.from(jwk.n!, 'base64url').toString('latin1'), 'NONE')).toThrow();
  expect(() => key.encrypt('中文', 'NONE')).toThrow(/byte/);
  expect(() => adapter.util.bytesToHex(Buffer.from('x'))).toThrow(/binary string/);
  expect(() => adapter.util.bytesToHex('\u0100')).toThrow(/byte/);
  expect(adapter.util.bytesToHex('\x00\x80\xff')).toBe('0080ff');
});

it('rejects private, non-RSA, malformed and unsupported key material', () => {
  expect(() => adapter.pki.publicKeyFromPem('not a PEM')).toThrow();
  expect(() => adapter.pki.publicKeyFromPem(42)).toThrow();
  expect(() => adapter.pki.publicKeyFromPem('-----BEGIN PUBLIC KEY-----\ninvalid\n-----END PUBLIC KEY-----')).toThrow();
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  expect(() => adapter.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }))).toThrow(/Only RSA/);
  expect(() => adapter.pki.publicKeyFromPem(privateKey.export({ type: 'pkcs8', format: 'pem' }))).toThrow(/public-key PEM/);
});
