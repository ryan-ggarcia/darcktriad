import { computed, inject, Injectable, signal } from '@angular/core';
import { FileService } from '../file.service';
import { Eol, errorKind, errorMessage, FileContent, Path, Session } from '../ipc';
import { basename, dirname, isWithin, languageOf, replacePrefix } from '../paths';
import { Dialogs } from '../shared/dialogs';
import { CurrentFolder } from '../workspace/current-folder';
import { Tab } from './tab';
import { TextBuffers } from './text-buffer';

type TextContent = Extract<FileContent, { kind: 'text' }>;

/** Estado das abas e os fluxos de abrir, salvar e fechar (docs/specs/editor.md). */
@Injectable({ providedIn: 'root' })
export class EditorTabs {
  private readonly files = inject(FileService);
  private readonly buffers = inject(TextBuffers);
  private readonly dialogs = inject(Dialogs);
  private readonly folder = inject(CurrentFolder);

  readonly tabs = signal<Tab[]>([]);
  readonly active = signal<Tab | null>(null);
  /** Linha e coluna do cursor, para a barra de status. */
  readonly cursor = signal<{ line: number; column: number } | null>(null);
  /** Lista do Ctrl+Tab: as abas por uso recente e a escolhida. */
  readonly switcher = signal<{ tabs: Tab[]; index: number } | null>(null);
  /** Muda quando o foco deve ir para o texto (aba clicada, Ctrl+N, Ctrl+Tab). */
  readonly focusRequests = signal(0);

  /** Nomes repetidos ganham a pasta pai: `main.cpp · app`. */
  readonly labels = computed(() => {
    const tabs = this.tabs();
    const counts = new Map<string, number>();
    for (const tab of tabs) counts.set(tab.name(), (counts.get(tab.name()) ?? 0) + 1);
    return new Map(
      tabs.map((tab) => {
        const path = tab.path();
        const repeated = path !== null && counts.get(tab.name())! > 1;
        return [tab, repeated ? `${tab.name()} · ${basename(dirname(path))}` : tab.name()];
      }),
    );
  });
  readonly dirtyTabs = computed(() => this.tabs().filter((tab) => tab.dirty()));
  /** O que vai para `save_session`; abas sem título não entram. */
  readonly session = computed<Session>(() => ({
    openFiles: this.tabs()
      .map((tab) => tab.path())
      .filter((path) => path !== null),
    activeFile: this.active()?.path() ?? null,
  }));

  /** Abas da mais para a menos usada; fechar uma ativa a anterior por uso. */
  private recent: Tab[] = [];
  private readonly opening = new Map<Path, Promise<Tab | null>>();
  private defaultEol?: Promise<Eol>;

  /** Abre o arquivo numa aba, ou ativa a aba que já o mostra. */
  async open(path: Path): Promise<Tab | null> {
    const tab = this.find(path) ?? (await this.loadOnce(path));
    if (tab) this.activate(tab);
    return tab;
  }

  /** Ctrl+N: "Sem título-N", com o fim de linha padrão do sistema. */
  async newUntitled(): Promise<Tab> {
    const eol = await (this.defaultEol ??= this.files.defaultEol());
    // shortcut: dois Ctrl+N antes de o Monaco carregar podem repetir o número; reservar nomes se incomodar.
    const used = new Set(this.tabs().map((tab) => tab.untitledName));
    let number = 1;
    while (used.has(`Sem título-${number}`)) number++;
    const empty: TextContent = {
      kind: 'text',
      content: '',
      eol,
      bom: false,
      readOnly: false,
      version: '',
    };
    const tab = await this.createTab(null, empty, `Sem título-${number}`);
    tab.version = null;
    this.add([tab]);
    this.activate(tab);
    this.requestFocus();
    return tab;
  }

  activate(tab: Tab): void {
    this.recent = [tab, ...this.recent.filter((item) => item !== tab)];
    this.active.set(tab);
  }

  requestFocus(): void {
    this.focusRequests.update((count) => count + 1);
  }

  /** Ctrl+PageDown / Ctrl+PageUp: a aba vizinha pela posição, dando a volta. */
  activateNext(offset: 1 | -1): void {
    const tabs = this.tabs();
    const active = this.active();
    if (active) this.activate(tabs[(tabs.indexOf(active) + offset + tabs.length) % tabs.length]);
  }

  /** Ctrl+Tab: abre a lista por uso recente, ou avança nela se já estiver aberta. */
  cycleRecent(offset: 1 | -1): void {
    const switcher = this.switcher();
    if (switcher) {
      const count = switcher.tabs.length;
      this.switcher.set({ ...switcher, index: (switcher.index + offset + count) % count });
    } else if (this.recent.length > 1) {
      this.switcher.set({ tabs: [...this.recent], index: offset > 0 ? 1 : this.recent.length - 1 });
    }
  }

