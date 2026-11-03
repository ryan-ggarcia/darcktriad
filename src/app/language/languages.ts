import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { EditorTabs } from '../editor/editor-tabs';
import { Tab } from '../editor/tab';
import { errorMessage, Language, LanguageEvent, Path, ServerState } from '../ipc';
import { LanguageService } from '../language.service';
import { basename, isWithin, relativeTo } from '../paths';
import { withLine } from '../project/project';
import { Problems } from '../project/problems';
import { Commands } from '../shared/commands';
import { readSetting, writeSetting } from '../shared/settings';
import { CurrentFolder } from '../workspace/current-folder';
import { LspClient, LspDocument } from './lsp-client';
import { Location, LocationLink, pathToUri, Range, toLocations, toMarker, uriToPath } from './lsp';
import type { Pick } from '../quick-open/quick-open';

export const LANGUAGES: Language[] = ['cpp', 'csharp'];

/** Nome na barra de status, canal da Saída e origem dos erros de cada servidor. */
export const SERVER_NAMES: Record<Language, { label: string; channel: string; source: string }> = {
  cpp: { label: 'C++', channel: 'clangd', source: 'clangd' },
  csharp: { label: 'C#', channel: 'C#', source: 'C#' },
};

/** O servidor de cada linguagem do Monaco. */
const SERVER_OF: Record<string, Language> = { c: 'cpp', cpp: 'cpp', csharp: 'csharp' };

/** O estado do núcleo, mais `missing` (ferramenta ausente no `language_start`). */
export type ServerStatus = ServerState | { kind: 'missing'; reason: string };

/** Um servidor de linguagem da pasta: estado, log e o cliente do processo atual. */
export class Server {
  /** Nulo enquanto nenhum arquivo da linguagem foi aberto na pasta. */
  readonly status = signal<ServerStatus | null>(null);
  readonly client = signal<LspClient | null>(null);
  readonly log = signal<string[]>([]);

  append(line: string): void {
    this.log.update((lines) => withLine(lines, line));
  }
}

const FORMAT_ON_SAVE_KEY = 'formatOnSave';
/** Quanto a gravação espera o formatador: um servidor lento ou travado não segura o Ctrl+S. */
export const FORMAT_ON_SAVE_TIMEOUT_MS = 3000;

interface OpenDocument extends LspDocument {
  language: Language;
  stopEdits(): void;
}

/**
 * Os servidores de linguagem (docs/specs/linguagem.md): inicia ao abrir o primeiro arquivo da
 * linguagem, sincroniza as abas, leva os erros ao painel Problemas e atende o F12.
 */
@Injectable({ providedIn: 'root' })
export class Languages {
  private readonly service = inject(LanguageService);
  private readonly tabs = inject(EditorTabs);
  private readonly folder = inject(CurrentFolder);
  private readonly problems = inject(Problems);
  private readonly commands = inject(Commands);

  readonly servers: Record<Language, Server> = { cpp: new Server(), csharp: new Server() };
  /** Os canais da Saída dos servidores já iniciados. */
  readonly channels = computed(() =>
    LANGUAGES.filter((language) => this.servers[language].status()).map(
      (language) => SERVER_NAMES[language].channel,
    ),
  );
  /** Desligado por padrão, como no VS Code: reformatar muda linhas que a pessoa não tocou. */
  readonly formatOnSave = signal(readSetting(FORMAT_ON_SAVE_KEY) === 'true');
  private readonly documents = new Map<Tab, OpenDocument>();
  private folderPath: Path | null = null;

  constructor() {
    effect(() => {
      const folder = this.folder.path();
      const tabs = this.tabs.tabs();
      // Lidos aqui para renomear (outro caminho) fechar e reabrir o arquivo no servidor.
      for (const tab of tabs) tab.path();
      untracked(() => this.sync(folder, tabs));
    });
    this.tabs.onBeforeSave((tab) => this.formatBeforeSave(tab));
    this.tabs.onSaved((tab) => {
      const document = this.documents.get(tab);
      if (document) this.client(document.language)?.save(document.uri);
    });
  }

