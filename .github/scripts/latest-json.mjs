// Gera o latest.json do updater a partir dos arquivos de um release e o envia para ele.
// Uso: GH_REPO=dono/repo node .github/scripts/latest-json.mjs vX.Y.Z
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// shortcut: Linux e Windows só em x86_64; se entrar outra arquitetura, ela precisa de linhas aqui.
const ENTRIES = {
  'linux-x86_64-appimage': /\.AppImage$/,
  'linux-x86_64-deb': /\.deb$/,
  'linux-x86_64-rpm': /\.rpm$/,
  'windows-x86_64-nsis': /-setup\.exe$/,
  'windows-x86_64-msi': /\.msi$/,
  'darwin-aarch64-app': /_aarch64\.app\.tar\.gz$/,
  'darwin-x86_64-app': /_x64\.app\.tar\.gz$/,
};
// O plugin cai em `{os}-{arch}` quando não sabe o tipo do pacote. Mesma escolha do tauri-action
// (AppImage no Linux; .msi antes do .exe no Windows, pois `updaterJsonPreferNsis` é falso).
const GENERIC = {
  'linux-x86_64': 'linux-x86_64-appimage',
  'windows-x86_64': 'windows-x86_64-msi',
  'darwin-aarch64': 'darwin-aarch64-app',
  'darwin-x86_64': 'darwin-x86_64-app',
};

/** Monta o latest.json. `sigs` mapeia o nome de cada `.sig` para o conteúdo dele. */
export function latestJson({ repo, tag, notes, pubDate, assets, sigs }) {
  const version = /^v(\d+\.\d+\.\d+\S*)$/.exec(tag)?.[1];
  if (!version) throw new Error(`tag ${tag} não é vX.Y.Z`);
  const problems = [];
  const platforms = {};
  for (const [key, pattern] of Object.entries(ENTRIES)) {
    const found = assets.filter((name) => pattern.test(name));
    if (found.length !== 1) {
      problems.push(`${key}: ${found.length} arquivos (${found.join(', ') || 'nenhum'})`);
      continue;
    }
    const signature = sigs[`${found[0]}.sig`];
    if (!signature) {
      problems.push(`${key}: falta ${found[0]}.sig`);
      continue;
    }
    // A URL da tag: a `untagged-` do rascunho para de funcionar quando ele é publicado.
    const url = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(found[0])}`;
    platforms[key] = { signature, url };
  }
  if (problems.length) {
    throw new Error(`latest.json não gerado, o release ${tag} está incompleto:\n  ${problems.join('\n  ')}`);
  }
  for (const [key, from] of Object.entries(GENERIC)) platforms[key] = platforms[from];
  return { version, notes, pub_date: pubDate, platforms };
}

function gh(...args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function main(tag) {
  const repo = process.env.GH_REPO;
  if (!tag || !repo) throw new Error('uso: GH_REPO=dono/repo node latest-json.mjs vX.Y.Z');
  const release = JSON.parse(gh('release', 'view', tag, '--json', 'body,publishedAt,assets'));
  const dir = mkdtempSync(join(tmpdir(), 'latest-json-'));
  try {
    gh('release', 'download', tag, '--pattern', '*.sig', '--dir', dir);
    const sigs = Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), 'utf8')]));
    const json = latestJson({
      repo,
      tag,
      notes: release.body,
      // Rascunho ainda não tem data: usa a de agora, como o tauri-action.
      pubDate: release.publishedAt || new Date().toISOString(),
      assets: release.assets.map((asset) => asset.name),
      sigs,
    });
    const file = join(dir, 'latest.json');
    writeFileSync(file, JSON.stringify(json, null, 2));
    gh('release', 'upload', tag, file, '--clobber');
    console.log(`latest.json enviado para ${tag}: ${Object.keys(json.platforms).join(', ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv[2]);
  } catch (error) {
    console.error(`::error::${error.message.replaceAll('\n', '%0A')}`);
    process.exit(1);
  }
}
