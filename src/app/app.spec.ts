import { TestBed } from '@angular/core/testing';
import { createFakes, Fakes, settle } from '../testing/fakes';
import { App } from './app';
import { Commands } from './shared/commands';

describe('App', () => {
  let fakes: Fakes;

  beforeAll(() => {
    // O jsdom não tem ResizeObserver; a árvore só o usa para medir a altura visível.
    globalThis.ResizeObserver ??= class {
      observe(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  });

  async function render(): Promise<HTMLElement> {
    TestBed.configureTestingModule({ providers: fakes.providers });
    const fixture = TestBed.createComponent(App);
    await settle();
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  beforeEach(() => {
    fakes = createFakes();
  });

  it('sem pasta, mostra a tela inicial com as recentes (a que sumiu, riscada)', async () => {
    fakes.workspace.recents = [
      { path: 'C:\\velha', exists: false },
      { path: 'C:\\proj', exists: true },
    ];

    const page = await render();

    expect(page.querySelector('.welcome-actions')?.textContent).toContain('Abrir pasta');
    const recents = [...page.querySelectorAll('.recent')];
    expect(recents.map((item) => item.querySelector('.recent-name')?.textContent)).toEqual([
      'velha',
      'proj',
    ]);
    expect(recents[0].classList).toContain('missing');
    expect(page.querySelector('.explorer-empty')?.textContent).toContain('Nenhuma pasta aberta');
  });

  it('reabre a última pasta e mostra a árvore na ordem do núcleo, sem itens escondidos', async () => {
    fakes.workspace.recents = [{ path: 'C:\\proj', exists: true }];
    fakes.explorer.add(
      'C:\\proj\\app\\',
      'C:\\proj\\core\\',
      'C:\\proj\\tool\\',
      'C:\\proj\\CMakeLists.txt',
    );

    const page = await render();

    expect(page.querySelector('.explorer-root')?.textContent).toBe('proj');
    const rows = [...page.querySelectorAll('[role=treeitem]')];
    expect(rows.map((row) => row.querySelector('.tree-name')?.textContent)).toEqual([
      'app',
      'core',
      'tool',
      'CMakeLists.txt',
    ]);
    expect(rows[0].getAttribute('aria-expanded')).toBe('false');
    expect(rows[3].getAttribute('aria-level')).toBe('1');
  });

  it('todo botão visível tem dica, com o atalho quando há', async () => {
    fakes.workspace.recents = [{ path: 'C:\\proj', exists: true }];
    fakes.explorer.add('C:\\proj\\main.cpp');

    const page = await render();

    const buttons = [...page.querySelectorAll('button')];
    expect(buttons.length).toBeGreaterThan(4);
    for (const button of buttons) expect(button.title, button.outerHTML).not.toBe('');
    expect(page.querySelector('.activity-button')?.getAttribute('title')).toBe(
      'Explorador (Ctrl+Shift+E)',
    );
  });

  it('Ctrl+Shift+P abre a paleta; Ctrl+K mostra o acorde na barra de status', async () => {
    const page = await render();
    const press = async (init: KeyboardEventInit) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { cancelable: true, ...init }));
      await settle();
      TestBed.tick();
    };

    await press({ key: 'K', code: 'KeyK', ctrlKey: true });
    expect(page.querySelector('.status-message')?.textContent).toBe(
      '(Ctrl+K) pressionado. Aguardando a segunda tecla…',
    );
    await press({ key: 'Escape', code: 'Escape' });
    expect(page.querySelector('.status-message')?.textContent).toBe(
      'A combinação não é um comando',
    );

    await press({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true });
    expect(page.querySelector('[role=dialog]')?.getAttribute('aria-label')).toBe(
      'Paleta de comandos',
    );
    expect(page.querySelector<HTMLInputElement>('.quick-input')?.value).toBe('>');
    expect(fakes.workspace.menus.length).toBeGreaterThan(0);
  });

  it('projeto CMake: barra de status, escolha da configuração pela paleta e fechar a pasta', async () => {
    fakes.workspace.recents = [{ path: 'C:\\proj', exists: true }];
    const page = await render();
    fakes.project.emitState({
      root: 'C:\\proj',
      kind: 'cmake',
      configs: ['Debug', 'Release'],
      config: 'Debug',
      status: { kind: 'ready' },
      targets: [{ name: 'app', path: 'C:\\proj\\build\\debug\\app.exe' }],
      target: 'app',
    });
    await settle();
    TestBed.tick();
    const status = () => page.querySelector('.status-project')!.textContent!.replace(/\s+/g, ' ');
    expect(status().trim()).toBe('CMake · Debug · ▶ app');
    for (const button of page.querySelectorAll<HTMLElement>('.status-bar button')) {
      expect(button.title, button.outerHTML).not.toBe('');
    }

    page.querySelector<HTMLElement>('[aria-label="Configuração: Debug"]')!.click();
    await settle();
    TestBed.tick();
    const options = [...page.querySelectorAll<HTMLElement>('[role=option]')];
    expect(options.map((option) => option.querySelector('.quick-label')!.textContent)).toEqual([
      'Debug',
      'Release',
    ]);
    options[1].click();
    expect(fakes.project.selectedConfigs).toEqual(['Release']);

    fakes.project.current = { ...fakes.project.current, root: null, kind: 'editOnly' };
    TestBed.inject(Commands).run('closeFolder');
    await settle();
    TestBed.tick();
    expect(status().trim()).toBe('');
  });

  it('bloqueia F5 e Ctrl+R, que recarregariam a página e perderiam o que não foi salvo', async () => {
    await render();

    for (const init of [
      { key: 'F5', code: 'F5' },
      { key: 'r', code: 'KeyR', ctrlKey: true },
      { key: 'R', code: 'KeyR', ctrlKey: true, shiftKey: true },
    ]) {
      const event = new KeyboardEvent('keydown', { ...init, cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented, init.key).toBe(true);
    }
  });
});
