import { TestBed } from '@angular/core/testing';
import { createFakes, Fakes, settle } from '../testing/fakes';
import { App } from './app';

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