  toggleFormatOnSave(): void {
    this.formatOnSave.update((on) => !on);
    writeSetting(FORMAT_ON_SAVE_KEY, String(this.formatOnSave()));
  }

  private async formatBeforeSave(tab: Tab): Promise<void> {
    const view = tab.view;
    if (!this.formatOnSave() || tab.outsideProject() || view.kind !== 'text' || view.readOnly) {
      return;
    }
    const document = this.documents.get(tab);
    const client = document && this.client(document.language);
    if (!document || !client?.capabilities.documentFormattingProvider) return;
    const { buffer } = view;
    const version = buffer.versionId();
    const abort = new AbortController();
    const timer = setTimeout(() => {
      abort.abort();
      this.commands.flash('O formatador demorou: arquivo salvo sem formatar');
    }, FORMAT_ON_SAVE_TIMEOUT_MS);
    const edits = await client.request<{ range: Range; newText: string }[]>(
      'textDocument/formatting',
      { textDocument: { uri: document.uri }, options: buffer.formatOptions() },
      abort.signal,
    );
    clearTimeout(timer);
    // O texto mudou ou a aba fechou durante a espera: as posições não valem mais.
    if (edits?.length && buffer.versionId() === version && this.tabs.tabs().includes(tab)) {
      buffer.applyEdits(edits.map(({ range, newText }) => ({ range, text: newText })));
    }
  }

  /** O cliente pronto da linguagem, para os provedores do Monaco. */
  client(language: Language): LspClient | null {
    const client = this.servers[language].client();
    return client?.ready() ? client : null;
  }

  /** O arquivo da aba no servidor: a linguagem e a URI. */
  documentOf(tab: Tab): { language: Language; uri: string } | null {
    return this.documents.get(tab) ?? null;
  }

  /** "Reiniciar" na barra e na paleta. Ferramenta ausente: procura de novo, iniciando. */
  restart(language: Language): void {
    const server = this.servers[language];
    if (server.status()?.kind === 'missing' || !server.status()) {
      void this.start(language);
      return;
    }
    this.service
      .restart(language)
      .catch((error) => server.append(`Não foi possível reiniciar: ${errorMessage(error)}`));
  }

  /** F12 / Ctrl+clique: um resultado abre; vários viram lista; nenhum avisa na barra de status. */
  async goToDefinition(pick: (pick: Pick) => void): Promise<void> {
    const tab = this.tabs.active();
    const cursor = this.tabs.cursor();
    const document = tab && this.documents.get(tab);
    const client = document && this.client(document.language);
    if (!tab?.buffer || !cursor || !document || !client) {
      this.commands.flash('Definição não disponível');
      return;
    }
    const version = tab.buffer.versionId();
    const result = await client.request<Location | Location[] | LocationLink[]>(
      'textDocument/definition',
      {
        textDocument: { uri: document.uri },
        position: { line: cursor.line - 1, character: cursor.column - 1 },
      },
    );
    // O cursor mudou de lugar ou o texto mudou: a resposta ficou velha.
    if (this.tabs.active() !== tab || this.tabs.cursor() !== cursor) return;
    if (tab.buffer?.versionId() !== version) return;
    const locations = toLocations(result);
    if (!locations.length) {
      this.commands.flash('Definição não disponível');
    } else if (locations.length === 1) {
      void this.openDefinition(locations[0]);
    } else {
      const root = this.folder.path();
      const labels = locations.map(({ path, line, column }) => {
        const shown = root && isWithin(path, root) ? relativeTo(path, root) : path;
        return `${shown}:${line}:${column}`;
      });
      pick({
        title: `Ir para definição: ${locations.length} resultados`,
        options: labels,
        current: null,
        empty: 'Definição não disponível',
        accept: (label) => void this.openDefinition(locations[labels.indexOf(label)]),
      });
    }
  }