  /** Soltar o Ctrl (ou clicar num item) ativa a aba escolhida. */
  commitSwitcher(index?: number): void {
    const switcher = this.switcher();
    this.switcher.set(null);
    const tab = switcher?.tabs[index ?? switcher.index];
    if (tab && this.tabs().includes(tab)) {
      this.activate(tab);
      this.requestFocus();
    }
  }

  cancelSwitcher(): void {
    this.switcher.set(null);
  }

  /** Fecha a aba; com alterações, pergunta antes. `false` se o usuário cancelou. */
  async close(tab: Tab): Promise<boolean> {
    if (!(await this.confirmDiscard([tab]))) return false;
    this.remove(tab);
    return true;
  }

  async closeAll(): Promise<boolean> {
    if (!(await this.confirmDiscard())) return false;
    this.clear();
    return true;
  }

  /**
   * Uma única pergunta sobre as abas modificadas de `tabs`, salvando se o usuário pedir.
   * `true` quando dá para seguir: nada modificado, tudo salvo ou "Não salvar".
   */
  async confirmDiscard(tabs = this.tabs()): Promise<boolean> {
    const dirty = tabs.filter((tab) => tab.dirty());
    if (!dirty.length) return true;
    const single = dirty.length === 1;
    const saveLabel = single ? 'Salvar' : 'Salvar tudo';
    const warning = 'Suas alterações serão perdidas se você não as salvar.';
    const choice = await this.dialogs.ask(
      single
        ? `Deseja salvar as alterações feitas em ${dirty[0].name()}?`
        : `Deseja salvar as alterações nos ${dirty.length} arquivos a seguir?`,
      [saveLabel, 'Não salvar', 'Cancelar'],
      single ? warning : `${dirty.map((tab) => this.labels().get(tab)).join('\n')}\n\n${warning}`,
    );
    if (choice === 'Não salvar') return true;
    return choice === saveLabel && this.saveTabs(dirty);
  }

  /** Fecha tudo sem perguntar; use depois de `confirmDiscard`. */
  clear(): void {
    for (const tab of this.tabs()) tab.buffer?.dispose();
    this.tabs.set([]);
    this.recent = [];
    this.active.set(null);
    this.switcher.set(null);
    this.cursor.set(null);
  }

  /** Ctrl+S. Arquivo sem título abre "Salvar como". `false` se nada foi gravado. */
  async save(tab: Tab): Promise<boolean> {
    const path = tab.path();
    if (tab.view.kind !== 'text') return true;
    if (!path) return this.saveAs(tab);
    if (!tab.dirty() && !tab.deleted()) return true;
    return this.write(tab, path, false);
  }

  async saveAs(tab: Tab): Promise<boolean> {
    if (tab.view.kind !== 'text') return false;
    const path = tab.path();
    const target = await this.files.pickSavePath(
      path ? dirname(path) : this.folder.path(),
      tab.name(),
    );
    // shortcut: salvar por cima de um arquivo aberto em outra aba deixa as duas no mesmo caminho; fechar a outra fica para depois.
    return target !== null && this.write(tab, target, true);
  }

  saveAll(): Promise<boolean> {
    return this.saveTabs(this.dirtyTabs());
  }

  /** Depois de renomear no explorador: as abas do item, ou de dentro da pasta, seguem o novo caminho. */
  renamePath(from: Path, to: Path): void {
    for (const tab of this.tabs()) {
      const path = tab.path();
      const renamed = path === null ? null : replacePrefix(path, from, to);
      if (renamed === null) continue;
      tab.path.set(renamed);
      tab.buffer?.setLanguage(languageOf(renamed));
    }
  }

  /** Confere com o disco as abas em `paths` (ou todas, com `null`), como pede o `fs-changed`. */
  async checkDisk(paths: Path[] | null): Promise<void> {
    const tabs = this.tabs().filter((tab) => {
      const path = tab.path();
      return path !== null && (paths === null || paths.some((changed) => isWithin(path, changed)));
    });
    await Promise.all(tabs.map((tab) => this.sync(tab)));
  }

  /** Faixa "Este arquivo mudou no disco" → Recarregar do disco: descarta as alterações. */
  async reload(tab: Tab): Promise<void> {
    const path = tab.path();
    if (!path || !tab.buffer) return;
    try {
      const content = await this.files.read(path);
      if (content.kind === 'text') this.applyDisk(tab, content);
    } catch (error) {
      void this.dialogs.tell(`Não foi possível recarregar ${basename(path)}.`, errorMessage(error));
    }
  }

  /** Manter minha versão: a `version` antiga faz o próximo salvamento perguntar se sobrescreve. */
  keepMine(tab: Tab): void {
    tab.changedOnDisk.set(false);
  }

  /** Reabre as abas da sessão na ordem, pulando o que não abre mais, e ativa a que estava ativa. */
  async restore(session: Session): Promise<void> {
    const tabs = await Promise.all(
      session.openFiles.map((path) =>
        this.files
          .read(path)
          .then((content) => this.createTab(path, content))
          .catch(() => null),
      ),
    );
    const restored = tabs.filter((tab) => tab !== null);
    this.add(restored);
    const active = restored.find((tab) => tab.path() === session.activeFile) ?? restored[0];
    if (active) this.activate(active);
  }

