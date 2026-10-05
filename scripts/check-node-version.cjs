const supported = version => {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  return (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major >= 24;
};
module.exports = { supported };
if (require.main === module && !supported(process.versions.node)) {
  console.error('Node 20.19+, 22.12+ or >=24 is required (see package.json engines).');
  process.exitCode = 1;
}
