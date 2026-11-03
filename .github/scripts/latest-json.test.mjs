import assert from 'node:assert/strict';
import { test } from 'node:test';

import { latestJson } from './latest-json.mjs';

// Os nomes do release v0.7.0, mais os .sig que o build com o updater passa a enviar.
const PACKAGES = [
  'Dark.Triad_0.7.0_amd64.AppImage',
  'Dark.Triad_0.7.0_amd64.deb',
  'Dark.Triad-0.7.0-1.x86_64.rpm',
  'Dark.Triad_0.7.0_x64-setup.exe',
  'Dark.Triad_0.7.0_x64_en-US.msi',
  'Dark.Triad_aarch64.app.tar.gz',
  'Dark.Triad_x64.app.tar.gz',
];
const ASSETS = [
  ...PACKAGES,
  ...PACKAGES.map((name) => `${name}.sig`),
  'Dark.Triad_0.7.0_aarch64.dmg',
  'Dark.Triad_0.7.0_x64.dmg',
  'latest.json',
];
const SIGS = Object.fromEntries(PACKAGES.map((name) => [`${name}.sig`, `assinatura de ${name}`]));
const INPUT = {
  repo: 'dono/app',
  tag: 'v0.7.0',
  notes: 'Novidades:\n- algo',
  pubDate: '2026-11-02T23:19:31Z',
  assets: ASSETS,
  sigs: SIGS,
};

const entry = (name) => ({
  signature: `assinatura de ${name}`,
  url: `https://github.com/dono/app/releases/download/v0.7.0/${name}`,
});

test('monta as 7 entradas e as genéricas com a URL da tag', () => {
  assert.deepEqual(latestJson(INPUT), {
    version: '0.7.0',
    notes: 'Novidades:\n- algo',
    pub_date: '2026-11-02T23:19:31Z',
    platforms: {
      'linux-x86_64-appimage': entry('Dark.Triad_0.7.0_amd64.AppImage'),
      'linux-x86_64-deb': entry('Dark.Triad_0.7.0_amd64.deb'),
      'linux-x86_64-rpm': entry('Dark.Triad-0.7.0-1.x86_64.rpm'),
      'windows-x86_64-nsis': entry('Dark.Triad_0.7.0_x64-setup.exe'),
      'windows-x86_64-msi': entry('Dark.Triad_0.7.0_x64_en-US.msi'),
      'darwin-aarch64-app': entry('Dark.Triad_aarch64.app.tar.gz'),
      'darwin-x86_64-app': entry('Dark.Triad_x64.app.tar.gz'),
      'linux-x86_64': entry('Dark.Triad_0.7.0_amd64.AppImage'),
      'windows-x86_64': entry('Dark.Triad_0.7.0_x64_en-US.msi'),
      'darwin-aarch64': entry('Dark.Triad_aarch64.app.tar.gz'),
      'darwin-x86_64': entry('Dark.Triad_x64.app.tar.gz'),
    },
  });
});

test('recusa release sem um dos sistemas', () => {
  const assets = ASSETS.filter((name) => !name.startsWith('Dark.Triad_x64.app'));
  assert.throws(() => latestJson({ ...INPUT, assets }), /darwin-x86_64-app: 0 arquivos/);
});

test('recusa pacote sem .sig', () => {
  const { 'Dark.Triad-0.7.0-1.x86_64.rpm.sig': _, ...sigs } = SIGS;
  assert.throws(() => latestJson({ ...INPUT, sigs }), /linux-x86_64-rpm: falta Dark\.Triad-0\.7\.0-1\.x86_64\.rpm\.sig/);
});

test('recusa dois arquivos para a mesma entrada', () => {
  const assets = [...ASSETS, 'Dark.Triad_0.6.2_amd64.deb'];
  assert.throws(() => latestJson({ ...INPUT, assets }), /linux-x86_64-deb: 2 arquivos/);
});

test('recusa tag que não é vX.Y.Z', () => {
  assert.throws(() => latestJson({ ...INPUT, tag: 'untagged-123' }), /não é vX\.Y\.Z/);
});