  private async openDefinition(location: { path: Path; line: number; column: number }) {
    const existed = this.tabs.tabs().some((tab) => tab.path() === location.path);
    const tab = await this.tabs.openAt(location.path, location);
    const root = this.folder.path();
    if (tab && !existed && !(root && isWithin(location.path, root))) tab.outsideProject.set(true);
  }

  /** O cliente do processo atual, pronto ou não (ele guarda os arquivos até o `initialize`). */
  private connected(language: Language): LspClient | null {
    return this.servers[language].client();
  }

  /** Abas ↔ arquivos abertos nos servidores; pasta nova esquece os servidores da anterior. */
  private sync(folder: Path | null, tabs: Tab[]): void {
    if (folder !== this.folderPath) {
      this.folderPath = folder;
      // O núcleo já parou os servidores da pasta anterior.
      for (const document of this.documents.values()) document.stopEdits();
      this.documents.clear();
      for (const language of LANGUAGES) this.forget(language);
    }
    for (const [tab, document] of this.documents) {
      const path = tab.path();
      if (tabs.includes(tab) && path && pathToUri(path) === document.uri) continue;
      document.stopEdits();
      this.documents.delete(tab);
      this.connected(document.language)?.close(document.uri);
    }
    if (!folder) return;
    for (const tab of tabs) {
      const path = tab.path();
      const language = SERVER_OF[tab.language()];
      if (!path || !language || !tab.buffer || this.documents.has(tab)) continue;
      this.openDocument(tab, path, language);
    }
  }

  private openDocument(tab: Tab, path: Path, language: Language): void {
    const buffer = tab.buffer!;
    const uri = pathToUri(path);
    const document: OpenDocument = {
      uri,
      language,
      languageId: tab.language(),
      version: 1,
      getText: () => buffer.getText(),
      stopEdits: buffer.onEdit((changes) => this.connected(language)?.change(uri, changes)),
    };
    this.documents.set(tab, document);
    if (!this.servers[language].status()) void this.start(language);
    this.connected(language)?.open(document);
  }

  private async start(language: Language): Promise<void> {
    const server = this.servers[language];
    server.status.set({ kind: 'starting' });
    try {
      await this.service.start(language, (event) => this.onEvent(language, event));
    } catch (error) {
      const reason = errorMessage(error);
      server.status.set({ kind: 'missing', reason });
      server.append(reason);
    }
  }

  private onEvent(language: Language, event: LanguageEvent): void {
    const server = this.servers[language];
    if (event.kind === 'message') server.client()?.receive(event.message);
    else if (event.kind === 'log') server.append(event.line);
    else {
      server.status.set(event.state);
      this.dropClient(language);
      if (event.state.kind === 'running') this.connect(language);
    }
  }

  /** Processo novo: cliente novo, `initialize` e os arquivos da linguagem reabertos. */
  private connect(language: Language): void {
    const server = this.servers[language];
    const { source } = SERVER_NAMES[language];
    const client = new LspClient(
      (message) =>
        void this.service.send(language, message).catch((error) => {
          console.warn(`${source}:`, errorMessage(error));
        }),
      {
        diagnostics: (kind, uri, diagnostics) => {
          const path = uriToPath(uri);
          if (!path) return;
          const items = diagnostics.map((item) => ({ file: path, ...toMarker(item, source) }));
          this.problems.set(kind ? `${language}:${kind}` : language, items, path);
        },
        log: (line) => server.append(line),
      },
    );
    server.client.set(client);
    for (const document of this.documents.values()) {
      if (document.language === language) client.open(document);
    }
    const root = this.folder.path();
    void client.initialize(root && pathToUri(root), root ? basename(root) : '');
  }

  private dropClient(language: Language): void {
    this.servers[language].client()?.dispose();
    this.servers[language].client.set(null);
    this.problems.clear((source) => source === language || source.startsWith(`${language}:`));
  }

  private forget(language: Language): void {
    this.dropClient(language);
    this.servers[language].status.set(null);
  }
}