  private find(path: Path): Tab | null {
    return this.tabs().find((tab) => tab.path() === path) ?? null;
  }

  /** Dois cliques seguidos no mesmo arquivo leem o disco uma vez só e dão uma aba só. */
  private loadOnce(path: Path): Promise<Tab | null> {
    let pending = this.opening.get(path);
    if (!pending) {
      pending = this.load(path).finally(() => this.opening.delete(path));
      this.opening.set(path, pending);
    }
    return pending;
  }

  private async load(path: Path): Promise<Tab | null> {
    try {
      const tab = await this.createTab(path, await this.files.read(path));
      this.add([tab]);
      return tab;
    } catch (error) {
      void this.dialogs.tell(`Não foi possível abrir ${basename(path)}.`, errorMessage(error));
      return null;
    }
  }

  private async createTab(
    path: Path | null,
    content: FileContent,
    untitledName = '',
  ): Promise<Tab> {
    if (content.kind !== 'text') return new Tab(path, untitledName, content, 'lf');
    let tab: Tab | undefined;
    const buffer = await this.buffers.create(content.content, content.eol, languageOf(path), () =>
      tab?.refreshDirty(),
    );
    tab = new Tab(
      path,
      untitledName,
      { kind: 'text', buffer, readOnly: content.readOnly },
      content.eol,
    );
    tab.version = content.version;
    tab.bom = content.bom;
    tab.savedVersionId = buffer.versionId();
    return tab;
  }

  private add(tabs: Tab[]): void {
    this.tabs.update((open) => [...open, ...tabs]);
    this.recent.push(...tabs);
  }

  private remove(tab: Tab): void {
    tab.buffer?.dispose();
    this.tabs.update((tabs) => tabs.filter((item) => item !== tab));
    this.recent = this.recent.filter((item) => item !== tab);
    if (this.active() === tab) this.active.set(this.recent[0] ?? null);
  }

  private async saveTabs(tabs: Tab[]): Promise<boolean> {
    let saved = true;
    for (const tab of tabs) saved = (await this.save(tab)) && saved;
    return saved;
  }

  /** Grava na fila da aba; `overwrite` ignora a versão do disco (Salvar como, Sobrescrever). */
  private write(tab: Tab, path: Path, overwrite: boolean): Promise<boolean> {
    const result = tab.saving.then(() => this.writeNow(tab, path, overwrite));
    tab.saving = result.catch(() => false);
    return result;
  }

  private async writeNow(tab: Tab, path: Path, overwrite: boolean): Promise<boolean> {
    const buffer = tab.buffer!;
    // Lido antes de gravar: o que for digitado durante a gravação continua como alteração.
    const versionId = buffer.versionId();
    try {
      const expected = overwrite ? null : tab.version;
      tab.version = await this.files.save(path, buffer.getText(), tab.eol(), tab.bom, expected);
    } catch (error) {
      if (errorKind(error) === 'conflict') return this.resolveConflict(tab, path);
      void this.dialogs.tell(`Não foi possível salvar ${basename(path)}.`, errorMessage(error));
      return false;
    }
    tab.savedVersionId = versionId;
    tab.refreshDirty();
    tab.deleted.set(false);
    tab.changedOnDisk.set(false);
    if (tab.path() !== path) {
      tab.path.set(path);
      buffer.setLanguage(languageOf(path));
    }
    return true;
  }

  private async resolveConflict(tab: Tab, path: Path): Promise<boolean> {
    const choice = await this.dialogs.ask(
      `${basename(path)} mudou no disco depois da última leitura.`,
      ['Sobrescrever', 'Cancelar'],
      'Sobrescrever grava a sua versão por cima da que está no disco.',
    );
    return choice === 'Sobrescrever' && this.writeNow(tab, path, true);
  }

  private async sync(tab: Tab): Promise<void> {
    // O eco da nossa própria gravação chega com a versão nova: espere ela terminar.
    await tab.saving;
    const path = tab.path()!;
    let content: FileContent;
    try {
      content = await this.files.read(path);
    } catch (error) {
      if (errorKind(error) === 'notFound' && tab.path() === path) tab.deleted.set(true);
      return;
    }
    if (tab.path() !== path) return;
    tab.deleted.set(false);
    // shortcut: uma aba que muda de tipo no disco (texto ↔ binário) só se refaz ao reabrir.
    if (content.kind !== 'text' || !tab.buffer || content.version === tab.version) return;
    if (tab.dirty()) tab.changedOnDisk.set(true);
    else this.applyDisk(tab, content);
  }

  private applyDisk(tab: Tab, content: TextContent): void {
    const buffer = tab.buffer!;
    buffer.setText(content.content);
    buffer.setEol(content.eol);
    tab.eol.set(content.eol);
    tab.bom = content.bom;
    tab.version = content.version;
    tab.savedVersionId = buffer.versionId();
    tab.refreshDirty();
    tab.changedOnDisk.set(false);
  }
}
